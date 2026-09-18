/**
 * Word markup to the editor's document model.
 *
 * This replaces a conversion that went through HTML. HTML could not carry what
 * a Word file holds: the size a picture is shown at, the font and colour of a
 * run, the shading of a table cell, a page break, the orientation of the page.
 * All of that arrived and was thrown away before anything could store it.
 *
 * What is read here is what the exporter writes back, so the round trip is
 * between two descriptions of the same document rather than between a document
 * and a rendering of it.
 */
import { MARK, NODE, type PMMark, type PMNode } from '@docforge/model';
import {
  attrOf,
  child,
  childrenNamed,
  descendants,
  isElement,
  textOf,
  type XmlElement,
} from './xml.js';
import type { WordPackage } from './package.js';

/** English Metric Units per pixel at 96 dpi, which is how OOXML states sizes. */
const EMU_PER_PIXEL = 9525;
/** Twentieths of a point per pixel, for widths stated in dxa. */
const DXA_PER_PIXEL = 15;

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 100;

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

const HIGHLIGHTS: Record<string, string> = {
  yellow: '#ffff00',
  green: '#00ff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  blue: '#0000ff',
  red: '#ff0000',
  darkYellow: '#808000',
  lightGray: '#d3d3d3',
};

export interface ConversionResult {
  content: PMNode;
  messages: string[];
  /** What sits outside the body: headers, footers and the page setup. */
  meta: DocumentMeta;
}

export interface DocumentMeta {
  header: string;
  footer: string;
  orientation: 'portrait' | 'landscape';
}

interface State {
  pkg: WordPackage;
  styleNames: Map<string, string>;
  numberingFormats: Map<string, string>;
  images: number;
  imageBytes: number;
  messages: Set<string>;
}

export function documentFromPackage(pkg: WordPackage): ConversionResult {
  const state: State = {
    pkg,
    styleNames: readStyleNames(pkg),
    numberingFormats: readNumbering(pkg),
    images: 0,
    imageBytes: 0,
    messages: new Set(),
  };

  const body = child(pkg.document, 'w:body');
  const blocks = body ? blocksOf(body, state) : [];

  return {
    content: {
      type: NODE.doc,
      content: blocks.length > 0 ? blocks : [{ type: NODE.paragraph }],
    },
    messages: [...state.messages],
    meta: {
      header: firstText(pkg.headers),
      footer: firstText(pkg.footers),
      orientation:
        attrOf(body, ['w:sectPr', 'w:pgSz'], 'w:orient') === 'landscape' ? 'landscape' : 'portrait',
    },
  };
}

const firstText = (parts: XmlElement[]): string => {
  for (const part of parts) {
    const text = textOf(part).replace(/\s+/gu, ' ').trim();
    if (text.length > 0) return text.slice(0, 300);
  }
  return '';
};

function readStyleNames(pkg: WordPackage): Map<string, string> {
  const names = new Map<string, string>();
  if (!pkg.styles) return names;
  for (const style of childrenNamed(pkg.styles, 'w:style')) {
    const id = style.attrs['w:styleId'];
    const name = attrOf(style, ['w:name'], 'w:val');
    if (id && name) names.set(id, name.toLowerCase());
  }
  return names;
}

/** Numbering id and level to the format Word will draw, such as "bullet". */
function readNumbering(pkg: WordPackage): Map<string, string> {
  const formats = new Map<string, string>();
  if (!pkg.numbering) return formats;

  const abstract = new Map<string, Map<string, string>>();
  for (const element of childrenNamed(pkg.numbering, 'w:abstractNum')) {
    const id = element.attrs['w:abstractNumId'];
    if (!id) continue;
    const levels = new Map<string, string>();
    for (const level of childrenNamed(element, 'w:lvl')) {
      const index = level.attrs['w:ilvl'] ?? '0';
      levels.set(index, attrOf(level, ['w:numFmt'], 'w:val') ?? 'decimal');
    }
    abstract.set(id, levels);
  }

  for (const num of childrenNamed(pkg.numbering, 'w:num')) {
    const numId = num.attrs['w:numId'];
    const abstractId = attrOf(num, ['w:abstractNumId'], 'w:val');
    if (!numId || !abstractId) continue;
    const levels = abstract.get(abstractId);
    if (!levels) continue;
    for (const [level, format] of levels) formats.set(`${numId}:${level}`, format);
  }
  return formats;
}

interface ListInfo {
  numId: string;
  level: number;
  ordered: boolean;
}

function listInfoOf(paragraph: XmlElement, state: State): ListInfo | null {
  const numbering = child(paragraph, 'w:pPr', 'w:numPr');
  if (!numbering) return null;
  const numId = attrOf(numbering, ['w:numId'], 'w:val');
  if (!numId || numId === '0') return null;
  const level = Number(attrOf(numbering, ['w:ilvl'], 'w:val') ?? '0');
  const format = state.numberingFormats.get(`${numId}:${level}`) ?? 'bullet';
  return { numId, level: Number.isFinite(level) ? level : 0, ordered: format !== 'bullet' };
}

/** The blocks of a body, a table cell or anything else holding paragraphs. */
function blocksOf(container: XmlElement, state: State): PMNode[] {
  const blocks: PMNode[] = [];
  const children = container.children.filter(isElement);

  for (let index = 0; index < children.length; index += 1) {
    const element = children[index] as XmlElement;

    if (element.name === 'w:tbl') {
      const table = tableFrom(element, state);
      if (table) blocks.push(table);
      continue;
    }
    if (element.name !== 'w:p') continue;

    const list = listInfoOf(element, state);
    if (list) {
      // Gather every paragraph belonging to this list, including its nested
      // levels, and build the list in one go.
      const run: { paragraph: XmlElement; info: ListInfo }[] = [];
      let cursor = index;
      while (cursor < children.length) {
        const candidate = children[cursor] as XmlElement;
        if (candidate.name !== 'w:p') break;
        const info = listInfoOf(candidate, state);
        if (!info || info.numId !== list.numId) break;
        run.push({ paragraph: candidate, info });
        cursor += 1;
      }
      blocks.push(...listFrom(run, state));
      index = cursor - 1;
      continue;
    }

    blocks.push(...paragraphFrom(element, state));
  }

  return blocks;
}

/** Build nested lists from a run of numbered paragraphs. */
function listFrom(
  run: { paragraph: XmlElement; info: ListInfo }[],
  state: State,
  depth = 0,
): PMNode[] {
  if (run.length === 0 || depth > 10) return [];
  const baseLevel = Math.min(...run.map((entry) => entry.info.level));
  const ordered = run[0]?.info.ordered ?? false;
  const items: PMNode[] = [];

  for (let index = 0; index < run.length; index += 1) {
    const entry = run[index] as { paragraph: XmlElement; info: ListInfo };
    if (entry.info.level !== baseLevel) continue;

    const content = paragraphFrom(entry.paragraph, state);
    // Everything deeper than this item, up to the next item at this level,
    // belongs inside it.
    const nested: { paragraph: XmlElement; info: ListInfo }[] = [];
    let cursor = index + 1;
    while (cursor < run.length && (run[cursor] as { info: ListInfo }).info.level > baseLevel) {
      nested.push(run[cursor] as { paragraph: XmlElement; info: ListInfo });
      cursor += 1;
    }
    if (nested.length > 0) content.push(...listFrom(nested, state, depth + 1));

    items.push({
      type: NODE.listItem,
      content: content.length > 0 ? content : [{ type: NODE.paragraph }],
    });
    index = cursor - 1;
  }

  if (items.length === 0) return [];
  return [{ type: ordered ? NODE.orderedList : NODE.bulletList, content: items }];
}

const ALIGNMENTS: Record<string, string> = {
  left: 'left',
  start: 'left',
  center: 'center',
  centre: 'center',
  right: 'right',
  end: 'right',
  both: 'justify',
  justify: 'justify',
  distribute: 'justify',
};

const HEADING_ID = /^heading\s*([1-6])$/u;

function headingLevelOf(paragraph: XmlElement, state: State): number | null {
  const styleId = attrOf(paragraph, ['w:pPr', 'w:pStyle'], 'w:val');
  if (!styleId) return null;
  const name = state.styleNames.get(styleId) ?? styleId.toLowerCase();
  const match = HEADING_ID.exec(name.replace(/heading(\d)/u, 'heading $1'));
  if (match) return Number(match[1]);
  const outline = Number(attrOf(paragraph, ['w:pPr', 'w:outlineLvl'], 'w:val') ?? NaN);
  return Number.isInteger(outline) && outline >= 0 && outline <= 5 ? outline + 1 : null;
}

const isQuoteStyle = (styleId: string | undefined, state: State): boolean => {
  if (!styleId) return false;
  const name = state.styleNames.get(styleId) ?? styleId;
  return /quote/iu.test(name);
};

/**
 * One Word paragraph, which can become more than one block: a page break is a
 * block of its own here, and a paragraph holding only a bottom border is a rule.
 */
function paragraphFrom(paragraph: XmlElement, state: State): PMNode[] {
  const properties = child(paragraph, 'w:pPr');
  const blocks: PMNode[] = [];

  if (child(properties, 'w:pageBreakBefore')) blocks.push({ type: NODE.pageBreak });

  const inline = inlineOf(paragraph, state, []);
  const hasText = inline.some(
    (node) => node.type !== NODE.text || (node.text ?? '').trim().length > 0,
  );

  // A paragraph with nothing in it but a bottom border is how Word writes the
  // rule people insert from the ribbon.
  const bottomBorder = child(properties, 'w:pBdr', 'w:bottom');
  if (!hasText && bottomBorder && bottomBorder.attrs['w:val'] !== 'none') {
    blocks.push({ type: NODE.horizontalRule });
    return blocks;
  }

  const attrs: Record<string, unknown> = {};
  const alignment = attrOf(properties, ['w:jc'], 'w:val');
  if (alignment && ALIGNMENTS[alignment]) attrs['textAlign'] = ALIGNMENTS[alignment];

  const level = headingLevelOf(paragraph, state);
  const node: PMNode =
    level !== null
      ? { type: NODE.heading, attrs: { level, ...attrs } }
      : { type: NODE.paragraph, ...(Object.keys(attrs).length > 0 ? { attrs } : {}) };
  if (inline.length > 0) node.content = inline;

  const styleId = attrOf(properties, ['w:pStyle'], 'w:val');
  blocks.push(
    isQuoteStyle(styleId, state) ? { type: NODE.blockquote, content: [node] } : node,
  );

  // A break inside the runs ends the paragraph rather than sitting in it.
  const pageBreakInside = descendants(paragraph, 'w:br').some(
    (br) => br.attrs['w:type'] === 'page',
  );
  if (pageBreakInside) blocks.push({ type: NODE.pageBreak });

  return blocks;
}

/** The inline content of a paragraph or hyperlink. */
function inlineOf(container: XmlElement, state: State, marks: PMMark[]): PMNode[] {
  const nodes: PMNode[] = [];

  for (const element of container.children.filter(isElement)) {
    switch (element.name) {
      case 'w:r':
        nodes.push(...runOf(element, state, marks));
        break;
      case 'w:hyperlink': {
        const target = hyperlinkTarget(element, state);
        const next = target ? [...marks, { type: MARK.link, attrs: { href: target } }] : marks;
        nodes.push(...inlineOf(element, state, next));
        break;
      }
      case 'w:smartTag':
      case 'w:sdt':
      case 'w:sdtContent':
      case 'w:ins':
        nodes.push(...inlineOf(element, state, marks));
        break;
      default:
        break;
    }
  }
  return nodes;
}

const SAFE_HREF = /^(?:https?:\/\/[^/]|mailto:|#|\/(?!\/))/iu;

function hyperlinkTarget(element: XmlElement, state: State): string | null {
  const anchor = element.attrs['w:anchor'];
  if (anchor) return `#${anchor.replace(/[^\w-]/gu, '')}`;
  const id = element.attrs['r:id'];
  if (!id) return null;
  const relationship = state.pkg.relationships.get(id);
  if (!relationship) return null;
  return SAFE_HREF.test(relationship.target) ? relationship.target : null;
}

function runOf(run: XmlElement, state: State, inherited: PMMark[]): PMNode[] {
  const properties = child(run, 'w:rPr');
  const marks = [...inherited, ...marksOf(properties)];
  const nodes: PMNode[] = [];

  for (const element of run.children.filter(isElement)) {
    switch (element.name) {
      case 'w:t': {
        const text = textOf(element);
        if (text.length > 0) {
          nodes.push(marks.length > 0 ? { type: NODE.text, text, marks } : { type: NODE.text, text });
        }
        break;
      }
      case 'w:tab':
        nodes.push({ type: NODE.text, text: '\t', ...(marks.length > 0 ? { marks } : {}) });
        break;
      case 'w:br':
        // A page break ends the paragraph, and is added there.
        if (element.attrs['w:type'] !== 'page') nodes.push({ type: NODE.hardBreak });
        break;
      case 'w:drawing':
      case 'w:pict':
      case 'w:object': {
        const image = imageFrom(element, state);
        if (image) nodes.push(image);
        break;
      }
      default:
        break;
    }
  }
  return nodes;
}

const onOff = (properties: XmlElement | undefined, name: string): boolean => {
  const element = child(properties, name);
  if (!element) return false;
  const value = element.attrs['w:val'];
  return value !== '0' && value !== 'false' && value !== 'none';
};

function marksOf(properties: XmlElement | undefined): PMMark[] {
  if (!properties) return [];
  const marks: PMMark[] = [];
  if (onOff(properties, 'w:b')) marks.push({ type: MARK.bold });
  if (onOff(properties, 'w:i')) marks.push({ type: MARK.italic });
  if (onOff(properties, 'w:u')) marks.push({ type: MARK.underline });
  if (onOff(properties, 'w:strike')) marks.push({ type: MARK.strike });

  const vertical = attrOf(properties, ['w:vertAlign'], 'w:val');
  if (vertical === 'superscript') marks.push({ type: MARK.superscript });
  if (vertical === 'subscript') marks.push({ type: MARK.subscript });

  const highlight = attrOf(properties, ['w:highlight'], 'w:val');
  if (highlight && highlight !== 'none') {
    marks.push({ type: MARK.highlight, attrs: { color: HIGHLIGHTS[highlight] ?? highlight } });
  }

  const style: Record<string, unknown> = {};
  const colour = attrOf(properties, ['w:color'], 'w:val');
  if (colour && colour !== 'auto' && /^[0-9a-f]{6}$/iu.test(colour)) style['color'] = `#${colour}`;
  const font = attrOf(properties, ['w:rFonts'], 'w:ascii');
  if (font) style['fontFamily'] = font;
  const halfPoints = Number(attrOf(properties, ['w:sz'], 'w:val') ?? NaN);
  if (Number.isFinite(halfPoints) && halfPoints > 0) style['fontSize'] = `${halfPoints / 2}pt`;
  if (Object.keys(style).length > 0) marks.push({ type: MARK.textStyle, attrs: style });

  return marks;
}

function imageFrom(element: XmlElement, state: State): PMNode | null {
  const blip = descendants(element, 'a:blip')[0] ?? descendants(element, 'v:imagedata')[0];
  const id = blip?.attrs['r:embed'] ?? blip?.attrs['r:id'];
  if (!id) return null;
  const relationship = state.pkg.relationships.get(id);
  if (!relationship || relationship.external) {
    state.messages.add('An image stored outside the file was removed.');
    return null;
  }
  const bytes = state.pkg.media.get(relationship.target);
  if (!bytes) return null;

  const extension = /\.([a-z0-9]+)$/iu.exec(relationship.target)?.[1]?.toLowerCase() ?? '';
  const mime = IMAGE_TYPES[extension];
  if (!mime) {
    // Word carries EMF, WMF and TIFF pictures that cannot be written back.
    state.messages.add(
      'An image in a format that cannot be saved back to Word was removed. PNG, JPEG, GIF and BMP are kept.',
    );
    return null;
  }
  if (state.images >= MAX_IMAGES) {
    state.messages.add(`Only the first ${MAX_IMAGES} images were imported.`);
    return null;
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    state.messages.add('An image larger than 2 MB was removed.');
    return null;
  }
  if (state.imageBytes + bytes.length > MAX_TOTAL_IMAGE_BYTES) {
    state.messages.add('Some images were removed because the document held too many.');
    return null;
  }

  state.images += 1;
  state.imageBytes += bytes.length;

  const extent = descendants(element, 'wp:extent')[0];
  const width = Number(extent?.attrs['cx'] ?? NaN);
  const height = Number(extent?.attrs['cy'] ?? NaN);
  const description =
    descendants(element, 'wp:docPr')[0]?.attrs['descr'] ??
    descendants(element, 'wp:docPr')[0]?.attrs['name'] ??
    null;

  return {
    type: NODE.image,
    attrs: {
      src: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
      alt: description ? description.slice(0, 500) : null,
      title: null,
      // The size the picture is shown at, which is the whole point of reading
      // the markup rather than a rendering of it: measuring the picture instead
      // gave every image its pixel size and resized all of them.
      ...(Number.isFinite(width) && width > 0
        ? { width: Math.max(1, Math.round(width / EMU_PER_PIXEL)) }
        : {}),
      ...(Number.isFinite(height) && height > 0
        ? { height: Math.max(1, Math.round(height / EMU_PER_PIXEL)) }
        : {}),
    },
  };
}

interface CellPlan {
  node: PMNode;
  column: number;
  span: number;
}

function tableFrom(table: XmlElement, state: State): PMNode | null {
  const rows = childrenNamed(table, 'w:tr');
  if (rows.length === 0) return null;

  // Column widths are only meaningful when the table is laid out at a fixed
  // width. A table set to fill the page carries a nominal grid, and reading
  // those numbers as pixels squashed every such table into a column of single
  // letters, which the screenshots showed and no structural check did.
  const tableWidth = child(table, 'w:tblPr', 'w:tblW');
  const fixedWidth = (tableWidth?.attrs['w:type'] ?? 'auto') === 'dxa';
  const widths = childrenNamed(child(table, 'w:tblGrid'), 'w:gridCol').map((column) => {
    if (!fixedWidth) return null;
    const dxa = Number(column.attrs['w:w'] ?? NaN);
    if (!Number.isFinite(dxa) || dxa <= 0) return null;
    const pixels = Math.round(dxa / DXA_PER_PIXEL);
    // Below this a column cannot hold a word, so the number is nominal.
    return pixels >= 24 ? pixels : null;
  });

  // Cells carried down from an earlier row by a vertical merge, so a cell that
  // continues one does not take a place of its own in this row.
  const carried = new Map<number, CellPlan>();
  const built: PMNode[] = [];

  for (const row of rows) {
    const cells: PMNode[] = [];
    let column = 0;

    for (const cell of childrenNamed(row, 'w:tc')) {
      // No column is skipped here. A vertically merged cell is written out in
      // every row it covers, as a cell that continues the merge, so the columns
      // line up on their own. Skipping them put the merge on the cell to its
      // right: a table merged down its first column came back merged down its
      // second.
      const properties = child(cell, 'w:tcPr');
      const span = Math.max(1, Number(attrOf(properties, ['w:gridSpan'], 'w:val') ?? 1) || 1);
      const merge = child(properties, 'w:vMerge');
      const continues = Boolean(merge) && (merge?.attrs['w:val'] ?? 'continue') === 'continue';

      if (continues) {
        // Add a row to the cell above rather than writing a cell of its own.
        const above = carried.get(column)?.node ?? lastCellAt(built, column);
        if (above) {
          const attrs = (above.attrs ??= {});
          attrs['rowspan'] = Number(attrs['rowspan'] ?? 1) + 1;
          carried.set(column, { node: above, column, span });
        }
        column += span;
        continue;
      }

      const content = blocksOf(cell, state);
      const fill = attrOf(properties, ['w:shd'], 'w:fill');
      const isHeader =
        Boolean(child(row, 'w:trPr', 'w:tblHeader')) ||
        /^(?:th|tableheader)$/iu.test(attrOf(properties, ['w:cnfStyle'], 'w:val') ?? '');

      const node: PMNode = {
        type: isHeader ? NODE.tableHeader : NODE.tableCell,
        attrs: {
          colspan: span,
          rowspan: 1,
          colwidth: widths.slice(column, column + span).every((width) => width === null)
            ? null
            : widths.slice(column, column + span).map((width) => width ?? 0),
          ...(fill && fill !== 'auto' && /^[0-9a-f]{6}$/iu.test(fill)
            ? { background: `#${fill.toLowerCase()}` }
            : {}),
        },
        content: content.length > 0 ? content : [{ type: NODE.paragraph }],
      };

      if (merge) carried.set(column, { node, column, span });
      else carried.delete(column);

      cells.push(node);
      column += span;
    }

    if (cells.length > 0) built.push({ type: NODE.tableRow, content: cells });
  }

  if (built.length === 0) return null;
  return { type: NODE.table, content: built };
}

/** The most recent cell occupying a column, for a merge that continues. */
function lastCellAt(rows: PMNode[], column: number): PMNode | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    let at = 0;
    for (const cell of rows[index]?.content ?? []) {
      const span = Number(cell.attrs?.['colspan'] ?? 1);
      if (at === column) return cell;
      at += span;
    }
  }
  return null;
}
