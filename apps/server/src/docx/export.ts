import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from 'docx';
import { NODE, MARK, type PMMark, type PMNode } from '@docforge/model';
import { measureImage } from './imageSize.js';

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
    children.push(
      new TextRun({
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
      }),
    );
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

/**
 * A span larger than this is not a table Word will open. The value reaching
 * here comes from stored content, which a non-browser client can write freely.
 */
const MAX_SPAN = 1000;

function convertBlock(node: PMNode, list?: ListContext, indentLeft = 0): (Paragraph | Table)[] {
  switch (node.type) {
    case NODE.paragraph:
      return [new Paragraph(paragraphOptions(node, list, indentLeft))];
    case NODE.heading: {
      const level = Number(node.attrs?.['level'] ?? 1);
      return [
        new Paragraph({
          ...paragraphOptions(node, undefined, indentLeft),
          heading: HEADING_BY_LEVEL[level] ?? HeadingLevel.HEADING_1,
        }),
      ];
    }
    case NODE.blockquote:
      // Each child is converted as itself and indented, rather than being
      // flattened into a paragraph. Mapping everything through the paragraph
      // path turned a quoted list into one run-on line with no bullets, and a
      // quoted table into the same.
      return (node.content ?? []).flatMap((child) =>
        convertBlock(child, list, indentLeft + QUOTE_INDENT),
      );
    case NODE.bulletList:
    case NODE.orderedList: {
      const ordered = node.type === NODE.orderedList;
      const level = list ? list.level + 1 : 0;
      const blocks: (Paragraph | Table)[] = [];
      for (const item of node.content ?? []) {
        for (const child of item.content ?? []) {
          blocks.push(...convertBlock(child, { level, ordered }, indentLeft));
        }
      }
      return blocks;
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
                  children: (cell.content ?? []).flatMap((child) => convertBlock(child)),
                }),
            ),
          }),
      );
      if (rows.length === 0) return [new Paragraph({})];
      return [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })];
    }
    case NODE.horizontalRule:
      return [new Paragraph({ thematicBreak: true })];
    case NODE.pageBreak:
      return [new Paragraph({ pageBreakBefore: true })];
    default:
      return (node.content ?? []).flatMap((child) => convertBlock(child, list, indentLeft));
  }
}

/**
 * Numbering has to define every level a nested list can reach, or the deepest
 * items reference a level the document never declared.
 */
const NUMBERING_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8];

export interface ExportOptions {
  title: string;
  author?: string;
}

/** Serialize a document to a .docx file. */
export async function exportDocx(doc: PMNode, options: ExportOptions): Promise<Buffer> {
  const blocks = (doc.content ?? []).flatMap((node) => convertBlock(node));
  const document = new Document({
    title: options.title,
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
        properties: {},
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
