/**
 * Word markup to the editor's document model.
 *
 * The rule is: preserve by default, edit what we understand.
 *
 * Every node keeps the identity it had in Word. A paragraph keeps the name of
 * its style and a reference to its own properties; a run keeps a reference to
 * the properties no mark stands for; a list keeps its numbering; a table, its
 * rows and its cells keep theirs. What the model has no node for at all (a
 * chart, a shape, a field, a footnote mark, a bookmark, an equation) becomes an
 * opaque object that carries a reference to its own markup and shows a label.
 *
 * The markup those references point at is kept beside the document, keyed by a
 * hash of itself, and the writer puts it back. That is what stops an upload
 * losing everything the editor was never taught: the editor does not need to
 * understand a chart to leave it where it was.
 *
 * Before this, the reader kept what it recognised and silently dropped the
 * rest, including every paragraph inside a block content control, which is how
 * Word wraps a cover page and its own table of contents.
 */
import { createHash } from 'node:crypto';
import {
  MARK,
  NODE,
  anchorFor,
  isSafeHref,
  textBlocks,
  type CommentAnchor,
  type PMMark,
  type PMNode,
  type StyleTable,
} from '@docforge/model';
import {
  attrOf,
  child,
  childrenNamed,
  descendants,
  isElement,
  serializeXml,
  textOf,
  type XmlElement,
} from './xml.js';
import type { WordPackage } from './package.js';
import { paragraphProps, readStyleTable, readThemeFonts, runProps, type ThemeFonts } from './styles.js';

/** English Metric Units per pixel at 96 dpi, which is how OOXML states sizes. */
const EMU_PER_PIXEL = 9525;
/** Twentieths of a point per pixel, for widths stated in dxa. */
const DXA_PER_PIXEL = 15;

/**
 * Picture limits. One picture may be large; the total is what a stored document
 * can carry while pictures travel inside it, which they do until they are moved
 * out into a store of their own. A picture left out of the editor is still in
 * the uploaded file and still goes back out to Word.
 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 200;

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

export const HIGHLIGHTS: Record<string, string> = {
  yellow: '#ffff00',
  green: '#00ff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  blue: '#0000ff',
  red: '#ff0000',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#c0c0c0',
  black: '#000000',
  white: '#ffffff',
};

export interface ConversionResult {
  content: PMNode;
  messages: string[];
  /** What sits outside the body: headers, footers and the page setup. */
  meta: DocumentMeta;
  /** Markup the writer puts back, keyed by the reference the model carries. */
  fragments: Record<string, string>;
  /** The document's own styles, resolved for drawing. */
  styles: StyleTable;
  /** Review comments the file carried, replies after the comment they answer. */
  comments: ImportedComment[];
}

export interface ImportedComment {
  wordId: string;
  parentWordId: string | null;
  author: string;
  date: string | null;
  body: string;
  anchor: CommentAnchor | null;
  resolved: boolean;
}

export interface DocumentMeta {
  header: string;
  footer: string;
  orientation: 'portrait' | 'landscape';
}

interface State {
  pkg: WordPackage;
  styles: StyleTable;
  theme: ThemeFonts;
  styleNames: Map<string, string>;
  /** Numbering a paragraph gets from its style rather than from itself. */
  styleNumbering: Map<string, { numId: string; level: number }>;
  numberingFormats: Map<string, string>;
  fragments: Map<string, string>;
  images: number;
  imageBytes: number;
  notes: { footnote: number; endnote: number };
  messages: Set<string>;
}

export function documentFromPackage(pkg: WordPackage): ConversionResult {
  const styles = readStyleTable(pkg.styles, pkg.theme);
  const state: State = {
    pkg,
    styles,
    theme: readThemeFonts(pkg.theme),
    styleNames: readStyleNames(pkg),
    styleNumbering: readStyleNumbering(pkg),
    numberingFormats: readNumbering(pkg),
    fragments: new Map(),
    images: 0,
    imageBytes: 0,
    notes: { footnote: 0, endnote: 0 },
    messages: new Set(),
  };

  const body = child(pkg.document, 'w:body');
  const blocks = body ? blocksOf(body, state) : [];
  const content: PMNode = {
    type: NODE.doc,
    content: blocks.length > 0 ? blocks : [{ type: NODE.paragraph }],
  };
  const comments = commentsFrom(pkg, liftCommentRanges(content));

  return {
    content,
    comments,
    messages: [...state.messages],
    meta: {
      header: firstText(pkg.headers),
      footer: firstText(pkg.footers),
      orientation:
        attrOf(body, ['w:sectPr', 'w:pgSz'], 'w:orient') === 'landscape' ? 'landscape' : 'portrait',
    },
    fragments: Object.fromEntries(state.fragments),
    styles,
  };
}

/**
 * Keep a piece of markup and return the reference to it.
 *
 * The reference is a hash of the markup, so the ten thousand runs of a long
 * document that share one set of properties share one entry, and the same
 * markup always has the same name whoever imports it.
 */
function keep(state: State, markup: string | XmlElement | XmlElement[]): string {
  const xml =
    typeof markup === 'string'
      ? markup
      : Array.isArray(markup)
        ? markup.map(serializeXml).join('')
        : serializeXml(markup);
  const ref = createHash('sha256').update(xml).digest('hex').slice(0, 16);
  if (!state.fragments.has(ref)) state.fragments.set(ref, xml);
  return ref;
}

const firstText = (parts: XmlElement[]): string => {
  for (const part of parts) {
    // What a reader sees, not what Word computes it from: reading every text
    // node showed a footer as "Page PAGE 1 of NUMPAGES 1".
    const text = visibleText(part).replace(/\s+/gu, ' ').trim();
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

/**
 * Numbering that comes from a style. "List Bullet" is a bulleted paragraph
 * because its style says so, with nothing on the paragraph itself, and reading
 * only the paragraph showed every such list as plain text.
 */
function readStyleNumbering(pkg: WordPackage): Map<string, { numId: string; level: number }> {
  const direct = new Map<string, { numId?: string; level?: number; basedOn?: string }>();
  for (const style of childrenNamed(pkg.styles, 'w:style')) {
    const id = style.attrs['w:styleId'];
    if (!id) continue;
    const numbering = child(style, 'w:pPr', 'w:numPr');
    const numId = attrOf(numbering, ['w:numId'], 'w:val');
    const level = attrOf(numbering, ['w:ilvl'], 'w:val');
    direct.set(id, {
      ...(numId ? { numId } : {}),
      ...(level !== undefined ? { level: Number(level) || 0 } : {}),
      ...(attrOf(style, ['w:basedOn'], 'w:val') ? { basedOn: attrOf(style, ['w:basedOn'], 'w:val') } : {}),
    });
  }
  const resolved = new Map<string, { numId: string; level: number }>();
  for (const id of direct.keys()) {
    let numId: string | undefined;
    let level: number | undefined;
    let current: string | undefined = id;
    for (let hops = 0; current && hops < 20; hops += 1) {
      const entry = direct.get(current);
      if (!entry) break;
      numId ??= entry.numId;
      level ??= entry.level;
      current = entry.basedOn;
    }
    if (numId && numId !== '0') resolved.set(id, { numId, level: level ?? 0 });
  }
  return resolved;
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
  format: string;
  ordered: boolean;
}

function numberingOf(paragraph: XmlElement, state: State): { numId: string; level: number } | null {
  const numbering = child(paragraph, 'w:pPr', 'w:numPr');
  const direct = attrOf(numbering, ['w:numId'], 'w:val');
  // A numId of 0 on the paragraph switches numbering off, whatever the style says.
  if (direct === '0') return null;
  const styleId = attrOf(paragraph, ['w:pPr', 'w:pStyle'], 'w:val');
  const fromStyle = styleId ? state.styleNumbering.get(styleId) : undefined;
  const numId = direct ?? fromStyle?.numId;
  if (!numId) return null;
  const stated = attrOf(numbering, ['w:ilvl'], 'w:val');
  const level = stated !== undefined ? Number(stated) : (fromStyle?.level ?? 0);
  return { numId, level: Number.isFinite(level) ? Math.max(0, Math.min(8, level)) : 0 };
}

function listInfoOf(paragraph: XmlElement, state: State): ListInfo | null {
  // A numbered heading is a heading. Wrapping it in a list put every chapter
  // title of a policy inside a list item.
  if (headingLevelOf(paragraph, state) !== null) return null;
  const numbering = numberingOf(paragraph, state);
  if (!numbering) return null;
  const format = state.numberingFormats.get(`${numbering.numId}:${numbering.level}`) ?? 'bullet';
  return { ...numbering, format, ordered: format !== 'bullet' && format !== 'none' };
}

/** Whether a paragraph opens a field that it does not close. */
function fieldBalance(paragraph: XmlElement): number {
  let depth = 0;
  for (const mark of descendants(paragraph, 'w:fldChar')) {
    const type = mark.attrs['w:fldCharType'];
    if (type === 'begin') depth += 1;
    else if (type === 'end') depth -= 1;
  }
  return depth;
}

const fieldInstruction = (elements: XmlElement[]): string =>
  elements
    .flatMap((element) => descendants(element, 'w:instrText'))
    .map(textOf)
    .join('')
    .trim();

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

    if (element.name === 'w:sdt') {
      // Word wraps its own table of contents, and a cover page, in a block
      // content control. A contents table is kept whole; anything else is read
      // as the paragraphs it holds, which used to be dropped outright.
      const gallery = descendants(element, 'w:docPartGallery')[0]?.attrs['w:val'] ?? '';
      if (/table of contents/iu.test(gallery)) {
        blocks.push(opaqueBlock(state, [element], 'toc'));
      } else {
        blocks.push(...blocksOf(child(element, 'w:sdtContent') ?? element, state));
      }
      continue;
    }

    if (element.name === 'w:customXml' || element.name === 'w:smartTag') {
      blocks.push(...blocksOf(element, state));
      continue;
    }

    if (element.name !== 'w:p') {
      // A section's closing properties are the writer's business, and the two
      // range markers mean nothing between paragraphs.
      if (['w:sectPr', 'w:bookmarkStart', 'w:bookmarkEnd', 'w:proofErr'].includes(element.name)) {
        continue;
      }
      if (element.name === 'mc:AlternateContent' || element.name === 'w:altChunk') {
        blocks.push(opaqueBlock(state, [element], 'object'));
      }
      continue;
    }

    // A field that opens here and closes in a later paragraph, which is how a
    // contents table is written when it is not in a content control. Splitting
    // it across editable paragraphs leaves half a field behind the first time
    // somebody deletes a line.
    if (fieldBalance(element) > 0) {
      const span: XmlElement[] = [element];
      let depth = fieldBalance(element);
      let cursor = index + 1;
      while (depth > 0 && cursor < children.length && span.length < 2000) {
        const next = children[cursor] as XmlElement;
        span.push(next);
        if (next.name === 'w:p') depth += fieldBalance(next);
        cursor += 1;
      }
      if (depth === 0) {
        const kind = /^TOC\b/iu.test(fieldInstruction(span)) ? 'toc' : 'field';
        blocks.push(opaqueBlock(state, span, kind));
        index = cursor - 1;
        continue;
      }
    }

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

    blocks.push(...paragraphFrom(element, state, false));
  }

  return blocks;
}

function opaqueBlock(state: State, elements: XmlElement[], kind: string): PMNode {
  const label = elements
    .filter((element) => element.name === 'w:p' || element.name === 'w:sdt')
    .flatMap((element) => (element.name === 'w:p' ? [element] : descendants(element, 'w:p')))
    .map((paragraph) => visibleText(paragraph).trim())
    .filter((line) => line.length > 0)
    .slice(0, 200)
    .join('\n')
    .slice(0, 4000);
  return { type: NODE.wordBlock, attrs: { ref: keep(state, elements), kind, label } };
}

/** The words a reader sees in a paragraph, without field codes. */
function visibleText(element: XmlElement): string {
  let text = '';
  const walk = (node: XmlElement): void => {
    for (const candidate of node.children) {
      if (!isElement(candidate)) continue;
      if (candidate.name === 'w:t') text += textOf(candidate);
      else if (candidate.name === 'w:tab') text += '\t';
      else if (candidate.name === 'w:instrText' || candidate.name === 'w:delText') continue;
      // A shape is written twice, once for readers that know the new markup and
      // once for those that do not. Its words are the same words both times.
      else if (candidate.name === 'mc:Fallback') continue;
      else walk(candidate);
    }
  };
  walk(element);
  return text;
}

/** Build nested lists from a run of numbered paragraphs. */
function listFrom(
  run: { paragraph: XmlElement; info: ListInfo }[],
  state: State,
  depth = 0,
): PMNode[] {
  if (run.length === 0 || depth > 10) return [];
  const baseLevel = Math.min(...run.map((entry) => entry.info.level));
  const first = run.find((entry) => entry.info.level === baseLevel)?.info ?? run[0]?.info;
  const items: PMNode[] = [];

  for (let index = 0; index < run.length; index += 1) {
    const entry = run[index] as { paragraph: XmlElement; info: ListInfo };
    if (entry.info.level !== baseLevel) continue;

    const content = paragraphFrom(entry.paragraph, state, true);
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

  if (items.length === 0 || !first) return [];
  return [
    {
      type: first.ordered ? NODE.orderedList : NODE.bulletList,
      // The numbering it had, so "a) b) c)" does not come back as "1. 2. 3.".
      attrs: { numId: first.numId, numLevel: baseLevel, listFormat: first.format },
      content: items,
    },
  ];
}

const HEADING_NAME = /^heading\s*([1-6])$/u;

function headingLevelOf(paragraph: XmlElement, state: State): number | null {
  const properties = child(paragraph, 'w:pPr');
  const styleId = attrOf(properties, ['w:pStyle'], 'w:val');
  if (styleId) {
    const name = state.styleNames.get(styleId) ?? styleId.toLowerCase();
    const match = HEADING_NAME.exec(name.replace(/heading(\d)/u, 'heading $1'));
    if (match) return Number(match[1]);
    // A house style called "Policy Section" is a heading because its outline
    // level says so, not because of what it is called.
    const fromStyle = state.styles.paragraph[styleId]?.props.outlineLevel;
    if (fromStyle !== undefined && fromStyle <= 5) return fromStyle + 1;
  }
  const outline = Number(attrOf(properties, ['w:outlineLvl'], 'w:val') ?? NaN);
  return Number.isInteger(outline) && outline >= 0 && outline <= 5 ? outline + 1 : null;
}

const isQuoteStyle = (styleId: string | undefined, state: State): boolean => {
  if (!styleId) return false;
  const name = state.styleNames.get(styleId) ?? styleId;
  return /quote/iu.test(name);
};

/** Properties the model states itself, and the writer therefore writes itself. */
const OWNED_PARAGRAPH_PROPERTIES = new Set(['w:pStyle', 'w:jc', 'w:ind', 'w:spacing', 'w:pageBreakBefore']);

/**
 * One Word paragraph, which can become more than one block: a page break is a
 * block of its own here, and a paragraph holding only a bottom border is a rule.
 */
function paragraphFrom(paragraph: XmlElement, state: State, inList: boolean): PMNode[] {
  const properties = child(paragraph, 'w:pPr');
  const blocks: PMNode[] = [];

  if (onOff(properties, 'w:pageBreakBefore')) blocks.push({ type: NODE.pageBreak });

  const inline = inlineOf(paragraph, state, []);
  const hasText = inline.some(
    (node) => node.type !== NODE.text || (node.text ?? '').trim().length > 0,
  );

  // A paragraph with nothing in it but a bottom border is how Word writes the
  // rule people insert from the ribbon.
  const bottomBorder = child(properties, 'w:pBdr', 'w:bottom');
  if (!hasText && bottomBorder && bottomBorder.attrs['w:val'] !== 'none' && !child(properties, 'w:sectPr')) {
    blocks.push({ type: NODE.horizontalRule });
    return blocks;
  }

  const attrs: Record<string, unknown> = {};
  const styleId = attrOf(properties, ['w:pStyle'], 'w:val');
  if (styleId) attrs['styleId'] = styleId;

  const direct = paragraphProps(properties);
  if (direct.textAlign) attrs['textAlign'] = direct.textAlign;
  if (direct.indentLeft !== undefined) attrs['indentLeft'] = direct.indentLeft;
  if (direct.indentRight !== undefined) attrs['indentRight'] = direct.indentRight;
  if (direct.indentFirstLine !== undefined) attrs['indentFirstLine'] = direct.indentFirstLine;
  if (direct.spacingBefore !== undefined) attrs['spacingBefore'] = direct.spacingBefore;
  if (direct.spacingAfter !== undefined) attrs['spacingAfter'] = direct.spacingAfter;
  if (direct.lineHeight !== undefined) attrs['lineHeight'] = direct.lineHeight;
  if (direct.lineExact !== undefined) attrs['lineExact'] = direct.lineExact;

  // Everything else the paragraph says about itself: borders, shading, tabs,
  // keep-with-next, its numbering if it is a numbered heading, and the section
  // break if one ends here. The writer puts it back and lays what the model
  // states over the top. A list item's numbering is left out, because the list
  // it sits in states that, and a paragraph lifted out of a list in the editor
  // must not stay numbered in Word.
  const rest = (properties?.children ?? []).filter(
    (node) =>
      isElement(node) &&
      !OWNED_PARAGRAPH_PROPERTIES.has(node.name) &&
      !(inList && node.name === 'w:numPr'),
  );
  if (rest.length > 0) attrs['pprRef'] = keep(state, rest as XmlElement[]);

  const level = headingLevelOf(paragraph, state);
  if (level !== null) {
    const numbering = numberingOf(paragraph, state);
    if (numbering) attrs['numLevel'] = numbering.level;
  }
  const node: PMNode =
    level !== null
      ? { type: NODE.heading, attrs: { level, ...attrs } }
      : { type: NODE.paragraph, ...(Object.keys(attrs).length > 0 ? { attrs } : {}) };
  if (inline.length > 0) node.content = inline;

  blocks.push(isQuoteStyle(styleId, state) ? { type: NODE.blockquote, content: [node] } : node);

  // A break inside the runs ends the paragraph rather than sitting in it.
  const pageBreakInside = descendants(paragraph, 'w:br').some(
    (br) => br.attrs['w:type'] === 'page',
  );
  if (pageBreakInside) blocks.push({ type: NODE.pageBreak });

  return blocks;
}

/** Elements that sit between runs and carry nothing a reader sees. */
const INVISIBLE_MARKERS: Record<string, string> = {
  'w:bookmarkStart': 'bookmark',
  'w:bookmarkEnd': 'bookmark',
  'w:permStart': 'permission',
  'w:permEnd': 'permission',
};

/** The inline content of a paragraph or hyperlink. */
function inlineOf(container: XmlElement, state: State, marks: PMMark[]): PMNode[] {
  const nodes: PMNode[] = [];
  const elements = container.children.filter(isElement);

  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index] as XmlElement;

    // A complex field: a run that begins it, runs holding its code, a run that
    // separates code from result, the result, and a run that ends it.
    if (element.name === 'w:r' && beginsField(element)) {
      const span: XmlElement[] = [];
      let depth = 0;
      let cursor = index;
      while (cursor < elements.length) {
        const part = elements[cursor] as XmlElement;
        span.push(part);
        depth += fieldBalance(part);
        cursor += 1;
        if (depth <= 0) break;
      }
      if (depth === 0) {
        nodes.push(...fieldFrom(span, state, marks));
        index = cursor - 1;
        continue;
      }
    }

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
      case 'w:fldSimple': {
        const link = /^\s*HYPERLINK\s+"([^"]+)"/iu.exec(element.attrs['w:instr'] ?? '');
        if (link && isSafeHref(link[1])) {
          nodes.push(...inlineOf(element, state, [...marks, { type: MARK.link, attrs: { href: link[1] } }]));
        } else {
          nodes.push(opaqueInline(state, [element], 'field', visibleText(element)));
        }
        break;
      }
      case 'w:smartTag':
      case 'w:customXml':
      case 'w:sdtContent':
        nodes.push(...inlineOf(element, state, marks));
        break;
      case 'w:ins':
      case 'w:moveTo':
      case 'w:del':
      case 'w:moveFrom': {
        // A tracked change stays a tracked change. Insertions used to be read
        // as accepted and deletions dropped, so a document sent out for review
        // came back with every reviewer's decision made for them.
        const type = element.name === 'w:ins' || element.name === 'w:moveTo' ? MARK.insertion : MARK.deletion;
        const date = element.attrs['w:date'] ?? '';
        const change: PMMark = {
          type,
          attrs: {
            author: (element.attrs['w:author'] ?? 'Unknown').slice(0, 200),
            date: /^\d{4}-\d{2}-\d{2}T/u.test(date) ? date : '',
          },
        };
        nodes.push(...inlineOf(element, state, [...marks, change]));
        break;
      }
      case 'w:sdt': {
        // A control that is a box of text is read as its text, so that it can
        // be edited. A drop-down, a date picker, a tick box or a picture holder
        // is kept whole: reading it as text would hand Word back a form with
        // the controls taken out of it.
        const properties = child(element, 'w:sdtPr');
        const isForm = ['w:dropDownList', 'w:comboBox', 'w:date', 'w14:checkbox', 'w:picture'].some((name) =>
          Boolean(child(properties, name)),
        );
        if (isForm) nodes.push(opaqueInline(state, [element], 'control', visibleText(element)));
        else nodes.push(...inlineOf(child(element, 'w:sdtContent') ?? element, state, marks));
        break;
      }
      case 'm:oMath':
      case 'm:oMathPara':
        nodes.push(opaqueInline(state, [element], 'equation', textOf(element)));
        break;
      case 'w:commentRangeStart':
      case 'w:commentRangeEnd':
        // Lifted out again once the whole document is built: see
        // liftCommentRanges. Comments live beside the document, not in it.
        nodes.push({
          type: element.name === 'w:commentRangeStart' ? COMMENT_START : COMMENT_END,
          attrs: { id: element.attrs['w:id'] ?? '' },
        });
        break;
      default:
        if (INVISIBLE_MARKERS[element.name]) {
          nodes.push(opaqueInline(state, [element], INVISIBLE_MARKERS[element.name] as string, ''));
        }
        break;
    }
  }
  return nodes;
}

const beginsField = (run: XmlElement): boolean =>
  childrenNamed(run, 'w:fldChar').some((mark) => mark.attrs['w:fldCharType'] === 'begin');

/**
 * A field. A hyperlink written as a field becomes a link, because that is what
 * it is; anything else is kept whole and shows the result Word last computed.
 */
function fieldFrom(span: XmlElement[], state: State, marks: PMMark[]): PMNode[] {
  const instruction = fieldInstruction(span);
  let pastSeparator = false;
  const result: XmlElement[] = [];
  for (const element of span) {
    const types = descendants(element, 'w:fldChar').map((mark) => mark.attrs['w:fldCharType']);
    if (pastSeparator && !types.includes('end')) result.push(element);
    if (types.includes('separate')) pastSeparator = true;
  }

  const link = /^HYPERLINK\s+(?:\\l\s+)?"([^"]+)"/iu.exec(instruction);
  if (link) {
    const href = /\\l\s+"/iu.test(instruction) ? `#${(link[1] as string).replace(/[^\w-]/gu, '')}` : link[1];
    if (isSafeHref(href)) {
      const linked = [...marks, { type: MARK.link, attrs: { href } }];
      return result.flatMap((element) =>
        element.name === 'w:r' ? runOf(element, state, linked) : inlineOf(element, state, linked),
      );
    }
  }
  const label = result.map(visibleText).join('');
  return [opaqueInline(state, span, 'field', label)];
}

function opaqueInline(state: State, elements: XmlElement[], kind: string, label: string): PMNode {
  return {
    type: NODE.wordInline,
    attrs: { ref: keep(state, elements), kind, label: label.replace(/\s+/gu, ' ').slice(0, 500) },
  };
}

function hyperlinkTarget(element: XmlElement, state: State): string | null {
  const anchor = element.attrs['w:anchor'];
  if (anchor) return `#${anchor.replace(/[^\w-]/gu, '')}`;
  const id = element.attrs['r:id'];
  if (!id) return null;
  const relationship = state.pkg.relationships.get(id);
  if (!relationship) return null;
  return isSafeHref(relationship.target) ? relationship.target : null;
}

/** What each thing a run can hold that is not text shows as, and is called. */
const OPAQUE_RUN_CHILDREN: Record<string, string> = {
  'w:footnoteReference': 'footnote',
  'w:endnoteReference': 'endnote',
  'w:sym': 'symbol',
  'w:ptab': 'tab',
  'w:fldChar': 'field',
  'w:instrText': 'field',
  'w:object': 'object',
  'w:pict': 'shape',
  'mc:AlternateContent': 'shape',
  'w:ruby': 'ruby',
  'w:footnoteRef': 'footnote',
  'w:endnoteRef': 'endnote',
  'w:separator': 'other',
  'w:continuationSeparator': 'other',
  'w:pgNum': 'field',
};

function runOf(run: XmlElement, state: State, inherited: PMMark[]): PMNode[] {
  const properties = child(run, 'w:rPr');
  const marks = [...inherited, ...marksOf(properties, state)];
  const nodes: PMNode[] = [];
  const withMarks = (node: PMNode): PMNode => (marks.length > 0 ? { ...node, marks } : node);

  // Something this run holds has no node of its own. The whole run is kept as
  // one object rather than being read in part: a footnote mark without its
  // formatting, or half a field, is worse than either.
  const elements = run.children.filter(isElement);
  // The mark in the margin. The comment itself is read from its own part.
  if (elements.some((element) => element.name === 'w:commentReference' || element.name === 'w:annotationRef')) {
    return [];
  }
  const unknown = elements.find((element) => {
    if (OPAQUE_RUN_CHILDREN[element.name]) return true;
    if (element.name === 'w:drawing') return !pictureOf(element);
    return false;
  });
  if (unknown) {
    const kind =
      unknown.name === 'w:drawing'
        ? drawingKind(unknown)
        : (OPAQUE_RUN_CHILDREN[unknown.name] as string);
    const picture =
      kind === 'shape' || kind === 'object' ? (imageFrom(unknown, state, true) ?? null) : null;
    if (picture) {
      // An embedded object or a legacy picture that carries a picture of
      // itself: show it, and still put the original back.
      picture.attrs = { ...(picture.attrs ?? {}), wordRef: keep(state, [run]) };
      return [picture];
    }
    if (kind === 'footnote' || kind === 'endnote') {
      // Numbered as a reader sees them, in the order they appear, and carrying
      // the words of the note so that they can be read here. The note itself
      // stays in its own part of the file and goes back out untouched.
      const notes = kind === 'footnote' ? state.pkg.footnotes : state.pkg.endnotes;
      const id = unknown.attrs['w:id'] ?? '';
      const source = childrenNamed(notes, kind === 'footnote' ? 'w:footnote' : 'w:endnote').find(
        (note) => note.attrs['w:id'] === id,
      );
      state.notes[kind] += 1;
      const number = kind === 'footnote' ? String(state.notes[kind]) : toRoman(state.notes[kind]);
      const node = opaqueInline(state, [run], kind, number);
      const words = source ? visibleText(source).replace(/\s+/gu, ' ').trim().slice(0, 2000) : '';
      if (words) node.attrs = { ...(node.attrs ?? {}), note: words };
      return [node];
    }
    const label = kind === 'symbol' ? symbolOf(unknown) : visibleText(run) || textOf(unknown).slice(0, 500);
    return [opaqueInline(state, [run], kind, label)];
  }

  for (const element of elements) {
    switch (element.name) {
      case 'w:t':
      case 'w:delText': {
        const text = textOf(element);
        if (text.length > 0) nodes.push(withMarks({ type: NODE.text, text }));
        break;
      }
      case 'w:tab':
        nodes.push(withMarks({ type: NODE.text, text: '\t' }));
        break;
      case 'w:noBreakHyphen':
        nodes.push(withMarks({ type: NODE.text, text: String.fromCodePoint(0x2011) }));
        break;
      case 'w:softHyphen':
        nodes.push(withMarks({ type: NODE.text, text: String.fromCodePoint(0xad) }));
        break;
      case 'w:br':
      case 'w:cr':
        // A page break ends the paragraph, and is added there.
        if (element.attrs['w:type'] !== 'page') nodes.push({ type: NODE.hardBreak });
        break;
      case 'w:drawing': {
        const image = imageFrom(element, state, false);
        if (image) {
          // Kept so a floating, cropped or framed picture leaves as it came.
          image.attrs = { ...(image.attrs ?? {}), wordRef: keep(state, [element]) };
          nodes.push(image);
        }
        break;
      }
      default:
        break;
    }
  }
  return nodes;
}

/** Small Roman numerals, which is how Word numbers endnotes. */
const toRoman = (value: number): string => {
  const parts: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let left = Math.max(1, Math.min(value, 3999));
  let out = '';
  for (const [size, letters] of parts) {
    while (left >= size) {
      out += letters;
      left -= size;
    }
  }
  return out;
};

const symbolOf = (element: XmlElement): string => {
  const code = Number.parseInt(element.attrs['w:char'] ?? '', 16);
  // Symbol fonts sit in the private use area from F000; the glyph a reader
  // expects is the one at the same place in the ordinary range.
  if (!Number.isFinite(code)) return '';
  return String.fromCodePoint(code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code);
};

/** A drawing that is simply a picture, which the model has a node for. */
const pictureOf = (drawing: XmlElement): XmlElement | undefined => {
  const uri = descendants(drawing, 'a:graphicData')[0]?.attrs['uri'] ?? '';
  // Anything that is plainly something else. A missing or unfamiliar uri with a
  // picture inside it is still a picture: not every producer writes the uri.
  if (/\/(?:chart|diagram)$/u.test(uri) || /wordprocessing(?:Shape|Group|Canvas)$/u.test(uri)) {
    return undefined;
  }
  return descendants(drawing, 'a:blip')[0];
};

function drawingKind(drawing: XmlElement): string {
  const uri = descendants(drawing, 'a:graphicData')[0]?.attrs['uri'] ?? '';
  if (/\/chart$/u.test(uri)) return 'chart';
  if (/\/diagram$/u.test(uri)) return 'diagram';
  if (/wordprocessing(?:Shape|Group|Canvas)$/u.test(uri)) {
    return descendants(drawing, 'w:txbxContent').length > 0 ? 'textbox' : 'shape';
  }
  return 'object';
}

const onOff = (properties: XmlElement | undefined, name: string): boolean => {
  const element = child(properties, name);
  if (!element) return false;
  const value = element.attrs['w:val'];
  return value !== '0' && value !== 'false' && value !== 'none' && value !== 'off';
};

/** Run properties a mark stands for. Everything else is kept by reference. */
const OWNED_RUN_PROPERTIES = new Set([
  'w:b',
  'w:bCs',
  'w:i',
  'w:iCs',
  'w:strike',
  'w:vertAlign',
  'w:color',
  'w:sz',
  'w:szCs',
]);

function marksOf(properties: XmlElement | undefined, state: State): PMMark[] {
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

  const direct = runProps(properties, state.theme);
  const style: Record<string, unknown> = {};
  if (direct.color && direct.color !== 'auto') style['color'] = direct.color;
  if (direct.fontFamily) style['fontFamily'] = direct.fontFamily;
  if (direct.fontSize) style['fontSize'] = `${direct.fontSize}pt`;
  if (Object.keys(style).length > 0) marks.push({ type: MARK.textStyle, attrs: style });

  // What no mark stands for: a character style, small caps, spacing, a
  // language, shading, a border, the kind of underline, and any property
  // switched explicitly off against its style.
  const rest = properties.children.filter((node): node is XmlElement => {
    if (!isElement(node)) return false;
    if (node.name === 'w:rFonts' || node.name === 'w:highlight' || node.name === 'w:u') return true;
    if (!OWNED_RUN_PROPERTIES.has(node.name)) return true;
    const value = node.attrs['w:val'];
    return value === '0' || value === 'false' || value === 'off';
  });
  const meaningful = rest.some((node) => !['w:rFonts', 'w:highlight', 'w:lang', 'w:noProof'].includes(node.name) ||
    (node.name === 'w:rFonts' && !direct.fontFamily));
  const underlineKind = attrOf(properties, ['w:u'], 'w:val');
  if (meaningful || (underlineKind && underlineKind !== 'single' && underlineKind !== 'none')) {
    const styleId = attrOf(properties, ['w:rStyle'], 'w:val');
    marks.push({
      type: MARK.wordRun,
      attrs: {
        ref: keep(state, rest),
        ...(styleId ? { styleId } : {}),
        // The font as it was resolved, so the writer can tell a theme font that
        // was only read from one somebody has since chosen.
        ...(direct.fontFamily ? { font: direct.fontFamily } : {}),
      },
    });
  }

  return marks;
}

function imageFrom(element: XmlElement, state: State, quiet: boolean): PMNode | null {
  const blip = descendants(element, 'a:blip')[0] ?? descendants(element, 'v:imagedata')[0];
  const id = blip?.attrs['r:embed'] ?? blip?.attrs['r:id'];
  if (!id) return null;
  const relationship = state.pkg.relationships.get(id);
  if (!relationship || relationship.external) {
    if (!quiet) state.messages.add('An image stored outside the file was removed.');
    return null;
  }
  const bytes = state.pkg.media.get(relationship.target);
  if (!bytes) return null;

  const extension = /\.([a-z0-9]+)$/iu.exec(relationship.target)?.[1]?.toLowerCase() ?? '';
  const mime = IMAGE_TYPES[extension];
  if (!mime) {
    // Word carries EMF, WMF and TIFF pictures a browser cannot draw. The
    // picture itself is still in the file and still goes back out.
    if (!quiet) {
      state.messages.add(
        'A picture in a format a browser cannot show (EMF, WMF or TIFF) is kept in the file but not drawn here.',
      );
      return {
        type: NODE.wordInline,
        attrs: { ref: keep(state, [element]), kind: 'picture', label: 'Picture' },
      };
    }
    return null;
  }
  if (state.images >= MAX_IMAGES) {
    state.messages.add(`Only the first ${MAX_IMAGES} images are shown here. The rest are still in the Word file.`);
    return null;
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    state.messages.add('An image larger than 6 MB is not shown here. It is still in the Word file.');
    return null;
  }
  if (state.imageBytes + bytes.length > MAX_TOTAL_IMAGE_BYTES) {
    state.messages.add('Some images are not shown here because the document holds too many. They are still in the Word file.');
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

/** Cell properties the model states itself. */
const OWNED_CELL_PROPERTIES = new Set(['w:gridSpan', 'w:vMerge', 'w:hMerge', 'w:shd', 'w:tcW']);

function tableFrom(table: XmlElement, state: State): PMNode | null {
  const rows = childrenNamed(table, 'w:tr');
  if (rows.length === 0) return null;

  // Column widths are only meaningful when the table is laid out at a fixed
  // width. A table set to fill the page carries a nominal grid, and reading
  // those numbers as pixels squashed every such table into a column of single
  // letters, which the screenshots showed and no structural check did.
  const tableProperties = child(table, 'w:tblPr');
  const tableWidth = child(tableProperties, 'w:tblW');
  const fixedWidth = (tableWidth?.attrs['w:type'] ?? 'auto') === 'dxa';
  const grid = childrenNamed(child(table, 'w:tblGrid'), 'w:gridCol');
  const widths = grid.map((column) => {
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
    const rowProperties = child(row, 'w:trPr');

    for (const cell of cellsOf(row)) {
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
        Boolean(child(rowProperties, 'w:tblHeader')) ||
        /^(?:th|tableheader)$/iu.test(attrOf(properties, ['w:cnfStyle'], 'w:val') ?? '');
      const rest = (properties?.children ?? []).filter(
        (node): node is XmlElement => isElement(node) && !OWNED_CELL_PROPERTIES.has(node.name),
      );

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
          // Borders, margins, vertical alignment and text direction.
          ...(rest.length > 0 ? { tcRef: keep(state, rest) } : {}),
        },
        content: content.length > 0 ? content : [{ type: NODE.paragraph }],
      };

      if (merge) carried.set(column, { node, column, span });
      else carried.delete(column);

      cells.push(node);
      column += span;
    }

    if (cells.length > 0) {
      built.push({
        type: NODE.tableRow,
        // Row height, "repeat as header row" and "do not break across pages".
        ...(rowProperties && rowProperties.children.some(isElement)
          ? { attrs: { trRef: keep(state, rowProperties.children.filter(isElement)) } }
          : {}),
        content: cells,
      });
    }
  }

  if (built.length === 0) return null;
  return {
    type: NODE.table,
    attrs: {
      // The table's style, borders, width, alignment and the grid it was drawn
      // on. The grid is only reused while the table still has as many columns.
      ...(tableProperties ? { tblRef: keep(state, tableProperties.children.filter(isElement)) } : {}),
      ...(grid.length > 0 ? { gridRef: keep(state, grid), gridColumns: grid.length } : {}),
    },
    content: built,
  };
}

/** The cells of a row, looking inside the content controls that may wrap them. */
function cellsOf(row: XmlElement): XmlElement[] {
  const cells: XmlElement[] = [];
  for (const node of row.children) {
    if (!isElement(node)) continue;
    if (node.name === 'w:tc') cells.push(node);
    else if (node.name === 'w:sdt') cells.push(...cellsOf(child(node, 'w:sdtContent') ?? node));
    else if (node.name === 'w:customXml' || node.name === 'w:sdtContent') cells.push(...cellsOf(node));
  }
  return cells;
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

const COMMENT_START = '__commentStart';
const COMMENT_END = '__commentEnd';

/**
 * Take the comment range markers back out of the document, and say where each
 * range was: the words it covered and what stood around them.
 *
 * A range that runs over several paragraphs is anchored to the part of it in
 * the first, because an anchor lives in one block of text.
 */
function liftCommentRanges(doc: PMNode): Map<string, CommentAnchor> {
  const open = new Map<string, { block: number; from: number }>();
  const spans = new Map<string, { block: number; from: number; to: number }>();

  // First pass: offsets, counted the way textBlocks counts them, markers aside.
  const strip = (node: PMNode): void => {
    for (const inner of node.content ?? []) strip(inner);
    if (node.content?.some((inner) => inner.type === COMMENT_START || inner.type === COMMENT_END)) {
      node.content = node.content.filter((inner) => inner.type !== COMMENT_START && inner.type !== COMMENT_END);
      if (node.content.length === 0) delete node.content;
    }
  };
  let blockIndex = -1;
  const measure = (node: PMNode): void => {
    if (node.type === NODE.paragraph || node.type === NODE.heading) {
      blockIndex += 1;
      let offset = 0;
      for (const inner of node.content ?? []) {
        const raw = inner.attrs?.['id'];
        const id = typeof raw === 'string' ? raw : '';
        if (inner.type === COMMENT_START) open.set(id, { block: blockIndex, from: offset });
        else if (inner.type === COMMENT_END) {
          const started = open.get(id);
          if (started && !spans.has(id)) {
            spans.set(id, {
              block: started.block,
              from: started.from,
              // Ended in a later paragraph: to the end of the one it began in.
              to: started.block === blockIndex ? offset : Number.MAX_SAFE_INTEGER,
            });
          }
        } else offset += inner.type === NODE.text ? (inner.text ?? '').length : 1;
      }
      return;
    }
    for (const inner of node.content ?? []) measure(inner);
  };
  measure(doc);
  strip(doc);

  const blocks = textBlocks(doc);
  const anchors = new Map<string, CommentAnchor>();
  for (const [id, span] of spans) {
    const text = blocks[span.block]?.text ?? '';
    let from = span.from;
    const to = Math.min(span.to, text.length);
    if (from >= to) {
      // A comment made at a point rather than on a selection, which is how some
      // word processors write every comment. It belongs to the word it follows.
      const before = /\S+\s*$/u.exec(text.slice(0, to));
      if (before) from = to - before[0].length;
    }
    const anchor = anchorFor(blocks, span.block, from, from < to ? to : text.length);
    if (anchor) anchors.set(id, anchor);
  }
  return anchors;
}

function commentsFrom(pkg: WordPackage, anchors: Map<string, CommentAnchor>): ImportedComment[] {
  if (!pkg.comments) return [];
  // Threads and resolution are stated per paragraph id, in a part of their own.
  const extended = new Map<string, { parent: string | null; done: boolean }>();
  for (const entry of childrenNamed(pkg.commentsExtended, 'w15:commentEx')) {
    const id = entry.attrs['w15:paraId'];
    if (!id) continue;
    extended.set(id, {
      parent: entry.attrs['w15:paraIdParent'] ?? null,
      done: entry.attrs['w15:done'] === '1' || entry.attrs['w15:done'] === 'true',
    });
  }

  const byParagraph = new Map<string, string>();
  const read = childrenNamed(pkg.comments, 'w:comment').slice(0, 5000).map((comment) => {
    const paragraphs = descendants(comment, 'w:p');
    const lastParagraph = paragraphs.at(-1)?.attrs['w14:paraId'] ?? null;
    const wordId = comment.attrs['w:id'] ?? '';
    for (const paragraph of paragraphs) {
      const id = paragraph.attrs['w14:paraId'];
      if (id) byParagraph.set(id, wordId);
    }
    return {
      wordId,
      lastParagraph,
      author: (comment.attrs['w:author'] ?? 'Unknown').slice(0, 200),
      date: /^\d{4}-\d{2}-\d{2}T/u.test(comment.attrs['w:date'] ?? '') ? (comment.attrs['w:date'] as string) : null,
      body: paragraphs.map((paragraph) => visibleText(paragraph)).join('\n').trim(),
    };
  });

  const comments: ImportedComment[] = [];
  for (const comment of read) {
    if (!comment.wordId || comment.body.length === 0) continue;
    const more = comment.lastParagraph ? extended.get(comment.lastParagraph) : undefined;
    const parentWordId = more?.parent ? (byParagraph.get(more.parent) ?? null) : null;
    comments.push({
      wordId: comment.wordId,
      parentWordId: parentWordId === comment.wordId ? null : parentWordId,
      author: comment.author,
      date: comment.date,
      body: comment.body.slice(0, 10000),
      anchor: parentWordId ? null : (anchors.get(comment.wordId) ?? null),
      resolved: more?.done ?? false,
    });
  }
  // Parents first, so a reply always finds the comment it answers.
  return [...comments.filter((c) => !c.parentWordId), ...comments.filter((c) => c.parentWordId)];
}
