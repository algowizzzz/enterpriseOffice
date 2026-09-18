/**
 * The editor's document model back to a Word file, by patching.
 *
 * The file somebody uploaded is opened, its body is rewritten from the model,
 * and everything else is left exactly as it was: the styles, the numbering, the
 * theme, the fonts, the settings, the headers and footers with their logos and
 * page numbers, the footnotes, the comments, the charts and every part those
 * refer to. A document that was never uploaded starts from a template package
 * and takes the same path, so there is one writer and not two.
 *
 * The writer that came before built a new file from nothing. Whatever the model
 * had no node for was gone on the first export, and no amount of teaching the
 * model new nodes closes that gap: Word has more of them than anybody will ever
 * write editors for. Leaving the file alone closes it.
 *
 * Markup the reader kept by reference is put back here. Where the model also
 * states something (that a run is bold, that a paragraph is centred), what the
 * model states is laid over the top, because that is what somebody may have
 * changed.
 */
import { createHash } from 'node:crypto';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  MARK,
  NODE,
  isSafeHref,
  locateAnchor,
  outline,
  textBlocks,
  type CommentAnchor,
  type PageSetup,
  type PMMark,
  type PMNode,
} from '@docforge/model';
import { measureImage } from '../imageSize.js';
import { HIGHLIGHTS } from './toDocument.js';
import {
  attrOf,
  child,
  childrenNamed,
  descendants,
  el,
  escapeXmlAttr,
  escapeXmlText,
  isElement,
  parseXml,
  serializeXml,
  textOf,
  type XmlElement,
} from './xml.js';

const EMU_PER_PIXEL = 9525;
const DXA_PER_PIXEL = 15;
/** The width between the margins of an A4 or Letter page, near enough. */
const TEXT_WIDTH_DXA = 9026;
const MAX_SPAN = 1000;

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NAMESPACES: Record<string, string> = {
  'xmlns:w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'xmlns:r': REL,
  'xmlns:wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  'xmlns:a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
  'xmlns:pic': 'http://schemas.openxmlformats.org/drawingml/2006/picture',
};

/** The order Word's schema wants a paragraph's properties in. */
const PPR_ORDER = [
  'w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:framePr', 'w:widowControl',
  'w:numPr', 'w:suppressLineNumbers', 'w:pBdr', 'w:shd', 'w:tabs', 'w:suppressAutoHyphens',
  'w:kinsoku', 'w:wordWrap', 'w:overflowPunct', 'w:topLinePunct', 'w:autoSpaceDE', 'w:autoSpaceDN',
  'w:bidi', 'w:adjustRightInd', 'w:snapToGrid', 'w:spacing', 'w:ind', 'w:contextualSpacing',
  'w:mirrorIndents', 'w:suppressOverlap', 'w:jc', 'w:textDirection', 'w:textAlignment',
  'w:textboxTightWrap', 'w:outlineLvl', 'w:divId', 'w:cnfStyle', 'w:rPr', 'w:sectPr', 'w:pPrChange',
];
const RPR_ORDER = [
  'w:rStyle', 'w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:caps', 'w:smallCaps', 'w:strike',
  'w:dstrike', 'w:outline', 'w:shadow', 'w:emboss', 'w:imprint', 'w:noProof', 'w:snapToGrid',
  'w:vanish', 'w:webHidden', 'w:color', 'w:spacing', 'w:w', 'w:kern', 'w:position', 'w:sz', 'w:szCs',
  'w:highlight', 'w:u', 'w:effect', 'w:bdr', 'w:shd', 'w:fitText', 'w:vertAlign', 'w:rtl', 'w:cs',
  'w:em', 'w:lang', 'w:eastAsianLayout', 'w:specVanish', 'w:oMath', 'w:rPrChange',
];
const TCPR_ORDER = [
  'w:cnfStyle', 'w:tcW', 'w:gridSpan', 'w:hMerge', 'w:vMerge', 'w:tcBorders', 'w:shd', 'w:noWrap',
  'w:tcMar', 'w:textDirection', 'w:tcFitText', 'w:vAlign', 'w:hideMark',
];

const inOrder = (elements: XmlElement[], order: string[]): XmlElement[] => {
  const rank = (name: string): number => {
    const at = order.indexOf(name);
    return at === -1 ? order.length : at;
  };
  return elements
    .map((element, index) => ({ element, index }))
    .sort((a, b) => rank(a.element.name) - rank(b.element.name) || a.index - b.index)
    .map((entry) => entry.element);
};

export interface WriteOptions {
  /** The package to patch: the uploaded file, or a template. */
  base: Buffer;
  /** Markup kept by the reader, by reference. */
  fragments: Record<string, string>;
  pageSetup: PageSetup;
  /**
   * The header and footer text as they were read. While they are unchanged the
   * header and footer parts are left alone, pictures and page numbers and all;
   * typing a new one replaces the part with that line.
   */
  originalSetup?: PageSetup | undefined;
  /** Review comments, which are written into Word's own comments part. */
  comments?: ExportedThread[] | undefined;
}

export interface ExportedComment {
  author: string;
  date: string;
  body: string;
}

export interface ExportedThread extends ExportedComment {
  anchor: CommentAnchor | null;
  resolved: boolean;
  replies: ExportedComment[];
}

interface Relationships {
  xml: XmlElement;
  next: number;
}

interface Context {
  parts: Record<string, Uint8Array>;
  fragments: Record<string, string>;
  rels: Relationships;
  contentTypes: XmlElement;
  /** Media already in the package, by a hash of its bytes. */
  mediaByHash: Map<string, string>;
  /** Numbering ids the package defines. */
  numIds: Set<string>;
  newNums: { numId: number; ordered: boolean }[];
  nextNumId: number;
  /** Style ids the package defines, and which of them are headings. */
  styleIds: Set<string>;
  headingStyle: Map<number, string>;
  headingLevelOfStyle: Map<string, number>;
  quoteStyle: string | null;
  listStyle: string | null;
  needsStyles: Set<string>;
  drawingId: number;
  changeId: number;
  /** The headings of the document being written, for a contents table. */
  outline: { level: number; text: string }[];
  parsedFragments: Map<string, XmlElement[]>;
}

const text = (parts: Record<string, Uint8Array>, name: string): string | undefined =>
  parts[name] ? strFromU8(parts[name]) : undefined;

/** Parse kept markup. It was written by this reader, so a failure means a stray reference. */
function fragment(ctx: Context, ref: unknown): XmlElement[] | null {
  if (typeof ref !== 'string') return null;
  const cached = ctx.parsedFragments.get(ref);
  if (cached) return cached;
  const xml = ctx.fragments[ref];
  if (xml === undefined) return null;
  try {
    const parsed = parseXml(`<x>${xml}</x>`).children.filter(isElement);
    ctx.parsedFragments.set(ref, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** Write a document into a copy of `base`. */
export function writeDocx(doc: PMNode, options: WriteOptions): Buffer {
  const parts = unzipSync(new Uint8Array(options.base));
  const mainXml = text(parts, 'word/document.xml');
  if (!mainXml) throw new Error('the base package has no main document part');
  const original = parseXml(mainXml);

  const relsXml = text(parts, 'word/_rels/document.xml.rels');
  const rels: Relationships = {
    xml: relsXml
      ? parseXml(relsXml)
      : el('Relationships', { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' }),
    next: 1,
  };
  for (const relationship of childrenNamed(rels.xml, 'Relationship')) {
    const number = Number(/^rId(\d+)$/u.exec(relationship.attrs['Id'] ?? '')?.[1] ?? 0);
    if (number >= rels.next) rels.next = number + 1;
  }

  const contentTypes = parseXml(text(parts, '[Content_Types].xml') ?? '<Types/>');
  const styles = parts['word/styles.xml'] ? parseXml(strFromU8(parts['word/styles.xml'])) : undefined;
  const numbering = parts['word/numbering.xml']
    ? parseXml(strFromU8(parts['word/numbering.xml']))
    : undefined;

  const ctx: Context = {
    parts,
    fragments: options.fragments,
    rels,
    contentTypes,
    mediaByHash: new Map(),
    numIds: new Set(childrenNamed(numbering, 'w:num').map((num) => num.attrs['w:numId'] ?? '')),
    newNums: [],
    nextNumId:
      Math.max(0, ...childrenNamed(numbering, 'w:num').map((num) => Number(num.attrs['w:numId']) || 0)) + 1,
    styleIds: new Set(),
    headingStyle: new Map(),
    headingLevelOfStyle: new Map(),
    quoteStyle: null,
    listStyle: null,
    needsStyles: new Set(),
    drawingId: 60000,
    changeId: 90000,
    outline: outline(doc),
    parsedFragments: new Map(),
  };
  readStyles(ctx, styles);
  for (const [name, bytes] of Object.entries(parts)) {
    if (name.startsWith('word/media/')) {
      ctx.mediaByHash.set(createHash('sha256').update(bytes).digest('hex'), name.slice('word/'.length));
    }
  }

  const body = child(original, 'w:body');
  const section = finalSection(body, options.pageSetup);
  applyRunningText(ctx, section, options.pageSetup, options.originalSetup);

  const commented = writeComments(ctx, writeNotes(ctx, doc), options.comments ?? []);
  const blocks = writeBlocks(ctx, commented.content ?? [], { depth: 0 });
  const root = { ...original.attrs };
  for (const [name, value] of Object.entries(NAMESPACES)) root[name] ??= value;
  const rootAttrs = Object.entries(root)
    .map(([name, value]) => ` ${name}="${escapeXmlAttr(value)}"`)
    .join('');

  parts['word/document.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document${rootAttrs}><w:body>${
      blocks.length > 0 ? blocks.join('') : '<w:p/>'
    }${serializeXml(section)}</w:body></w:document>`,
  );

  writeNumbering(ctx, numbering);
  writeStyles(ctx, styles);
  parts['word/_rels/document.xml.rels'] = xmlPart(rels.xml);
  parts['[Content_Types].xml'] = xmlPart(contentTypes);

  // The content types come first, as Word writes them. Most readers do not
  // care; the ones that stream the archive do.
  const ordered: Record<string, Uint8Array> = {
    '[Content_Types].xml': parts['[Content_Types].xml'],
  };
  for (const [name, bytes] of Object.entries(parts)) ordered[name] ??= bytes;
  return Buffer.from(zipSync(ordered, { level: 6 }));
}

const xmlPart = (root: XmlElement): Uint8Array<ArrayBuffer> =>
  strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${serializeXml(root)}`);

// ---------------------------------------------------------------- the package

function readStyles(ctx: Context, styles: XmlElement | undefined): void {
  for (const style of childrenNamed(styles, 'w:style')) {
    const id = style.attrs['w:styleId'];
    if (!id) continue;
    ctx.styleIds.add(id);
    if ((style.attrs['w:type'] ?? 'paragraph') !== 'paragraph') continue;
    const name = (attrOf(style, ['w:name'], 'w:val') ?? id).toLowerCase();
    const heading = /^heading\s*([1-6])$/u.exec(name.replace(/heading(\d)/u, 'heading $1'));
    const outline = Number(attrOf(style, ['w:pPr', 'w:outlineLvl'], 'w:val') ?? NaN);
    const level = heading ? Number(heading[1]) : Number.isInteger(outline) && outline <= 5 ? outline + 1 : null;
    if (level !== null) {
      ctx.headingLevelOfStyle.set(id, level);
      // The built-in heading wins over a house style at the same level.
      if (heading || !ctx.headingStyle.has(level)) ctx.headingStyle.set(level, id);
    }
    if (name === 'quote') ctx.quoteStyle = id;
    if (name === 'list paragraph') ctx.listStyle = id;
  }
}

function ensureContentType(ctx: Context, extension: string, type: string): void {
  const known = childrenNamed(ctx.contentTypes, 'Default').some(
    (entry) => (entry.attrs['Extension'] ?? '').toLowerCase() === extension,
  );
  if (!known) ctx.contentTypes.children.unshift(el('Default', { Extension: extension, ContentType: type }));
}

function ensureOverride(ctx: Context, partName: string, type: string): void {
  const known = childrenNamed(ctx.contentTypes, 'Override').some(
    (entry) => entry.attrs['PartName'] === partName,
  );
  if (!known) ctx.contentTypes.children.push(el('Override', { PartName: partName, ContentType: type }));
}

function addRelationship(ctx: Context, type: string, target: string, external = false): string {
  const existing = childrenNamed(ctx.rels.xml, 'Relationship').find(
    (relationship) =>
      relationship.attrs['Type'] === type &&
      relationship.attrs['Target'] === target &&
      (relationship.attrs['TargetMode'] === 'External') === external,
  );
  if (existing?.attrs['Id']) return existing.attrs['Id'];
  const id = `rId${ctx.rels.next}`;
  ctx.rels.next += 1;
  ctx.rels.xml.children.push(
    el('Relationship', { Id: id, Type: type, Target: target, ...(external ? { TargetMode: 'External' } : {}) }),
  );
  return id;
}

/** The closing section of the body, with the page turned if that was asked for. */
function finalSection(body: XmlElement | undefined, setup: PageSetup): XmlElement {
  const found = childrenNamed(body, 'w:sectPr').at(-1);
  const section: XmlElement = found
    ? (parseXml(serializeXml(found)))
    : el('w:sectPr', {}, [
        el('w:pgSz', { 'w:w': '11906', 'w:h': '16838' }),
        el('w:pgMar', {
          'w:top': '1440', 'w:right': '1440', 'w:bottom': '1440', 'w:left': '1440',
          'w:header': '708', 'w:footer': '708', 'w:gutter': '0',
        }),
      ]);
  let size = child(section, 'w:pgSz');
  if (!size) {
    size = el('w:pgSz', { 'w:w': '11906', 'w:h': '16838' });
    section.children.push(size);
  }
  const width = Number(size.attrs['w:w'] ?? 11906);
  const height = Number(size.attrs['w:h'] ?? 16838);
  const isLandscape = size.attrs['w:orient'] === 'landscape' || width > height;
  if ((setup.orientation === 'landscape') !== isLandscape) {
    size.attrs['w:w'] = String(height);
    size.attrs['w:h'] = String(width);
  }
  if (setup.orientation === 'landscape') size.attrs['w:orient'] = 'landscape';
  else delete size.attrs['w:orient'];
  return section;
}

/**
 * The running header and footer.
 *
 * Left alone while their text is what it was when the file was read, so a
 * letterhead survives. Replaced with one line when somebody has typed a
 * different one, and removed when they have cleared it.
 */
function applyRunningText(
  ctx: Context,
  section: XmlElement,
  setup: PageSetup,
  original: PageSetup | undefined,
): void {
  const kinds = [
    { key: 'header' as const, reference: 'w:headerReference', root: 'w:hdr', type: 'header' },
    { key: 'footer' as const, reference: 'w:footerReference', root: 'w:ftr', type: 'footer' },
  ];
  for (const kind of kinds) {
    const wanted = setup[kind.key];
    if (original && wanted === original[kind.key]) continue;
    section.children = section.children.filter(
      (node) => !isElement(node) || node.name !== kind.reference,
    );
    if (!wanted) continue;

    // Named as Word names them, header1.xml and so on, because that is the
    // pattern every reader looks for, this project's included.
    let index = 1;
    while (ctx.parts[`word/${kind.type}${index}.xml`]) index += 1;
    const partName = `${kind.type}${index}.xml`;
    ctx.parts[`word/${partName}`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${kind.root} xmlns:w="${NAMESPACES['xmlns:w']}" xmlns:r="${REL}"><w:p><w:pPr><w:pStyle w:val="${
        kind.type === 'header' ? 'Header' : 'Footer'
      }"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXmlText(wanted)}</w:t></w:r></w:p></${kind.root}>`,
    );
    ensureOverride(
      ctx,
      `/word/${partName}`,
      `application/vnd.openxmlformats-officedocument.wordprocessingml.${kind.type}+xml`,
    );
    const id = addRelationship(ctx, `${REL}/${kind.type}`, partName);
    section.children.unshift(el(kind.reference, { 'w:type': 'default', 'r:id': id }));
  }
}

const BULLETS = ['•', 'o', '▪'];

/** Add the numbering that lists made in the editor need. */
function writeNumbering(ctx: Context, numbering: XmlElement | undefined): void {
  if (ctx.newNums.length === 0) return;
  const root =
    numbering ??
    el('w:numbering', { 'xmlns:w': NAMESPACES['xmlns:w'] as string });
  const abstractIds = childrenNamed(root, 'w:abstractNum').map(
    (entry) => Number(entry.attrs['w:abstractNumId']) || 0,
  );
  let nextAbstract = Math.max(-1, ...abstractIds) + 1;
  const levels = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const abstractFor = (ordered: boolean): number => {
    const id = nextAbstract;
    nextAbstract += 1;
    const formats = ['decimal', 'lowerLetter', 'lowerRoman'];
    const abstract = el('w:abstractNum', { 'w:abstractNumId': String(id) }, [
      el('w:multiLevelType', { 'w:val': 'hybridMultilevel' }),
      ...levels.map((level) =>
        el('w:lvl', { 'w:ilvl': String(level) }, [
          el('w:start', { 'w:val': '1' }),
          el('w:numFmt', { 'w:val': ordered ? (formats[level % 3] as string) : 'bullet' }),
          el('w:lvlText', { 'w:val': ordered ? `%${level + 1}.` : (BULLETS[level % 3] as string) }),
          el('w:lvlJc', { 'w:val': 'left' }),
          el('w:pPr', {}, [el('w:ind', { 'w:left': String(720 * (level + 1)), 'w:hanging': '360' })]),
          ...(ordered || level % 3 !== 1
            ? []
            : [el('w:rPr', {}, [el('w:rFonts', { 'w:ascii': 'Courier New', 'w:hAnsi': 'Courier New', 'w:hint': 'default' })])]),
        ]),
      ),
    ]);
    // Every abstract definition comes before the first instance of one.
    const firstNum = root.children.findIndex((node) => isElement(node) && node.name === 'w:num');
    if (firstNum === -1) root.children.push(abstract);
    else root.children.splice(firstNum, 0, abstract);
    return id;
  };

  const bullets = ctx.newNums.some((entry) => !entry.ordered) ? abstractFor(false) : -1;
  const ordered = ctx.newNums.some((entry) => entry.ordered) ? abstractFor(true) : -1;
  for (const entry of ctx.newNums) {
    root.children.push(
      el('w:num', { 'w:numId': String(entry.numId) }, [
        el('w:abstractNumId', { 'w:val': String(entry.ordered ? ordered : bullets) }),
        // Each list made in the editor counts from one. Sharing one instance
        // made the second list of a document carry on from the first.
        ...(entry.ordered
          ? levels.map((level) =>
              el('w:lvlOverride', { 'w:ilvl': String(level) }, [el('w:startOverride', { 'w:val': '1' })]),
            )
          : []),
      ]),
    );
  }
  ctx.parts['word/numbering.xml'] = xmlPart(root);
  if (!numbering) {
    ensureOverride(
      ctx,
      '/word/numbering.xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
    );
    addRelationship(ctx, `${REL}/numbering`, 'numbering.xml');
  }
}

/** Define the styles the body names and the package does not have. */
function writeStyles(ctx: Context, styles: XmlElement | undefined): void {
  if (ctx.needsStyles.size === 0) return;
  const root = styles ?? el('w:styles', { 'xmlns:w': NAMESPACES['xmlns:w'] as string });
  const sizes = [32, 26, 24, 22, 22, 22];
  for (const id of ctx.needsStyles) {
    if (ctx.styleIds.has(id)) continue;
    const heading = /^Heading([1-6])$/u.exec(id);
    if (heading) {
      const level = Number(heading[1]);
      root.children.push(
        el('w:style', { 'w:type': 'paragraph', 'w:styleId': id }, [
          el('w:name', { 'w:val': `heading ${level}` }),
          el('w:basedOn', { 'w:val': 'Normal' }),
          el('w:next', { 'w:val': 'Normal' }),
          el('w:qFormat'),
          el('w:pPr', {}, [
            el('w:keepNext'),
            el('w:spacing', { 'w:before': '240', 'w:after': '80' }),
            el('w:outlineLvl', { 'w:val': String(level - 1) }),
          ]),
          el('w:rPr', {}, [el('w:b'), el('w:sz', { 'w:val': String(sizes[level - 1]) })]),
        ]),
      );
    } else if (id === 'Quote') {
      root.children.push(
        el('w:style', { 'w:type': 'paragraph', 'w:styleId': 'Quote' }, [
          el('w:name', { 'w:val': 'Quote' }),
          el('w:basedOn', { 'w:val': 'Normal' }),
          el('w:qFormat'),
          el('w:pPr', {}, [el('w:ind', { 'w:left': '720' })]),
          el('w:rPr', {}, [el('w:i')]),
        ]),
      );
    }
  }
  ctx.parts['word/styles.xml'] = xmlPart(root);
  if (!styles) {
    ensureOverride(
      ctx,
      '/word/styles.xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
    );
    addRelationship(ctx, `${REL}/styles`, 'styles.xml');
  }
}

// ------------------------------------------------------------------- the body

interface ListContext {
  numId: string;
  level: number;
}

interface BlockContext {
  depth: number;
  list?: ListContext;
  /** True for the first paragraph of a list item, which carries the number. */
  numbered?: boolean;
  /** How many quotations deep this is, each one an indent. */
  quoted?: number;
}

/** A run of sibling blocks. A page break belongs to whatever follows it. */
function writeBlocks(ctx: Context, nodes: PMNode[], block: BlockContext): string[] {
  const out: string[] = [];
  let breakBefore = false;
  let numbered = block.numbered ?? false;
  for (const node of nodes) {
    if (node.type === NODE.pageBreak) {
      breakBefore = true;
      continue;
    }
    const written = writeBlock(ctx, node, { ...block, numbered }, breakBefore);
    if (written.length > 0) {
      breakBefore = false;
      if (node.type === NODE.paragraph || node.type === NODE.heading) numbered = false;
    }
    out.push(...written);
  }
  // A break with nothing after it still has to be written down.
  if (breakBefore) out.push('<w:p><w:pPr><w:pageBreakBefore/></w:pPr></w:p>');
  return out;
}

const BREAK_PARAGRAPH = '<w:p><w:pPr><w:pageBreakBefore/></w:pPr></w:p>';

function writeBlock(ctx: Context, node: PMNode, block: BlockContext, breakBefore: boolean): string[] {
  if (block.depth > 60) return [];
  const deeper = { ...block, depth: block.depth + 1 };
  switch (node.type) {
    case NODE.paragraph:
    case NODE.heading:
      return [writeParagraph(ctx, node, block, breakBefore)];
    case NODE.blockquote: {
      const inner = writeBlocks(ctx, node.content ?? [], { ...deeper, quoted: (block.quoted ?? 0) + 1 });
      return breakBefore && inner.length > 0 ? [BREAK_PARAGRAPH, ...inner] : inner;
    }
    case NODE.bulletList:
    case NODE.orderedList: {
      const list = listContext(ctx, node, block);
      const inner: string[] = [];
      for (const item of node.content ?? []) {
        inner.push(...writeBlocks(ctx, item.content ?? [], { ...deeper, list, numbered: true }));
      }
      return breakBefore && inner.length > 0 ? [BREAK_PARAGRAPH, ...inner] : inner;
    }
    case NODE.table: {
      const table = writeTable(ctx, node, deeper);
      // A table cannot carry a break of its own, so it gets one in front.
      return table ? (breakBefore ? [BREAK_PARAGRAPH, table] : [table]) : [];
    }
    case NODE.horizontalRule:
      return [
        `<w:p><w:pPr>${breakBefore ? '<w:pageBreakBefore/>' : ''}<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>`,
      ];
    case NODE.wordBlock: {
      const kept = fragment(ctx, node.attrs?.['ref']);
      if (!kept && node.attrs?.['kind'] === 'toc') {
        const contents = writeContents(ctx);
        return breakBefore ? [BREAK_PARAGRAPH, ...contents] : contents;
      }
      const label = typeof node.attrs?.['label'] === 'string' ? node.attrs['label'] : '';
      const written = kept
        ? kept.map(serializeXml)
        : label.split('\n').map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXmlText(line)}</w:t></w:r></w:p>`);
      return breakBefore ? [BREAK_PARAGRAPH, ...written] : written;
    }
    default:
      return writeBlocks(ctx, node.content ?? [], deeper);
  }
}

/**
 * A contents table made in the editor, written as the field Word builds its
 * own from. The entries are the headings as they stand, so the file reads
 * properly anywhere; the field is marked as needing an update, so that Word
 * fills in the page numbers, which only a program that lays out pages can know.
 */
function writeContents(ctx: Context): string[] {
  const entries = ctx.outline.filter((entry) => entry.level <= 3 && entry.text.trim().length > 0).slice(0, 500);
  const line = (entry: { level: number; text: string }): string =>
    `<w:pPr>${
      ctx.styleIds.has(`TOC${entry.level}`)
        ? `<w:pStyle w:val="TOC${entry.level}"/>`
        : `<w:ind w:left="${(entry.level - 1) * 240}"/>`
    }</w:pPr>`;
  const begin =
    '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
  const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  if (entries.length === 0) {
    return [`<w:p>${begin}<w:r><w:t>No headings yet.</w:t></w:r>${end}</w:p>`];
  }
  return entries.map((entry, index) => {
    const words = `<w:r><w:t xml:space="preserve">${escapeXmlText(entry.text)}</w:t></w:r>`;
    return `<w:p>${line(entry)}${index === 0 ? begin : ''}${words}${index === entries.length - 1 ? end : ''}</w:p>`;
  });
}

/** The numbering a list writes its items with. */
function listContext(ctx: Context, node: PMNode, block: BlockContext): ListContext {
  const ordered = node.type === NODE.orderedList;
  const kept = typeof node.attrs?.['numId'] === 'string' ? node.attrs['numId'] : null;
  const keptLevel = Number(node.attrs?.['numLevel']);
  if (kept && ctx.numIds.has(kept)) {
    // The numbering it arrived with, at the level it arrived at.
    const level = Number.isInteger(keptLevel) && keptLevel >= 0 && keptLevel <= 8
      ? keptLevel
      : block.list
        ? block.list.level + 1
        : 0;
    return { numId: kept, level };
  }
  if (block.list && ctx.newNums.some((entry) => String(entry.numId) === block.list?.numId && entry.ordered === ordered)) {
    return { numId: block.list.numId, level: Math.min(8, block.list.level + 1) };
  }
  const numId = ctx.nextNumId;
  ctx.nextNumId += 1;
  ctx.newNums.push({ numId, ordered });
  return { numId: String(numId), level: block.list ? Math.min(8, block.list.level + 1) : 0 };
}

const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function writeParagraph(ctx: Context, node: PMNode, block: BlockContext, breakBefore: boolean): string {
  const attrs = node.attrs ?? {};
  const kept = fragment(ctx, attrs['pprRef']) ?? [];
  const properties = kept.map((element) => parseXml(serializeXml(element)));
  const drop = (...names: string[]): void => {
    for (let index = properties.length - 1; index >= 0; index -= 1) {
      if (names.includes((properties[index] as XmlElement).name)) properties.splice(index, 1);
    }
  };

  // The style: the one it had, unless it no longer says what the node is.
  let styleId = typeof attrs['styleId'] === 'string' && attrs['styleId'] ? attrs['styleId'] : null;
  if (node.type === NODE.heading) {
    const level = Math.min(6, Math.max(1, Number(attrs['level'] ?? 1) || 1));
    if (!styleId || ctx.headingLevelOfStyle.get(styleId) !== level) {
      styleId = ctx.headingStyle.get(level) ?? `Heading${level}`;
    }
  } else if (styleId && ctx.headingLevelOfStyle.has(styleId)) {
    // A heading turned back into body text must not keep the heading's style.
    styleId = null;
  }
  if (!styleId && block.quoted) styleId = ctx.quoteStyle ?? 'Quote';
  if (!styleId && block.list && ctx.listStyle) styleId = ctx.listStyle;
  if (styleId && !ctx.styleIds.has(styleId)) {
    if (/^Heading[1-6]$/u.test(styleId) || styleId === 'Quote') ctx.needsStyles.add(styleId);
    else styleId = null;
  }
  if (styleId) properties.push(el('w:pStyle', { 'w:val': styleId }));
  if (breakBefore) properties.push(el('w:pageBreakBefore'));

  if (block.list) {
    drop('w:numPr');
    if (block.numbered) {
      properties.push(
        el('w:numPr', {}, [
          el('w:ilvl', { 'w:val': String(block.list.level) }),
          el('w:numId', { 'w:val': block.list.numId }),
        ]),
      );
    }
  }

  const align = typeof attrs['textAlign'] === 'string' ? attrs['textAlign'] : '';
  const jc = { left: 'left', center: 'center', right: 'right', justify: 'both' }[align];
  if (jc) properties.push(el('w:jc', { 'w:val': jc }));

  const indent: Record<string, string> = {};
  const left = number(attrs['indentLeft']);
  const right = number(attrs['indentRight']);
  const first = number(attrs['indentFirstLine']);
  if (left !== null) indent['w:left'] = String(Math.round(left));
  else if (block.list && !block.numbered) indent['w:left'] = String(720 * (block.list.level + 1));
  // Stated as well as styled, so a quotation inside a table cell, where the
  // style's indent is measured from the cell, still reads as one.
  else if (block.quoted) indent['w:left'] = String(720 * block.quoted);
  if (right !== null) indent['w:right'] = String(Math.round(right));
  if (first !== null && first < 0) indent['w:hanging'] = String(Math.round(-first));
  else if (first !== null) indent['w:firstLine'] = String(Math.round(first));
  if (Object.keys(indent).length > 0) properties.push(el('w:ind', indent));

  const spacing: Record<string, string> = {};
  const before = number(attrs['spacingBefore']);
  const after = number(attrs['spacingAfter']);
  const lineHeight = number(attrs['lineHeight']);
  const lineExact = number(attrs['lineExact']);
  if (before !== null) spacing['w:before'] = String(Math.max(0, Math.round(before)));
  if (after !== null) spacing['w:after'] = String(Math.max(0, Math.round(after)));
  if (lineHeight !== null && lineHeight > 0) {
    spacing['w:line'] = String(Math.round(lineHeight * 240));
    spacing['w:lineRule'] = 'auto';
  } else if (lineExact !== null && lineExact > 0) {
    spacing['w:line'] = String(Math.round(lineExact));
    spacing['w:lineRule'] = 'exact';
  }
  if (Object.keys(spacing).length > 0) properties.push(el('w:spacing', spacing));

  const pPr = properties.length > 0 ? serializeXml(el('w:pPr', {}, inOrder(properties, PPR_ORDER))) : '';
  return `<w:p>${pPr}${writeInline(ctx, node.content ?? [])}</w:p>`;
}

// --------------------------------------------------------------------- inline

const markSet = (marks: PMMark[] | undefined): Map<string, Record<string, unknown>> => {
  const map = new Map<string, Record<string, unknown>>();
  for (const mark of marks ?? []) map.set(mark.type, mark.attrs ?? {});
  return map;
};

const hrefOf = (node: PMNode): string | null => {
  const href = node.marks?.find((mark) => mark.type === MARK.link)?.attrs?.['href'];
  return typeof href === 'string' && isSafeHref(href) ? href : null;
};

const changeOf = (node: PMNode): PMMark | undefined =>
  node.marks?.find((mark) => mark.type === MARK.insertion || mark.type === MARK.deletion);

const changeKey = (node: PMNode): string => {
  const change = changeOf(node);
  return change ? `${change.type}|${String(change.attrs?.['author'])}|${String(change.attrs?.['date'])}` : '';
};

/**
 * A stretch of inline content, with tracked changes written as Word writes
 * them: neighbouring runs of one change inside one `w:ins` or `w:del`, and the
 * text of a deletion as `w:delText`, which is what makes Word strike it out
 * rather than show it.
 */
function writeRuns(ctx: Context, nodes: PMNode[]): string {
  let out = '';
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index] as PMNode;
    const change = changeOf(node);
    // The comment markers sit between runs, never inside a change.
    if (!change || node.type === COMMENT_START || node.type === COMMENT_END) {
      out += writeInlineNode(ctx, node);
      continue;
    }
    const key = changeKey(node);
    let inner = '';
    let cursor = index;
    while (cursor < nodes.length && changeKey(nodes[cursor] as PMNode) === key) {
      inner += writeInlineNode(ctx, nodes[cursor] as PMNode);
      cursor += 1;
    }
    index = cursor - 1;
    const deleted = change.type === MARK.deletion;
    if (deleted) inner = inner.replace(/<w:t( [^>]*)?>/gu, '<w:delText$1>').replace(/<\/w:t>/gu, '</w:delText>');
    ctx.changeId += 1;
    const author = typeof change.attrs?.['author'] === 'string' ? change.attrs['author'] : 'Unknown';
    const date = typeof change.attrs?.['date'] === 'string' && change.attrs['date'] ? change.attrs['date'] : '';
    const tag = deleted ? 'w:del' : 'w:ins';
    out += `<${tag} w:id="${ctx.changeId}" w:author="${escapeXmlAttr(author)}"${
      date ? ` w:date="${escapeXmlAttr(date.replace(/\.\d+Z$/u, 'Z'))}"` : ''
    }>${inner}</${tag}>`;
  }
  return out;
}

function writeInline(ctx: Context, nodes: PMNode[]): string {
  let out = '';
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index] as PMNode;
    const href = hrefOf(node);
    if (href === null || (!/^(?:https?:|mailto:)/iu.test(href) && !href.startsWith('#'))) {
      // Everything up to the next link goes out together, so that a change
      // running over several runs is one change.
      let cursor = index;
      while (cursor < nodes.length) {
        const next = hrefOf(nodes[cursor] as PMNode);
        if (next !== null && (/^(?:https?:|mailto:)/iu.test(next) || next.startsWith('#'))) break;
        cursor += 1;
      }
      out += writeRuns(ctx, nodes.slice(index, cursor));
      index = cursor - 1;
      continue;
    }
    // Every neighbouring run with the same target is one link, as Word has it.
    let cursor = index;
    while (cursor < nodes.length && hrefOf(nodes[cursor] as PMNode) === href) cursor += 1;
    const inner = writeRuns(ctx, nodes.slice(index, cursor));
    index = cursor - 1;
    out += href.startsWith('#')
      ? `<w:hyperlink w:anchor="${escapeXmlAttr(href.slice(1))}" w:history="1">${inner}</w:hyperlink>`
      : `<w:hyperlink r:id="${addRelationship(ctx, `${REL}/hyperlink`, href, true)}" w:history="1">${inner}</w:hyperlink>`;
  }
  return out;
}

function writeInlineNode(ctx: Context, node: PMNode): string {
  switch (node.type) {
    case NODE.text:
      return writeText(ctx, node);
    case NODE.hardBreak:
      return '<w:r><w:br/></w:r>';
    case NODE.image:
      return writeImage(ctx, node);
    case COMMENT_START:
      return `<w:commentRangeStart w:id="${escapeXmlAttr(String(node.attrs?.['id']))}"/>`;
    case COMMENT_END: {
      const id = escapeXmlAttr(String(node.attrs?.['id']));
      return `<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`;
    }
    case NODE.wordInline: {
      const kind = node.attrs?.['kind'];
      if ((kind === 'footnote' || kind === 'endnote') && typeof node.attrs?.['newNoteId'] === 'string') {
        // A note made here: the mark in the text. The note itself is in its part.
        const tag = kind === 'footnote' ? 'w:footnoteReference' : 'w:endnoteReference';
        return `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><${tag} w:id="${escapeXmlAttr(node.attrs['newNoteId'])}"/></w:r>`;
      }
      const kept = fragment(ctx, node.attrs?.['ref']);
      if (kept && kind === 'control') return filledControl(kept, node).map(serializeXml).join('');
      if (kept) return kept.map(serializeXml).join('');
      const label = typeof node.attrs?.['label'] === 'string' ? node.attrs['label'] : '';
      return label ? `<w:r><w:t xml:space="preserve">${escapeXmlText(label)}</w:t></w:r>` : '';
    }
    default:
      return (node.content ?? []).map((inner) => writeInlineNode(ctx, inner)).join('');
  }
}

const isOff = (element: XmlElement | undefined): boolean => {
  const value = element?.attrs['w:val'];
  return value === '0' || value === 'false' || value === 'off' || value === 'none';
};

/** The named highlight nearest to a colour, since Word has sixteen and no more. */
function highlightName(colour: unknown): string {
  const hex = typeof colour === 'string' ? /^#?([0-9a-f]{6})$/iu.exec(colour.trim())?.[1] : undefined;
  if (!hex) return 'yellow';
  const channels = (value: string): number[] => [0, 2, 4].map((at) => Number.parseInt(value.slice(at, at + 2), 16));
  const wanted = channels(hex);
  let best = 'yellow';
  let distance = Infinity;
  for (const [name, value] of Object.entries(HIGHLIGHTS)) {
    const candidate = channels(value.slice(1));
    const gap = candidate.reduce((sum, channel, i) => sum + (channel - (wanted[i] as number)) ** 2, 0);
    if (gap < distance) {
      distance = gap;
      best = name;
    }
  }
  return best;
}

function runProperties(ctx: Context, marks: PMMark[] | undefined): string {
  const set = markSet(marks);
  const word = set.get(MARK.wordRun);
  const properties = (fragment(ctx, word?.['ref']) ?? []).map((element) => parseXml(serializeXml(element)));
  const find = (name: string): XmlElement | undefined => properties.find((element) => element.name === name);
  const drop = (...names: string[]): void => {
    for (let index = properties.length - 1; index >= 0; index -= 1) {
      if (names.includes((properties[index] as XmlElement).name)) properties.splice(index, 1);
    }
  };

  // A property that can be on or off. A mark means on. No mark means whatever
  // the style says, unless the file switched it explicitly off, which is kept:
  // dropping that made a plain word inside a bold heading come back bold.
  const toggle = (mark: string, ...names: string[]): void => {
    if (set.has(mark)) {
      drop(...names);
      for (const name of names) properties.push(el(name));
    } else if (!isOff(find(names[0] as string))) {
      drop(...names);
    }
  };
  toggle(MARK.bold, 'w:b', 'w:bCs');
  toggle(MARK.italic, 'w:i', 'w:iCs');
  toggle(MARK.strike, 'w:strike');

  const isLink = set.has(MARK.link);
  const underline = find('w:u');
  if (set.has(MARK.underline) || (isLink && !find('w:rStyle'))) {
    // The kind of underline it had is kept; only a missing one is supplied.
    if (!underline || isOff(underline)) {
      drop('w:u');
      properties.push(el('w:u', { 'w:val': 'single' }));
    }
  } else if (underline && !isOff(underline)) {
    drop('w:u');
  }

  drop('w:vertAlign');
  if (set.has(MARK.superscript)) properties.push(el('w:vertAlign', { 'w:val': 'superscript' }));
  else if (set.has(MARK.subscript)) properties.push(el('w:vertAlign', { 'w:val': 'subscript' }));

  drop('w:highlight');
  const highlight = set.get(MARK.highlight);
  if (highlight) properties.push(el('w:highlight', { 'w:val': highlightName(highlight['color']) }));

  const style = set.get(MARK.textStyle) ?? {};
  const colour = typeof style['color'] === 'string' ? style['color'].replace('#', '') : '';
  drop('w:color');
  if (/^[0-9a-f]{6}$/iu.test(colour)) properties.push(el('w:color', { 'w:val': colour.toUpperCase() }));
  else if (isLink && !find('w:rStyle')) properties.push(el('w:color', { 'w:val': '0563C1' }));

  const stated = style['fontSize'];
  const size = Number((typeof stated === 'string' ? stated : '').replace(/[^\d.]/gu, ''));
  drop('w:sz', 'w:szCs');
  if (Number.isFinite(size) && size > 0 && size < 1000) {
    const halfPoints = String(Math.round(size * 2));
    properties.push(el('w:sz', { 'w:val': halfPoints }), el('w:szCs', { 'w:val': halfPoints }));
  }

  // The font. A theme font the reader resolved is left as the theme reference
  // it was, unless somebody has since chosen a different font.
  const family = typeof style['fontFamily'] === 'string' ? style['fontFamily'] : '';
  const face = family.split(',')[0]?.replace(/["']/gu, '').trim() ?? '';
  const fonts = find('w:rFonts');
  const named = fonts?.attrs['w:ascii'] ?? fonts?.attrs['w:hAnsi'];
  const themed = Boolean(fonts?.attrs['w:asciiTheme'] ?? fonts?.attrs['w:hAnsiTheme']);
  if (face && face !== named && !(themed && face === word?.['font'])) {
    drop('w:rFonts');
    properties.push(
      el('w:rFonts', {
        'w:ascii': face,
        'w:hAnsi': face,
        'w:cs': face,
        ...(fonts?.attrs['w:eastAsia'] ? { 'w:eastAsia': fonts.attrs['w:eastAsia'] } : {}),
      }),
    );
  } else if (!face && fonts && named) {
    drop('w:rFonts');
  }

  if (properties.length === 0) return '';
  return serializeXml(el('w:rPr', {}, inOrder(properties, RPR_ORDER)));
}

const SOFT_HYPHEN = String.fromCodePoint(0xad);
const NON_BREAKING_HYPHEN = String.fromCodePoint(0x2011);
const SPECIAL_CHARACTERS = new RegExp(`(\\t|${SOFT_HYPHEN}|${NON_BREAKING_HYPHEN})`, 'u');

function writeText(ctx: Context, node: PMNode): string {
  const value = node.text ?? '';
  if (value.length === 0) return '';
  const properties = runProperties(ctx, node.marks);
  // A tab, a soft hyphen and a non-breaking hyphen are elements in Word, not
  // characters in the text. Written as characters they mostly work, and then a
  // font without the glyph draws a box where the hyphen should be.
  let inner = '';
  for (const piece of value.split(SPECIAL_CHARACTERS)) {
    if (piece === '\t') inner += '<w:tab/>';
    else if (piece === SOFT_HYPHEN) inner += '<w:softHyphen/>';
    else if (piece === NON_BREAKING_HYPHEN) inner += '<w:noBreakHyphen/>';
    else if (piece.length > 0) inner += `<w:t xml:space="preserve">${escapeXmlText(piece)}</w:t>`;
  }
  return `<w:r>${properties}${inner}</w:r>`;
}

const IMAGE_EXTENSIONS: Record<string, { extension: string; type: string }> = {
  png: { extension: 'png', type: 'image/png' },
  jpeg: { extension: 'jpeg', type: 'image/jpeg' },
  jpg: { extension: 'jpeg', type: 'image/jpeg' },
  gif: { extension: 'gif', type: 'image/gif' },
  bmp: { extension: 'bmp', type: 'image/bmp' },
};

function writeImage(ctx: Context, node: PMNode): string {
  const attrs = node.attrs ?? {};
  const width = dimension(attrs['width']);
  const height = dimension(attrs['height']);

  // The drawing it arrived as: floating, cropped, framed or plain. Put back as
  // it was, at the size the editor now shows it.
  const kept = fragment(ctx, attrs['wordRef']);
  if (kept) {
    const clones = kept.map((element) => parseXml(serializeXml(element)));
    const extent = clones.flatMap((element) => descendants(element, 'wp:extent'))[0];
    if (extent && width && height) {
      const was = [Number(extent.attrs['cx']), Number(extent.attrs['cy'])];
      const now = [width * EMU_PER_PIXEL, height * EMU_PER_PIXEL];
      // Only when somebody resized it: converting to pixels and back would
      // otherwise nudge every picture by a fraction on every export.
      if (Math.abs((was[0] as number) - (now[0] as number)) > EMU_PER_PIXEL ||
          Math.abs((was[1] as number) - (now[1] as number)) > EMU_PER_PIXEL) {
        extent.attrs['cx'] = String(now[0]);
        extent.attrs['cy'] = String(now[1]);
        for (const size of clones.flatMap((element) => descendants(element, 'a:ext'))) {
          if (size.attrs['cx'] !== undefined) {
            size.attrs['cx'] = String(now[0]);
            size.attrs['cy'] = String(now[1]);
          }
        }
      }
    }
    const xml = clones.map(serializeXml).join('');
    return clones[0]?.name === 'w:r' ? xml : `<w:r>${xml}</w:r>`;
  }

  const src = typeof attrs['src'] === 'string' ? attrs['src'] : '';
  const match = /^data:image\/(png|jpe?g|gif|bmp);base64,(.+)$/iu.exec(src);
  if (!match) return '';
  const kind = IMAGE_EXTENSIONS[(match[1] as string).toLowerCase()];
  if (!kind) return '';
  let bytes: Buffer;
  try {
    bytes = Buffer.from(match[2] as string, 'base64');
  } catch {
    return '';
  }
  if (bytes.length === 0) return '';

  const hash = createHash('sha256').update(bytes).digest('hex');
  let target = ctx.mediaByHash.get(hash);
  if (!target) {
    target = `media/df-${hash.slice(0, 16)}.${kind.extension}`;
    ctx.parts[`word/${target}`] = new Uint8Array(bytes);
    ctx.mediaByHash.set(hash, target);
    ensureContentType(ctx, kind.extension, kind.type);
  }
  const id = addRelationship(ctx, `${REL}/image`, target);

  const measured = width && height ? null : measureImage(src);
  let cx = width ?? measured?.width ?? 400;
  let cy = height ?? measured?.height ?? 300;
  // Wider than the text area is wider than the page.
  const limit = Math.round(TEXT_WIDTH_DXA / DXA_PER_PIXEL);
  if (cx > limit) {
    cy = Math.max(1, Math.round((cy * limit) / cx));
    cx = limit;
  }
  ctx.drawingId += 1;
  const drawingId = ctx.drawingId;
  const alt = typeof attrs['alt'] === 'string' ? attrs['alt'] : '';
  const emuX = cx * EMU_PER_PIXEL;
  const emuY = cy * EMU_PER_PIXEL;
  return (
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${emuX}" cy="${emuY}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${drawingId}" name="Picture ${drawingId}" descr="${escapeXmlAttr(alt)}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${NAMESPACES['xmlns:a']}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="${NAMESPACES['xmlns:a']}"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="${NAMESPACES['xmlns:pic']}"><pic:nvPicPr><pic:cNvPr id="${drawingId}" name="Picture ${drawingId}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emuX}" cy="${emuY}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  );
}

function dimension(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 20000 ? parsed : null;
}

// --------------------------------------------------------------------- tables

const span = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_SPAN ? parsed : 1;
};

const DEFAULT_BORDERS =
  '<w:tblBorders>' +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`)
    .join('') +
  '</w:tblBorders>';

function writeTable(ctx: Context, table: PMNode, block: BlockContext): string | null {
  const rows = (table.content ?? []).filter((row) => (row.content ?? []).length > 0);
  if (rows.length === 0) return null;

  // Lay the cells on a grid first. A cell merged downwards takes a place in
  // each row it covers, and Word wants a cell written there that says so.
  interface Placed {
    cell: PMNode | null;
    column: number;
    span: number;
    merge: 'restart' | 'continue' | null;
    source: PMNode | null;
  }
  const carried = new Map<number, { left: number; span: number; source: PMNode }>();
  const grid: Placed[][] = [];
  let columns = 0;
  for (const row of rows) {
    const placed: Placed[] = [];
    const cells = [...(row.content ?? [])];
    let column = 0;
    while (cells.length > 0 || [...carried.keys()].some((at) => at >= column)) {
      const above = carried.get(column);
      if (above) {
        placed.push({ cell: null, column, span: above.span, merge: 'continue', source: above.source });
        above.left -= 1;
        if (above.left <= 0) carried.delete(column);
        column += above.span;
        continue;
      }
      const cell = cells.shift();
      if (!cell) break;
      const columnSpan = span(cell.attrs?.['colspan']);
      const rowSpan = span(cell.attrs?.['rowspan']);
      placed.push({ cell, column, span: columnSpan, merge: rowSpan > 1 ? 'restart' : null, source: cell });
      if (rowSpan > 1) carried.set(column, { left: rowSpan - 1, span: columnSpan, source: cell });
      column += columnSpan;
      if (column > 4000) break;
    }
    columns = Math.max(columns, column);
    grid.push(placed);
  }
  if (columns === 0) return null;

  // Column widths: what the editor holds, else the grid it arrived on, else an
  // even share of the page.
  const widths: (number | null)[] = Array.from({ length: columns }, () => null);
  for (const placed of grid) {
    for (const entry of placed) {
      const stated = entry.cell?.attrs?.['colwidth'];
      if (!Array.isArray(stated)) continue;
      stated.slice(0, entry.span).forEach((pixels, offset) => {
        if (typeof pixels === 'number' && pixels > 0 && widths[entry.column + offset] === null) {
          widths[entry.column + offset] = Math.round(pixels * DXA_PER_PIXEL);
        }
      });
    }
  }
  const keptGrid = fragment(ctx, table.attrs?.['gridRef']);
  if (widths.some((width) => width === null) && keptGrid && keptGrid.length === columns) {
    keptGrid.forEach((column, index) => {
      const dxa = Number(column.attrs['w:w']);
      if (widths[index] === null && Number.isFinite(dxa) && dxa > 0) widths[index] = dxa;
    });
  }
  const share = Math.max(200, Math.floor(TEXT_WIDTH_DXA / columns));
  const resolved = widths.map((width) => width ?? share);

  const keptProperties = fragment(ctx, table.attrs?.['tblRef']);
  const tblPr = keptProperties
    ? keptProperties.map(serializeXml).join('')
    : `<w:tblW w:w="5000" w:type="pct"/>${DEFAULT_BORDERS}<w:tblLayout w:type="autofit"/>`;

  let out = `<w:tbl><w:tblPr>${tblPr}</w:tblPr><w:tblGrid>${resolved
    .map((width) => `<w:gridCol w:w="${width}"/>`)
    .join('')}</w:tblGrid>`;

  grid.forEach((placed, rowIndex) => {
    const row = rows[rowIndex] as PMNode;
    const rowProperties = (fragment(ctx, row.attrs?.['trRef']) ?? []).map((element) =>
      parseXml(serializeXml(element)),
    );
    const isHeaderRow = placed.some((entry) => entry.cell?.type === NODE.tableHeader);
    if (isHeaderRow && !rowProperties.some((element) => element.name === 'w:tblHeader')) {
      rowProperties.push(el('w:tblHeader'));
    }
    out += `<w:tr>${rowProperties.length > 0 ? serializeXml(el('w:trPr', {}, rowProperties)) : ''}`;

    for (const entry of placed) {
      const source = entry.source;
      const properties = (fragment(ctx, source?.attrs?.['tcRef']) ?? []).map((element) =>
        parseXml(serializeXml(element)),
      );
      const width = resolved.slice(entry.column, entry.column + entry.span).reduce((sum, w) => sum + w, 0);
      properties.push(el('w:tcW', { 'w:w': String(width), 'w:type': 'dxa' }));
      if (entry.span > 1) properties.push(el('w:gridSpan', { 'w:val': String(entry.span) }));
      if (entry.merge) properties.push(el('w:vMerge', entry.merge === 'restart' ? { 'w:val': 'restart' } : {}));
      const fill =
        typeof source?.attrs?.['background'] === 'string'
          ? /^#?([0-9a-f]{6})$/iu.exec(source.attrs['background'].trim())?.[1]
          : undefined;
      if (fill) properties.push(el('w:shd', { 'w:val': 'clear', 'w:color': 'auto', 'w:fill': fill.toUpperCase() }));

      const content = entry.cell
        ? writeBlocks(ctx, entry.cell.content ?? [], {
            depth: block.depth + 1,
            ...(block.quoted ? { quoted: block.quoted } : {}),
          })
        : [];
      // A cell must end in a paragraph, or Word calls the file corrupt.
      if (content.length === 0 || !(content.at(-1) as string).startsWith('<w:p>') && !(content.at(-1) as string).startsWith('<w:p ')) {
        content.push('<w:p/>');
      }
      out += `<w:tc>${serializeXml(el('w:tcPr', {}, inOrder(properties, TCPR_ORDER)))}${content.join('')}</w:tc>`;
    }
    out += '</w:tr>';
  });
  return `${out}</w:tbl>`;
}

/** The plain words of a part, for comparing what was read with what is asked for. */
export function partText(root: XmlElement): string {
  return textOf(root).replace(/\s+/gu, ' ').trim();
}

// ------------------------------------------------------------------- comments

const COMMENT_START = '__commentStart';
const COMMENT_END = '__commentEnd';
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml';

/** Put a marker into a block's content at an offset into its text. */
function insertAt(block: PMNode, offset: number, marker: PMNode): void {
  const content = [...(block.content ?? [])];
  let at = 0;
  for (let index = 0; index < content.length; index += 1) {
    const inner = content[index] as PMNode;
    // Markers already placed take no room of their own.
    const size =
      inner.type === COMMENT_START || inner.type === COMMENT_END
        ? 0
        : inner.type === NODE.text
          ? (inner.text ?? '').length
          : 1;
    if (offset <= at) {
      content.splice(index, 0, marker);
      block.content = content;
      return;
    }
    if (inner.type === NODE.text && offset < at + size) {
      const value = inner.text ?? '';
      content.splice(
        index,
        1,
        { ...inner, text: value.slice(0, offset - at) },
        marker,
        { ...inner, text: value.slice(offset - at) },
      );
      block.content = content;
      return;
    }
    at += size;
  }
  content.push(marker);
  block.content = content;
}

/**
 * Write the comments into the package and mark their ranges in a copy of the
 * document. Word has no comment that belongs to the document as a whole, and a
 * comment whose words have since been rewritten has nowhere to go either: both
 * are attached to the start of the first paragraph, so that they are kept.
 * A reply is a comment of its own on the same range, which is how Word has it.
 */
function writeComments(ctx: Context, doc: PMNode, threads: ExportedThread[]): PMNode {
  // Whatever was there is replaced. These parts name the comments part's
  // paragraphs by id, and those ids are about to change.
  for (const stale of ['word/commentsIds.xml', 'word/commentsExtensible.xml', 'word/people.xml']) {
    if (ctx.parts[stale]) dropPart(ctx, stale);
  }
  if (threads.length === 0) {
    for (const part of ['word/comments.xml', 'word/commentsExtended.xml']) {
      if (ctx.parts[part]) dropPart(ctx, part);
    }
    return doc;
  }

  const copy = JSON.parse(JSON.stringify(doc)) as PMNode;
  let blocks = textBlocks(copy);
  if (blocks.length === 0) {
    copy.content = [{ type: NODE.paragraph }, ...(copy.content ?? [])];
    blocks = textBlocks(copy);
  }

  let nextId = 0;
  let nextParagraph = 0x10000000;
  const paragraphId = (): string => (nextParagraph += 7).toString(16).toUpperCase().padStart(8, '0');
  const comments: string[] = [];
  const extended: string[] = [];

  const write = (comment: ExportedComment, parent: string | null, done: boolean): { id: number; paragraph: string } => {
    const id = nextId;
    nextId += 1;
    const lines = comment.body.split('\n');
    let last = '';
    const paragraphs = lines
      .map((line) => {
        last = paragraphId();
        return `<w:p w14:paraId="${last}"><w:r><w:t xml:space="preserve">${escapeXmlText(line)}</w:t></w:r></w:p>`;
      })
      .join('');
    const initials = comment.author
      .split(/\s+/u)
      .map((word) => word[0] ?? '')
      .join('')
      .slice(0, 4)
      .toUpperCase();
    comments.push(
      `<w:comment w:id="${id}" w:author="${escapeXmlAttr(comment.author)}" w:date="${escapeXmlAttr(comment.date)}" w:initials="${escapeXmlAttr(initials)}">${paragraphs}</w:comment>`,
    );
    extended.push(
      `<w15:commentEx w15:paraId="${last}"${parent ? ` w15:paraIdParent="${parent}"` : ''} w15:done="${done ? '1' : '0'}"/>`,
    );
    return { id, paragraph: last };
  };

  for (const thread of threads) {
    const found = thread.anchor ? locateAnchor(blocks, thread.anchor) : null;
    const place = found ?? { block: 0, from: 0, to: 0 };
    const block = (blocks[place.block] as { node: PMNode }).node;
    const first = write(thread, null, thread.resolved);
    const ids = [first.id, ...thread.replies.map((reply) => write(reply, first.paragraph, thread.resolved).id)];
    // Ends first, so that placing them does not move where the starts go.
    for (const id of ids) insertAt(block, place.to, { type: COMMENT_END, attrs: { id } });
    for (const id of ids) insertAt(block, place.from, { type: COMMENT_START, attrs: { id } });
  }

  ctx.parts['word/comments.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${NAMESPACES['xmlns:w']}" xmlns:w14="${W14}">${comments.join('')}</w:comments>`,
  );
  ctx.parts['word/commentsExtended.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w15:commentsEx xmlns:w15="${W15}">${extended.join('')}</w15:commentsEx>`,
  );
  ensureOverride(ctx, '/word/comments.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml');
  ensureOverride(ctx, '/word/commentsExtended.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml');
  addRelationship(ctx, `${REL}/comments`, 'comments.xml');
  addRelationship(ctx, 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended', 'commentsExtended.xml');
  return copy;
}

/** Remove a part, and everything that names it. */
function dropPart(ctx: Context, name: string): void {
  delete ctx.parts[name];
  const target = name.replace(/^word\//u, '');
  ctx.rels.xml.children = ctx.rels.xml.children.filter(
    (node) => !isElement(node) || node.attrs['Target'] !== target,
  );
  ctx.contentTypes.children = ctx.contentTypes.children.filter(
    (node) => !isElement(node) || node.attrs['PartName'] !== `/${name}`,
  );
}

// ---------------------------------------------------------------- form controls

/** The text of a control's content, replaced, keeping the first run's formatting. */
function setControlText(control: XmlElement, value: string): void {
  const content = child(control, 'w:sdtContent');
  if (!content) return;
  const runs = descendants(content, 'w:r');
  const first = runs[0];
  const properties = first ? child(first, 'w:rPr') : undefined;
  const run = el('w:r', {}, [
    ...(properties ? [properties] : []),
    el('w:t', { 'xml:space': 'preserve' }, [{ text: value }]),
  ]);
  // Inside a paragraph the content is runs; a control can also wrap one.
  const paragraph = child(content, 'w:p');
  if (paragraph) {
    paragraph.children = [...paragraph.children.filter((node) => isElement(node) && node.name === 'w:pPr'), run];
  } else content.children = [run];
}

/**
 * A form control as it was kept, holding what has been filled in here.
 *
 * Only what the control holds is changed: the chosen item, the date, the tick.
 * What kind of control it is, its list, its tag and its title are as they came.
 */
function filledControl(kept: XmlElement[], node: PMNode): XmlElement[] {
  const value = typeof node.attrs?.['value'] === 'string' ? node.attrs['value'] : null;
  const type = node.attrs?.['controlType'];
  if (value === null || typeof type !== 'string') return kept;
  const clones = kept.map((element) => parseXml(serializeXml(element)));
  const control = clones.find((element) => element.name === 'w:sdt');
  const properties = child(control, 'w:sdtPr');
  if (!control || !properties) return kept;

  if (type === 'dropdown') {
    const list = child(properties, 'w:dropDownList') ?? child(properties, 'w:comboBox');
    const known = childrenNamed(list, 'w:listItem').some(
      (item) => (item.attrs['w:displayText'] ?? item.attrs['w:value']) === value,
    );
    // Only something on the list: a value from anywhere else is not a choice.
    if (known || child(properties, 'w:comboBox')) {
      setControlText(control, value);
      // Word marks an unfilled control as showing its placeholder.
      properties.children = properties.children.filter((entry) => !isElement(entry) || entry.name !== 'w:showingPlcHdr');
    }
  } else if (type === 'date' && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const date = child(properties, 'w:date');
    if (date) date.attrs['w:fullDate'] = `${value}T00:00:00Z`;
    const [year, month, day] = value.split('-') as [string, string, string];
    setControlText(control, `${day}/${month}/${year}`);
    properties.children = properties.children.filter((entry) => !isElement(entry) || entry.name !== 'w:showingPlcHdr');
  } else if (type === 'checkbox') {
    const box = child(properties, 'w14:checkbox');
    const checked = value === 'true';
    const state = child(box, 'w14:checked');
    if (state) state.attrs['w14:val'] = checked ? '1' : '0';
    else if (box) box.children.unshift(el('w14:checked', { 'w14:val': checked ? '1' : '0' }));
    setControlText(control, String.fromCodePoint(checked ? 0x2612 : 0x2610));
  }
  return clones;
}

// -------------------------------------------------------- footnotes and endnotes

const NOTE_KINDS = [
  { kind: 'footnote', part: 'word/footnotes.xml', root: 'w:footnotes', entry: 'w:footnote', ref: 'w:footnoteRef', rel: 'footnotes', style: 'FootnoteText' },
  { kind: 'endnote', part: 'word/endnotes.xml', root: 'w:endnotes', entry: 'w:endnote', ref: 'w:endnoteRef', rel: 'endnotes', style: 'EndnoteText' },
] as const;

/**
 * Footnotes and endnotes whose wording was changed here, and notes made here.
 *
 * A note's wording lives in its own part of the file. One that has not been
 * touched is left exactly as it was, with whatever formatting it had; one whose
 * words were edited is rewritten as plain text; a new one is added. Returns the
 * document with each new note's mark told which note it is.
 */
function writeNotes(ctx: Context, doc: PMNode): PMNode {
  let result = doc;
  for (const spec of NOTE_KINDS) {
    const marks: PMNode[] = [];
    const collect = (node: PMNode): void => {
      if (node.type === NODE.wordInline && node.attrs?.['kind'] === spec.kind) marks.push(node);
      for (const inner of node.content ?? []) collect(inner);
    };
    collect(result);
    const edited = marks.filter((mark) => typeof mark.attrs?.['note'] === 'string');
    if (edited.length === 0) continue;

    const existing = ctx.parts[spec.part];
    const root = existing
      ? parseXml(strFromU8(existing))
      : el(spec.root, { 'xmlns:w': NAMESPACES['xmlns:w'] as string, 'xmlns:r': REL }, [
          // The two every such part begins with: the rule above the notes.
          el(spec.entry, { 'w:type': 'separator', 'w:id': '-1' }, [el('w:p', {}, [el('w:r', {}, [el('w:separator')])])]),
          el(spec.entry, { 'w:type': 'continuationSeparator', 'w:id': '0' }, [el('w:p', {}, [el('w:r', {}, [el('w:continuationSeparator')])])]),
        ]);
    let nextId = Math.max(0, ...childrenNamed(root, spec.entry).map((entry) => Number(entry.attrs['w:id']) || 0)) + 1;
    let changed = false;

    const body = (words: string): XmlElement =>
      el('w:p', {}, [
        ...(ctx.styleIds.has(spec.style) ? [el('w:pPr', {}, [el('w:pStyle', { 'w:val': spec.style })])] : []),
        el('w:r', {}, [el('w:rPr', {}, [el('w:vertAlign', { 'w:val': 'superscript' })]), el(spec.ref)]),
        el('w:r', {}, [el('w:t', { 'xml:space': 'preserve' }, [{ text: ` ${words}` }])]),
      ]);

    const assigned = new Map<PMNode, string>();
    for (const mark of edited) {
      const words = String(mark.attrs?.['note']).replace(/\s+/gu, ' ').trim().slice(0, 4000);
      const id = typeof mark.attrs?.['noteId'] === 'string' && fragment(ctx, mark.attrs['ref']) ? mark.attrs['noteId'] : null;
      if (id !== null) {
        const entry = childrenNamed(root, spec.entry).find((candidate) => candidate.attrs['w:id'] === id);
        if (!entry) continue;
        const was = descendants(entry, 'w:t').map(textOf).join('').replace(/\s+/gu, ' ').trim();
        if (was === words) continue;
        entry.children = [body(words)];
        changed = true;
      } else if (words.length > 0) {
        const newId = String(nextId);
        nextId += 1;
        root.children.push(el(spec.entry, { 'w:id': newId }, [body(words)]));
        assigned.set(mark, newId);
        changed = true;
      }
    }
    if (!changed) continue;
    ctx.parts[spec.part] = xmlPart(root);
    if (!existing) {
      ensureOverride(ctx, `/${spec.part}`, `application/vnd.openxmlformats-officedocument.wordprocessingml.${spec.rel}+xml`);
      addRelationship(ctx, `${REL}/${spec.rel}`, spec.part.replace('word/', ''));
    }
    if (assigned.size > 0) {
      const stamp = (node: PMNode): PMNode => {
        const id = assigned.get(node);
        if (id) return { ...node, attrs: { ...node.attrs, newNoteId: id } };
        return node.content ? { ...node, content: node.content.map(stamp) } : node;
      };
      result = stamp(result);
    }
  }
  return result;
}
