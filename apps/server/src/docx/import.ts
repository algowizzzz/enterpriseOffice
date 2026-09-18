import mammoth from 'mammoth';
import { buildStyleMap, alignmentTransform } from './mammothOptions.js';
import { parse, NodeType, type HTMLElement, type Node as HtmlNode } from 'node-html-parser';
import { NODE, MARK, type PMNode, type PMMark } from '@docforge/model';
import { badRequest } from '../errors.js';
import { measureImage } from './imageSize.js';
import { archiveIsReasonable } from './zipGuard.js';

/** Inline images larger than this are dropped rather than inlined as data URIs. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGES = 100;

/** The formats the exporter can write back into a Word file. */
const SUPPORTED_IMAGE = /^data:image\/(png|jpe?g|gif|bmp);base64,/iu;

export interface ImportResult {
  content: PMNode;
  /** Non-fatal notes from the converter, surfaced to the user after upload. */
  messages: string[];
}

const BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'table',
  'blockquote',
  'hr',
]);

interface ImportState {
  images: number;
  /** Total bytes of embedded pictures, so a hundred large ones cannot add up. */
  imageBytes: number;
  messages: Set<string>;
}

/**
 * How deep the converter will follow nested markup.
 *
 * The walk is mutually recursive across inline content, blocks and containers,
 * and an uploaded file can nest as deeply as it likes. Without a limit a
 * hostile document overflows the stack, which surfaces as an opaque server
 * error rather than a refusal the person can understand.
 */
const MAX_HTML_DEPTH = 80;

/**
 * Everything a document may carry in pictures put together. Kept below the
 * limit on a stored document, so an image-heavy file is refused here with a
 * message about images rather than later with one about the document's size.
 */
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * What an uploaded archive may expand to. The converter reads the whole file
 * into memory, so a small upload declaring an enormous payload would otherwise
 * take the process down.
 */
const MAX_EXPANDED_BYTES = 200 * 1024 * 1024;

/**
 * The parser exposes DOM node types as an enum. Comparing against bare numbers
 * happens to work but is not checked, so the enum is used directly.
 */
const isElement = (node: HtmlNode): node is HTMLElement => node.nodeType === NodeType.ELEMENT_NODE;
const isText = (node: HtmlNode): boolean => node.nodeType === NodeType.TEXT_NODE;

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: '\u00a0',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const ENTITY = /&(?:nbsp|amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/giu;

/**
 * A code point that cannot stand for a character. Out of range throws in
 * `String.fromCodePoint`, and a lone surrogate produces a broken character that
 * would then be stored in the document and written back out.
 */
function characterFor(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return '';
  if (code >= 0xd800 && code <= 0xdfff) return '';
  return String.fromCodePoint(code);
}

/**
 * Decode the entities mammoth emits.
 *
 * One pass, not a chain of replacements. Running them in sequence fed the
 * output of each into the next, so a document containing the literal text
 * `&lt;` arrived as `&amp;lt;`, became `&lt;` after the ampersand pass and then
 * `<` after the next: the text somebody wrote was silently replaced by the
 * character it names. Anyone importing technical writing or templates lost
 * content that way.
 *
 * A code point outside the Unicode range used to throw out of here, which
 * surfaced as an opaque server error for a file the person could do nothing
 * about.
 */
function decodeEntities(text: string): string {
  return text.replace(ENTITY, (match: string, decimal?: string, hex?: string) => {
    if (decimal !== undefined) return characterFor(Number(decimal));
    if (hex !== undefined) return characterFor(Number.parseInt(hex, 16));
    return NAMED_ENTITIES[match.slice(1, -1).toLowerCase()] ?? match;
  });
}

/** Convert inline HTML into ProseMirror text nodes carrying marks. */
function inline(node: HtmlNode, marks: PMMark[], state: ImportState, depth = 0): PMNode[] {
  if (depth > MAX_HTML_DEPTH) return [];
  if (isText(node)) {
    const text = decodeEntities(node.rawText);
    if (text.length === 0) return [];
    return [marks.length > 0 ? { type: NODE.text, text, marks } : { type: NODE.text, text }];
  }
  if (!isElement(node)) return [];

  const tag = node.rawTagName?.toLowerCase() ?? '';
  const next = [...marks];
  switch (tag) {
    case 'strong':
    case 'b':
      next.push({ type: MARK.bold });
      break;
    case 'em':
    case 'i':
      next.push({ type: MARK.italic });
      break;
    case 'u':
      next.push({ type: MARK.underline });
      break;
    case 's':
    case 'strike':
    case 'del':
      next.push({ type: MARK.strike });
      break;
    case 'sup':
      next.push({ type: MARK.superscript });
      break;
    case 'sub':
      next.push({ type: MARK.subscript });
      break;
    case 'mark':
      next.push({ type: MARK.highlight });
      break;
    case 'a': {
      const href = node.getAttribute('href');
      // The same rule the model applies on save. "//host/path" inherits the
      // page's scheme and leaves the site, which a content security policy does
      // not stop for a navigation, and a bare "https:" names no host at all.
      if (href && /^(?:https?:\/\/[^/]|mailto:|#|\/(?!\/))/iu.test(href)) {
        next.push({ type: MARK.link, attrs: { href } });
      }
      break;
    }
    case 'br':
      return [{ type: NODE.hardBreak }];
    case 'img': {
      const src = node.getAttribute('src') ?? '';
      if (!src.startsWith('data:image/')) {
        state.messages.add('An image with an unsupported source was removed.');
        return [];
      }
      if (state.images >= MAX_IMAGES) {
        state.messages.add(`Only the first ${MAX_IMAGES} images were imported.`);
        return [];
      }
      if (!SUPPORTED_IMAGE.test(src)) {
        // Word files often carry EMF, WMF or TIFF pictures. Accepting one here
        // only to drop it silently when the document is exported again is worse
        // than refusing it now and saying so.
        state.messages.add(
          'An image in a format that cannot be saved back to Word was removed. PNG, JPEG, GIF and BMP are kept.',
        );
        return [];
      }
      const base64 = src.slice(src.indexOf(',') + 1);
      const bytes = Math.floor((base64.length * 3) / 4);
      if (bytes > MAX_IMAGE_BYTES) {
        state.messages.add('An image larger than 2 MB was removed.');
        return [];
      }
      if (state.imageBytes + bytes > MAX_TOTAL_IMAGE_BYTES) {
        state.messages.add('Some images were removed because the document held too many.');
        return [];
      }
      state.images += 1;
      state.imageBytes += bytes;
      const measured = measureImage(src);
      return [
        {
          type: NODE.image,
          attrs: {
            src,
            // Trimmed rather than stored whole: a caption longer than the limit
            // on an attribute would have the entire upload refused over it.
            alt: shortened(node.getAttribute('alt')),
            title: null,
            // Carrying the real size means the picture comes back the size it
            // went in, rather than at a fixed default.
            ...(measured ?? {}),
          },
        },
      ];
    }
    default:
      break;
  }
  return node.childNodes.flatMap((child) => inline(child, next, state, depth + 1));
}

function paragraphFrom(node: HTMLElement, state: ImportState, depth = 0): PMNode {
  const content = node.childNodes.flatMap((child) => inline(child, [], state, depth + 1));
  const align = alignmentOf(node);
  const attrs = align ? { textAlign: align } : undefined;
  return content.length > 0
    ? { type: NODE.paragraph, ...(attrs ? { attrs } : {}), content }
    : { type: NODE.paragraph, ...(attrs ? { attrs } : {}) };
}

function alignmentOf(node: HTMLElement): string | undefined {
  const style = node.getAttribute('style') ?? '';
  const inline = /text-align:\s*(left|center|right|justify)/iu.exec(style);
  if (inline?.[1]) return inline[1].toLowerCase();
  // Alignment carried across by the style map below, which encodes it as a class.
  const className = node.getAttribute('class') ?? '';
  const marked = /(?:^|\s)align-(left|center|right|justify)(?:\s|$)/iu.exec(className);
  return marked?.[1]?.toLowerCase();
}

function listFrom(node: HTMLElement, state: ImportState, depth = 0): PMNode {
  const ordered = node.rawTagName?.toLowerCase() === 'ol';
  const items: PMNode[] = [];
  for (const child of node.childNodes) {
    if (!isElement(child) || child.rawTagName?.toLowerCase() !== 'li') continue;
    const blocks = blocksOf(child, state, depth + 1);
    // A list item begins with a paragraph. An item holding only a nested list,
    // which `<li><ul>…</ul></li>` produces, is a shape the editor's schema does
    // not allow, and the list commands then operate on a document that cannot
    // be built. The browser's own parser inserts the same empty paragraph.
    const content =
      blocks.length > 0 && blocks[0]?.type !== NODE.paragraph
        ? [{ type: NODE.paragraph }, ...blocks]
        : blocks;
    items.push({
      type: NODE.listItem,
      content: content.length > 0 ? content : [{ type: NODE.paragraph }],
    });
  }
  if (items.length === 0) items.push({ type: NODE.listItem, content: [{ type: NODE.paragraph }] });
  return { type: ordered ? NODE.orderedList : NODE.bulletList, content: items };
}

/**
 * The rows belonging to this table, and not to a table nested inside one of its
 * cells. Asking the parser for every `tr` beneath the element pulled the inner
 * table's rows up into the outer one, and the cell holding that table then
 * converted it again, so a table inside a table imported with its rows doubled
 * and the outer table's shape ragged.
 */
function rowsOf(table: HTMLElement): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const child of table.childNodes) {
    if (!isElement(child)) continue;
    const tag = child.rawTagName?.toLowerCase();
    if (tag === 'tr') {
      rows.push(child);
    } else if (tag === 'tbody' || tag === 'thead' || tag === 'tfoot') {
      for (const inner of child.childNodes) {
        if (isElement(inner) && inner.rawTagName?.toLowerCase() === 'tr') rows.push(inner);
      }
    }
  }
  return rows;
}

function tableFrom(node: HTMLElement, state: ImportState, depth = 0): PMNode {
  const rows: PMNode[] = [];
  for (const tr of rowsOf(node)) {
    const cells: PMNode[] = [];
    for (const cell of tr.childNodes) {
      if (!isElement(cell)) continue;
      const tag = cell.rawTagName?.toLowerCase();
      if (tag !== 'td' && tag !== 'th') continue;
      const blocks = blocksOf(cell, state, depth + 1);
      const colspan = Number(cell.getAttribute('colspan') ?? '1');
      const rowspan = Number(cell.getAttribute('rowspan') ?? '1');
      cells.push({
        type: tag === 'th' ? NODE.tableHeader : NODE.tableCell,
        attrs: {
          colspan: Number.isFinite(colspan) && colspan > 0 ? colspan : 1,
          rowspan: Number.isFinite(rowspan) && rowspan > 0 ? rowspan : 1,
          colwidth: null,
        },
        content: blocks.length > 0 ? blocks : [{ type: NODE.paragraph }],
      });
    }
    if (cells.length > 0) rows.push({ type: NODE.tableRow, content: cells });
  }
  if (rows.length === 0) return { type: NODE.paragraph };
  return { type: NODE.table, content: rows };
}

/** Convert a container element's children into block-level ProseMirror nodes. */
function blocksOf(container: HTMLElement, state: ImportState, depth = 0): PMNode[] {
  if (depth > MAX_HTML_DEPTH) return [];
  const blocks: PMNode[] = [];
  let pendingInline: HtmlNode[] = [];

  const flush = (): void => {
    if (pendingInline.length === 0) return;
    const content = pendingInline.flatMap((child) => inline(child, [], state, depth + 1));
    pendingInline = [];
    if (content.some((n) => n.type !== NODE.text || (n.text ?? '').trim().length > 0)) {
      blocks.push({ type: NODE.paragraph, content });
    }
  };

  for (const child of container.childNodes) {
    if (isElement(child) && BLOCK_TAGS.has(child.rawTagName?.toLowerCase() ?? '')) {
      flush();
      blocks.push(...convertBlock(child, state, depth + 1));
    } else {
      pendingInline.push(child);
    }
  }
  flush();
  return blocks;
}

function convertBlock(node: HTMLElement, state: ImportState, depth = 0): PMNode[] {
  if (depth > MAX_HTML_DEPTH) return [];
  const tag = node.rawTagName?.toLowerCase() ?? '';
  if (/^h[1-6]$/u.test(tag)) {
    const level = Number(tag.slice(1));
    const content = node.childNodes.flatMap((child) => inline(child, [], state, depth + 1));
    // A heading carries alignment just as a paragraph does. Reading it only for
    // paragraphs silently dropped the centring from every centred title.
    const align = alignmentOf(node);
    const attrs = align ? { level, textAlign: align } : { level };
    return [
      content.length > 0
        ? { type: NODE.heading, attrs, content }
        : { type: NODE.heading, attrs },
    ];
  }
  switch (tag) {
    case 'p':
      return [paragraphFrom(node, state, depth)];
    case 'ul':
    case 'ol':
      return [listFrom(node, state, depth + 1)];
    case 'table':
      return [tableFrom(node, state, depth + 1)];
    case 'blockquote': {
      const inner = blocksOf(node, state, depth + 1);
      // Alignment sits on the quote element, so pass it to the paragraphs
      // inside that do not carry one of their own.
      const align = alignmentOf(node);
      const content =
        inner.length > 0
          ? align
            ? inner.map((block) =>
                block.type === NODE.paragraph && block.attrs?.['textAlign'] === undefined
                  ? { ...block, attrs: { ...(block.attrs ?? {}), textAlign: align } }
                  : block,
              )
            : inner
          : [{ type: NODE.paragraph }];
      return [{ type: NODE.blockquote, content }];
    }
    case 'hr':
      return [{ type: NODE.horizontalRule }];
    default:
      return blocksOf(node, state, depth + 1);
  }
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Convert an uploaded .docx into the editor's document model.
 *
 * Mammoth handles the OOXML reading. This maps its HTML onto our node and mark
 * vocabulary. Phase 3 replaces mammoth with the project's own OOXML codec so
 * that styles, numbering and unknown parts survive a round trip.
 */
export async function importDocx(buffer: Buffer): Promise<ImportResult> {
  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw badRequest(
      'That file is not a valid .docx. Older .doc files must be converted to .docx first.',
    );
  }
  const reasonable = archiveIsReasonable(buffer, MAX_EXPANDED_BYTES);
  if (!reasonable.ok) throw badRequest(reasonable.reason);

  let html: string;
  const state: ImportState = { images: 0, imageBytes: 0, messages: new Set() };
  try {
    const result = await mammoth.convertToHtml(
      { buffer },
      {
        styleMap: buildStyleMap(),
        transformDocument: alignmentTransform(mammoth),
      },
    );
    html = result.value;
    for (const message of result.messages) {
      if (message.type === 'warning') state.messages.add(message.message);
    }
  } catch (error) {
    throw badRequest(`Could not read that .docx file: ${(error as Error).message}`);
  }

  const converted = htmlToDocument(html);
  for (const message of converted.messages) state.messages.add(message);
  return { content: converted.content, messages: [...state.messages] };
}

/**
 * Map HTML onto the editor's document model.
 *
 * Separated from the docx reading above so that the mapping can be exercised
 * directly. Mammoth only ever emits a narrow, well-formed subset, which leaves
 * the defensive branches here, the ones that matter for hostile or unusual
 * input, unreachable from a docx fixture.
 */
export function htmlToDocument(html: string): ImportResult {
  const state: ImportState = { images: 0, imageBytes: 0, messages: new Set() };
  const root = parse(`<div>${html}</div>`, { blockTextElements: {} });
  const container = root.firstChild as HTMLElement;
  const blocks = blocksOf(container, state);
  const content: PMNode = {
    type: NODE.doc,
    content: blocks.length > 0 ? blocks : [{ type: NODE.paragraph }],
  };
  return { content, messages: [...state.messages] };
}

/** Alternative text that fits in an attribute, or nothing. */
function shortened(value: string | undefined | null, limit = 1000): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}\u2026`;
}

/** Strip the extension from an uploaded file name to use as a document title. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/u).pop() ?? fileName;
  return base.replace(/\.docx$/iu, '').trim() || 'Imported document';
}
