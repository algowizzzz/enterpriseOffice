import mammoth from 'mammoth';
import { buildStyleMap, alignmentTransform } from './mammothOptions.js';
import { parse, NodeType, type HTMLElement, type Node as HtmlNode } from 'node-html-parser';
import { NODE, MARK, type PMNode, type PMMark } from '@docforge/model';
import { badRequest } from '../errors.js';

/** Inline images larger than this are dropped rather than inlined as data URIs. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGES = 100;

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
  messages: Set<string>;
}

/**
 * The parser exposes DOM node types as an enum. Comparing against bare numbers
 * happens to work but is not checked, so the enum is used directly.
 */
const isElement = (node: HtmlNode): node is HTMLElement => node.nodeType === NodeType.ELEMENT_NODE;
const isText = (node: HtmlNode): boolean => node.nodeType === NodeType.TEXT_NODE;

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

/** Convert inline HTML into ProseMirror text nodes carrying marks. */
function inline(node: HtmlNode, marks: PMMark[], state: ImportState): PMNode[] {
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
      if (href && /^(https?:|mailto:|#|\/)/iu.test(href)) {
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
      const base64 = src.slice(src.indexOf(',') + 1);
      if (Math.floor((base64.length * 3) / 4) > MAX_IMAGE_BYTES) {
        state.messages.add('An image larger than 2 MB was removed.');
        return [];
      }
      state.images += 1;
      return [
        {
          type: NODE.image,
          attrs: { src, alt: node.getAttribute('alt') ?? null, title: null },
        },
      ];
    }
    default:
      break;
  }
  return node.childNodes.flatMap((child) => inline(child, next, state));
}

function paragraphFrom(node: HTMLElement, state: ImportState): PMNode {
  const content = node.childNodes.flatMap((child) => inline(child, [], state));
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

function listFrom(node: HTMLElement, state: ImportState): PMNode {
  const ordered = node.rawTagName?.toLowerCase() === 'ol';
  const items: PMNode[] = [];
  for (const child of node.childNodes) {
    if (!isElement(child) || child.rawTagName?.toLowerCase() !== 'li') continue;
    const blocks = blocksOf(child, state);
    items.push({
      type: NODE.listItem,
      content: blocks.length > 0 ? blocks : [{ type: NODE.paragraph }],
    });
  }
  if (items.length === 0) items.push({ type: NODE.listItem, content: [{ type: NODE.paragraph }] });
  return { type: ordered ? NODE.orderedList : NODE.bulletList, content: items };
}

function tableFrom(node: HTMLElement, state: ImportState): PMNode {
  const rows: PMNode[] = [];
  for (const tr of node.querySelectorAll('tr')) {
    const cells: PMNode[] = [];
    for (const cell of tr.childNodes) {
      if (!isElement(cell)) continue;
      const tag = cell.rawTagName?.toLowerCase();
      if (tag !== 'td' && tag !== 'th') continue;
      const blocks = blocksOf(cell, state);
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
function blocksOf(container: HTMLElement, state: ImportState): PMNode[] {
  const blocks: PMNode[] = [];
  let pendingInline: HtmlNode[] = [];

  const flush = (): void => {
    if (pendingInline.length === 0) return;
    const content = pendingInline.flatMap((child) => inline(child, [], state));
    pendingInline = [];
    if (content.some((n) => n.type !== NODE.text || (n.text ?? '').trim().length > 0)) {
      blocks.push({ type: NODE.paragraph, content });
    }
  };

  for (const child of container.childNodes) {
    if (isElement(child) && BLOCK_TAGS.has(child.rawTagName?.toLowerCase() ?? '')) {
      flush();
      blocks.push(...convertBlock(child, state));
    } else {
      pendingInline.push(child);
    }
  }
  flush();
  return blocks;
}

function convertBlock(node: HTMLElement, state: ImportState): PMNode[] {
  const tag = node.rawTagName?.toLowerCase() ?? '';
  if (/^h[1-6]$/u.test(tag)) {
    const level = Number(tag.slice(1));
    const content = node.childNodes.flatMap((child) => inline(child, [], state));
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
      return [paragraphFrom(node, state)];
    case 'ul':
    case 'ol':
      return [listFrom(node, state)];
    case 'table':
      return [tableFrom(node, state)];
    case 'blockquote': {
      const inner = blocksOf(node, state);
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
      return blocksOf(node, state);
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
  let html: string;
  const state: ImportState = { images: 0, messages: new Set() };
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
  const state: ImportState = { images: 0, messages: new Set() };
  const root = parse(`<div>${html}</div>`, { blockTextElements: {} });
  const container = root.firstChild as HTMLElement;
  const blocks = blocksOf(container, state);
  const content: PMNode = {
    type: NODE.doc,
    content: blocks.length > 0 ? blocks : [{ type: NODE.paragraph }],
  };
  return { content, messages: [...state.messages] };
}

/** Strip the extension from an uploaded file name to use as a document title. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/u).pop() ?? fileName;
  return base.replace(/\.docx$/iu, '').trim() || 'Imported document';
}
