import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Footer,
  Header,
  ImageRun,
  PageOrientation,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  ShadingType,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from 'docx';
import {
  NODE,
  MARK,
  defaultPageSetup,
  isSafeHref,
  type PageSetup,
  type PMMark,
  type PMNode,
} from '@docforge/model';
import { measureImage } from './imageSize.js';
import { writeDocx, type ExportedThread } from './ooxml/write.js';
import { buildStandardTemplatePackage } from './standardTemplate.js';
import type { ExportTemplate } from '../services/exportTemplate.js';

const HEADING_BY_LEVEL: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

const ALIGNMENT: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};

/** Read an attribute that is meant to be text, ignoring anything that is not. */
const textAttr = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

/** Read an attribute that is meant to be a count, ignoring anything that is not. */
function positiveInt(value: unknown, limit = 100000): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > limit) return null;
  return parsed;
}

function markSet(marks: PMMark[] | undefined): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const mark of marks ?? []) map.set(mark.type, mark.attrs ?? {});
  return map;
}

function decodeDataUri(src: string): { data: Buffer; type: 'png' | 'jpg' | 'gif' | 'bmp' } | null {
  const match = /^data:image\/(png|jpe?g|gif|bmp);base64,(.+)$/iu.exec(src);
  if (!match) return null;
  const subtype = (match[1] as string).toLowerCase();
  const type = subtype === 'jpeg' || subtype === 'jpg' ? 'jpg' : (subtype as 'png' | 'gif' | 'bmp');
  try {
    return { data: Buffer.from(match[2] as string, 'base64'), type };
  } catch {
    return null;
  }
}

/** Convert the inline content of one block into docx runs. */
function runsOf(node: PMNode): ParagraphChild[] {
  const children: ParagraphChild[] = [];
  for (const child of node.content ?? []) {
    if (child.type === NODE.hardBreak) {
      children.push(new TextRun({ text: '', break: 1 }));
      continue;
    }
    if (child.type === NODE.image) {
      const src = textAttr(child.attrs?.['src']);
      const decoded = decodeDataUri(src);
      if (!decoded) continue;
      // Prefer the size the document carries, fall back to reading it out of
      // the picture, and only then to a default. Writing every image at a fixed
      // size resized and distorted all of them on every round trip.
      const declared = positiveInt(child.attrs?.['width']);
      const declaredHeight = positiveInt(child.attrs?.['height']);
      const measured = declared && declaredHeight ? null : measureImage(src);
      children.push(
        new ImageRun({
          data: decoded.data,
          type: decoded.type,
          transformation: {
            width: declared ?? measured?.width ?? 400,
            height: declaredHeight ?? measured?.height ?? 300,
          },
        }),
      );
      continue;
    }
    if (child.type !== NODE.text) {
      children.push(...runsOf(child));
      continue;
    }
    const text = child.text ?? '';
    if (text.length === 0) continue;
    const marks = markSet(child.marks);
    const style = marks.get(MARK.textStyle) ?? {};
    const fontSizePt = Number(textAttr(style['fontSize']).replace(/[^\d.]/gu, ''));
    const color = textAttr(style['color']).replace('#', '');
    const isLink = marks.has(MARK.link);
    const run = new TextRun({
        text,
        bold: marks.has(MARK.bold),
        italics: marks.has(MARK.italic),
        underline: marks.has(MARK.underline) || isLink ? {} : undefined,
        strike: marks.has(MARK.strike),
        superScript: marks.has(MARK.superscript),
        subScript: marks.has(MARK.subscript),
        highlight: marks.has(MARK.highlight) ? 'yellow' : undefined,
        ...(Number.isFinite(fontSizePt) && fontSizePt > 0
          ? { size: Math.round(fontSizePt * 2) }
          : {}),
        ...(/^[0-9a-f]{6}$/iu.test(color) ? { color } : {}),
        ...(textAttr(style['fontFamily']) ? { font: textAttr(style['fontFamily']) } : {}),
      });
    // A link used to be written as underlined text and nothing else: it looked
    // like a link in Word and went nowhere, so every reference in a policy was
    // silently broken by one round trip. Only an address Word can follow is
    // wrapped; "#anchor" and "/path" mean something in a browser and nothing in
    // a file, and stay as underlined text.
    const href = textAttr(marks.get(MARK.link)?.['href']);
    const external = isLink && isSafeHref(href) && /^(?:https?:|mailto:)/iu.test(href);
    children.push(external ? new ExternalHyperlink({ link: href, children: [run] }) : run);
  }
  return children;
}

interface ListContext {
  level: number;
  ordered: boolean;
}

function paragraphOptions(node: PMNode, list?: ListContext, indentLeft = 0): IParagraphOptions {
  const align = textAttr(node.attrs?.['textAlign']);
  return {
    children: runsOf(node),
    ...(ALIGNMENT[align] ? { alignment: ALIGNMENT[align] } : {}),
    ...(indentLeft > 0 ? { indent: { left: indentLeft } } : {}),
    ...(list
      ? list.ordered
        ? { numbering: { reference: 'docforge-ordered', level: list.level } }
        : { bullet: { level: list.level } }
      : {}),
  };
}

/** One level of quote indentation, in twentieths of a point. */
const QUOTE_INDENT = 720;
/** The style a quoted paragraph carries, defined in the file itself below. */
const QUOTE_STYLE = 'Quote';

/**
 * A span larger than this is not a table Word will open. The value reaching
 * here comes from stored content, which a non-browser client can write freely.
 */
const MAX_SPAN = 1000;

/**
 * A run of sibling blocks.
 *
 * A page break is a property of the paragraph that follows it, not a paragraph
 * of its own. Writing it as its own empty paragraph put a blank line at the top
 * of every new page, and reading the file back produced that blank line as a
 * real paragraph.
 */
function convertBlocks(
  nodes: PMNode[],
  list?: ListContext,
  indentLeft = 0,
  quoted = false,
): (Paragraph | Table)[] {
  const blocks: (Paragraph | Table)[] = [];
  let breakBefore = false;
  for (const node of nodes) {
    if (node.type === NODE.pageBreak) {
      breakBefore = true;
      continue;
    }
    const converted = convertBlock(node, list, indentLeft, breakBefore, quoted);
    if (converted.length > 0) breakBefore = false;
    blocks.push(...converted);
  }
  // A break with nothing after it still has to be written down.
  if (breakBefore) blocks.push(new Paragraph({ pageBreakBefore: true }));
  return blocks;
}

function convertBlock(
  node: PMNode,
  list?: ListContext,
  indentLeft = 0,
  breakBefore = false,
  quoted = false,
): (Paragraph | Table)[] {
  const pageBreak = breakBefore ? { pageBreakBefore: true } : {};
  switch (node.type) {
    case NODE.paragraph:
      return [
        new Paragraph({
          ...paragraphOptions(node, list, indentLeft),
          ...pageBreak,
          // Named, not merely indented. An indent looks like a quotation and
          // reads back as an ordinary paragraph, so a quotation came home as
          // plain text every time.
          ...(quoted ? { style: QUOTE_STYLE } : {}),
        }),
      ];
    case NODE.heading: {
      const level = Number(node.attrs?.['level'] ?? 1);
      return [
        new Paragraph({
          ...paragraphOptions(node, undefined, indentLeft),
          ...pageBreak,
          heading: HEADING_BY_LEVEL[level] ?? HeadingLevel.HEADING_1,
        }),
      ];
    }
    case NODE.blockquote:
      // Each child is converted as itself and indented, rather than being
      // flattened into a paragraph. Mapping everything through the paragraph
      // path turned a quoted list into one run-on line with no bullets, and a
      // quoted table into the same.
      return withBreak(
        convertBlocks(node.content ?? [], list, indentLeft + QUOTE_INDENT, true),
        breakBefore,
      );
    case NODE.bulletList:
    case NODE.orderedList: {
      const ordered = node.type === NODE.orderedList;
      const level = list ? list.level + 1 : 0;
      const blocks: (Paragraph | Table)[] = [];
      for (const item of node.content ?? []) {
        blocks.push(...convertBlocks(item.content ?? [], { level, ordered }, indentLeft));
      }
      return withBreak(blocks, breakBefore);
    }
    case NODE.table: {
      const rows = (node.content ?? []).map(
        (row) =>
          new TableRow({
            children: (row.content ?? []).map(
              (cell) =>
                new TableCell({
                  columnSpan: positiveInt(cell.attrs?.['colspan'], MAX_SPAN) ?? 1,
                  rowSpan: positiveInt(cell.attrs?.['rowspan'], MAX_SPAN) ?? 1,
                  // The colour somebody gave the cell. Dropping it turned every
                  // banded table into a plain one on the way out.
                  ...cellShading(cell.attrs?.['background']),
                  ...cellWidth(cell.attrs?.['colwidth']),
                  children: convertBlocks(cell.content ?? [], undefined, indentLeft),
                }),
            ),
          }),
      );
      if (rows.length === 0) return [new Paragraph({})];
      // A table cannot carry a break of its own, so it gets one in front.
      return withBreak(
        [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })],
        breakBefore,
      );
    }
    case NODE.horizontalRule:
      return [new Paragraph({ thematicBreak: true, ...pageBreak })];
    case NODE.pageBreak:
      return [new Paragraph({ pageBreakBefore: true })];
    default:
      return withBreak(convertBlocks(node.content ?? [], list, indentLeft), breakBefore);
  }
}

/** Put a break in front of blocks that cannot carry one themselves. */
function withBreak(blocks: (Paragraph | Table)[], breakBefore: boolean): (Paragraph | Table)[] {
  if (!breakBefore || blocks.length === 0) return blocks;
  return [new Paragraph({ pageBreakBefore: true }), ...blocks];
}

/** A cell's fill, as Word states it: six hexadecimal digits, no hash. */
function cellShading(value: unknown): { shading?: { type: (typeof ShadingType)[keyof typeof ShadingType]; color: string; fill: string } } {
  if (typeof value !== 'string') return {};
  const fill = value.trim().replace(/^#/u, '');
  if (!/^[0-9a-f]{6}$/iu.test(fill)) return {};
  return { shading: { type: ShadingType.CLEAR, color: 'auto', fill: fill.toUpperCase() } };
}

/** A cell's width, stored by the editor in pixels and written in twentieths of a point. */
function cellWidth(value: unknown): { width?: { size: number; type: typeof WidthType.DXA } } {
  const pixels = Array.isArray(value)
    ? value.reduce((total: number, entry) => total + (typeof entry === 'number' ? entry : 0), 0)
    : 0;
  if (!Number.isFinite(pixels) || pixels <= 0) return {};
  return { width: { size: Math.round(pixels * 15), type: WidthType.DXA } };
}

/**
 * Numbering has to define every level a nested list can reach, or the deepest
 * items reference a level the document never declared.
 */
const NUMBERING_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8];

export interface ExportOptions {
  title: string;
  author?: string;
  /** The running header, the running footer and the orientation of the page. */
  pageSetup?: PageSetup;
  /** The file this document was uploaded as, which the export patches. */
  source?: Buffer | undefined;
  /** Markup the reader kept by reference, which the writer puts back. */
  fragments?: Record<string, string> | undefined;
  /** The page setup as it was read, so an untouched header is left alone. */
  originalSetup?: PageSetup | undefined;
  /** Review comments, written into Word's own comments part. */
  comments?: ExportedThread[] | undefined;
  /**
   * Present only for "Standardized" export (docs/17-standardized-export.md):
   * the admin's house style, applied instead of the document's own
   * formatting, regardless of whether it has an uploaded source. This is
   * the one deliberate exception to "preserve by default" in this file.
   */
  standardTemplate?: { template: ExportTemplate; documentType: string | null } | undefined;
}

/**
 * Serialize a document to a .docx file.
 *
 * The file it was uploaded as is patched, so everything the model does not
 * hold leaves as it arrived. A document that was never a Word file starts from
 * a template built by the `docx` library and takes the same path: see
 * `ooxml/write.ts` for why there is one writer and what it does. Standardized
 * export takes the same path a third way, seeded from the admin's own
 * template instead, regardless of whether the document has a source: that is
 * the point of it, not an oversight.
 */
export async function exportDocx(doc: PMNode, options: ExportOptions): Promise<Buffer> {
  const pageSetup = options.pageSetup ?? defaultPageSetup();
  if (options.standardTemplate) {
    const base = await buildStandardTemplatePackage(
      options.standardTemplate.template,
      { documentTitle: options.title, documentType: options.standardTemplate.documentType },
      pageSetup,
    );
    return writeDocx(doc, {
      base,
      fragments: options.fragments ?? {},
      pageSetup: defaultPageSetup(),
      originalSetup: defaultPageSetup(),
      comments: options.comments,
      // `write.ts` strips a leading `#` itself (`adminBorders`, and the cell
      // `fill` shading below it) the same defensive way it already handles
      // an uploaded document's own `background` attribute, so the service's
      // `#rrggbb` values pass straight through.
      tableStyle: options.standardTemplate.template.table,
    });
  }
  if (options.source) {
    return writeDocx(doc, {
      base: options.source,
      fragments: options.fragments ?? {},
      pageSetup,
      originalSetup: options.originalSetup,
      comments: options.comments,
    });
  }
  const template = await templatePackage({ type: NODE.doc, content: [] }, { ...options, pageSetup: defaultPageSetup() });
  return writeDocx(doc, {
    base: template,
    fragments: options.fragments ?? {},
    pageSetup,
    originalSetup: defaultPageSetup(),
    comments: options.comments,
  });
}

/** A package with styles, settings and properties, and nothing in its body. */
async function templatePackage(doc: PMNode, options: ExportOptions): Promise<Buffer> {
  const blocks = convertBlocks(doc.content ?? []);
  const setup = options.pageSetup ?? defaultPageSetup();
  const document = new Document({
    title: options.title,
    // Word has a Quote style of its own, but a file cannot rely on a style it
    // does not define: an undefined style is ignored and the quotation loses
    // its indent for anybody opening it elsewhere.
    styles: {
      paragraphStyles: [
        {
          id: QUOTE_STYLE,
          name: 'Quote',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          paragraph: { indent: { left: QUOTE_INDENT } },
        },
      ],
    },
    creator: options.author ?? 'DocForge',
    description: 'Created with DocForge',
    numbering: {
      config: [
        {
          reference: 'docforge-ordered',
          levels: NUMBERING_LEVELS.map((level) => ({
            level,
            format: 'decimal' as const,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [
      {
        properties: {
          ...(setup.orientation === 'landscape'
            ? { page: { size: { orientation: PageOrientation.LANDSCAPE } } }
            : {}),
        },
        // A running header and footer are written on every page, as Word does,
        // and come back as the same header and footer when the file is read.
        ...(setup.header
          ? {
              headers: {
                default: new Header({ children: [new Paragraph({ text: setup.header })] }),
              },
            }
          : {}),
        ...(setup.footer
          ? {
              footers: {
                default: new Footer({ children: [new Paragraph({ text: setup.footer })] }),
              },
            }
          : {}),
        children: blocks.length > 0 ? blocks : [new Paragraph({})],
      },
    ],
  });
  return Packer.toBuffer(document);
}

/** Characters that are illegal or troublesome in file names on Windows or Linux. */
const UNSAFE_FILENAME_CHARS = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + '<>:"/\\\\|?*]',
  'gu',
);

/** A file name that is safe on Windows and Linux alike. */
export function safeFileName(title: string, extension: string): string {
  const base = title
    .replace(UNSAFE_FILENAME_CHARS, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120);
  return `${base.length > 0 ? base : 'document'}.${extension}`;
}
