/**
 * Tracked changes: what was put in, what was taken out, by whom and when.
 *
 * A change is a mark on the text it concerns. Inserted text carries an
 * insertion; text that has been deleted is still there, carrying a deletion,
 * until somebody accepts it. That is how Word holds them (`w:ins`, `w:del`),
 * so they go out to Word and come back as themselves, and it is also what a
 * comparison of two versions produces: a redline is a document with tracked
 * changes nobody has accepted yet.
 */
import type { PMMark, PMNode } from './index.js';

// The names this file needs, stated here rather than imported. The model's
// index re-exports this file, and a module that imports values from the module
// that re-exports it is read before those values exist. A test in the server
// suite asserts these agree with the vocabulary.
const NODE = {
  doc: 'doc',
  paragraph: 'paragraph',
  heading: 'heading',
  text: 'text',
  hardBreak: 'hardBreak',
  blockquote: 'blockquote',
  bulletList: 'bulletList',
  orderedList: 'orderedList',
  listItem: 'listItem',
  table: 'table',
  tableRow: 'tableRow',
  tableCell: 'tableCell',
  tableHeader: 'tableHeader',
  image: 'image',
  wordInline: 'wordInline',
  wordBlock: 'wordBlock',
} as const;
const MARK = { insertion: 'insertion', deletion: 'deletion' } as const;
export const CHANGE_NAMES = { NODE, MARK };

export interface ChangeInfo {
  author: string;
  date: string;
}

const isChange = (mark: PMMark): boolean =>
  mark.type === MARK.insertion || mark.type === MARK.deletion;

const has = (node: PMNode, type: string): boolean =>
  (node.marks ?? []).some((mark) => mark.type === type);

const without = (node: PMNode, type: string): PMNode => {
  const marks = (node.marks ?? []).filter((mark) => mark.type !== type);
  const { marks: _dropped, ...rest } = node;
  return marks.length > 0 ? { ...rest, marks } : rest;
};

/** Containers that cannot be left with nothing in them. */
const NEEDS_PARAGRAPH = new Set<string>([NODE.doc, NODE.blockquote, NODE.listItem, NODE.tableCell, NODE.tableHeader]);
const DROP_WHEN_EMPTY = new Set<string>([NODE.bulletList, NODE.orderedList, NODE.listItem]);

/**
 * The document with every change settled one way.
 *
 * Accepting keeps what was inserted and removes what was deleted; rejecting is
 * the reverse. A paragraph that existed only as a change goes with it, so that
 * rejecting an inserted paragraph does not leave an empty line behind.
 */
function settle(node: PMNode, remove: string, keep: string): PMNode | null {
  if (node.type === NODE.text || !node.content) {
    if (has(node, remove)) return null;
    return has(node, keep) ? without(node, keep) : node;
  }
  const hadContent = node.content.length > 0;
  const content = settleParagraphMarks(node.content, remove)
    .map((inner) => settle(inner, remove, keep))
    .filter((inner): inner is PMNode => inner !== null);

  const isTextBlock = node.type === NODE.paragraph || node.type === NODE.heading;
  if (isTextBlock && hadContent && content.length === 0) {
    // Everything in it was a change that has now gone: so has the paragraph.
    return null;
  }
  if (content.length === 0) {
    if (DROP_WHEN_EMPTY.has(node.type) || node.type === NODE.table || node.type === NODE.tableRow) return null;
    if (NEEDS_PARAGRAPH.has(node.type)) return { ...node, content: [{ type: NODE.paragraph }] };
  }
  const { content: _old, ...rest } = node;
  return content.length > 0 ? { ...rest, content } : rest;
}

const isTextBlock = (node: PMNode | undefined): node is PMNode =>
  node !== undefined && (node.type === NODE.paragraph || node.type === NODE.heading);

/** The attributes that say a paragraph's own mark, the break at its end, was changed. */
const PARAGRAPH_CHANGE = ['pmChange', 'pmAuthor', 'pmDate'] as const;

function withoutParagraphChange(node: PMNode, from?: PMNode): PMNode {
  const attrs: Record<string, unknown> = { ...(node.attrs ?? {}) };
  for (const name of PARAGRAPH_CHANGE) {
    delete attrs[name];
    // Joined to the paragraph after it, a paragraph ends with that one's mark.
    if (from?.attrs?.[name] !== undefined && from.attrs[name] !== null) attrs[name] = from.attrs[name];
  }
  const { attrs: _old, ...rest } = node;
  return Object.keys(attrs).length > 0 ? { ...rest, attrs } : rest;
}

/**
 * Settle changes to paragraph marks among a run of sibling blocks.
 *
 * Word tracks pressing Enter, and joining two paragraphs, as an insertion or a
 * deletion of the paragraph mark at the end of the first. A mark of the kind
 * being removed goes, which joins its paragraph to the next; a mark of the kind
 * being kept simply stops being a change.
 */
function settleParagraphMarks(blocks: PMNode[], remove: string): PMNode[] {
  const out: PMNode[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    let block = blocks[index] as PMNode;
    while (isTextBlock(block) && block.attrs?.['pmChange'] === remove && isTextBlock(blocks[index + 1])) {
      const next = blocks[index + 1] as PMNode;
      const content = [...(block.content ?? []), ...(next.content ?? [])];
      const joined = withoutParagraphChange(block, next);
      const { content: _old, ...rest } = joined;
      block = content.length > 0 ? { ...rest, content } : rest;
      index += 1;
    }
    out.push(isTextBlock(block) && block.attrs?.['pmChange'] !== undefined ? withoutParagraphChange(block) : block);
  }
  return out;
}

export function acceptAllChanges(doc: PMNode): PMNode {
  return settle(doc, MARK.deletion, MARK.insertion) ?? { type: NODE.doc, content: [{ type: NODE.paragraph }] };
}

export function rejectAllChanges(doc: PMNode): PMNode {
  return settle(doc, MARK.insertion, MARK.deletion) ?? { type: NODE.doc, content: [{ type: NODE.paragraph }] };
}

/** How many separate changes a document holds, for the badge on the button. */
export function countChanges(doc: PMNode): number {
  let count = 0;
  let previous = '';
  const visit = (node: PMNode): void => {
    if (node.type === NODE.text || !node.content) {
      const change = (node.marks ?? []).find(isChange);
      const key = change ? `${change.type}:${String(change.attrs?.['author'])}:${String(change.attrs?.['date'])}` : '';
      if (key && key !== previous) count += 1;
      previous = key;
      return;
    }
    // A change does not run on from one block into the next.
    if (node.type === NODE.paragraph || node.type === NODE.heading) {
      previous = '';
      if (node.attrs?.['pmChange'] === MARK.insertion || node.attrs?.['pmChange'] === MARK.deletion) count += 1;
    }
    for (const inner of node.content) visit(inner);
  };
  visit(doc);
  return count;
}

// ------------------------------------------------------------------ comparing

const INLINE_OBJECTS = new Set<string>([NODE.image, NODE.hardBreak, NODE.wordInline]);

const mark = (type: string, info: ChangeInfo): PMMark => ({ type, attrs: { author: info.author, date: info.date } });

/** Mark everything inside a node as one kind of change. */
function markAll(node: PMNode, type: string, info: ChangeInfo): PMNode {
  if (node.type === NODE.text || (!node.content && node.type !== NODE.paragraph && node.type !== NODE.heading)) {
    // Block objects (a rule, a page break, a kept block) cannot carry a mark.
    if (node.type !== NODE.text && !INLINE_OBJECTS.has(node.type)) {
      return node;
    }
    const marks = [...(node.marks ?? []).filter((existing) => !isChange(existing)), mark(type, info)];
    return { ...node, marks };
  }
  if (!node.content) return node;
  return { ...node, content: node.content.map((inner) => markAll(inner, type, info)) };
}

/** What makes two blocks "the same block" for lining two documents up. */
function blockKey(node: PMNode): string {
  const parts: string[] = [node.type];
  const visit = (inner: PMNode): void => {
    if (inner.type === NODE.text) parts.push(inner.text ?? '');
    else if (inner.type === NODE.image) {
      const src = inner.attrs?.['src'];
      parts.push(`[img:${typeof src === 'string' ? src.length : 0}]`);
    } else if (inner.type === NODE.wordInline || inner.type === NODE.wordBlock) {
      const ref = inner.attrs?.['ref'];
      parts.push(`[obj:${typeof ref === 'string' ? ref : ''}]`);
    }
    else {
      parts.push(`<${inner.type}>`);
      for (const deeper of inner.content ?? []) visit(deeper);
    }
  };
  for (const inner of node.content ?? []) visit(inner);
  return parts.join(String.fromCharCode(1));
}

/** The cells a comparison may fill before it gives up and calls it a rewrite. */
const MAX_CELLS = 16_000_000;

/**
 * Line two sequences up: the longest run of items they share, in order.
 * Returns pairs of indexes; everything between pairs was removed or added.
 */
function align<T>(a: T[], b: T[], same: (x: T, y: T) => boolean): [number, number][] {
  let start = 0;
  while (start < a.length && start < b.length && same(a[start] as T, b[start] as T)) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && same(a[endA - 1] as T, b[endB - 1] as T)) {
    endA -= 1;
    endB -= 1;
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < start; i += 1) pairs.push([i, i]);

  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0 && n * m <= MAX_CELLS) {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] = same(a[start + i] as T, b[start + j] as T)
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (same(a[start + i] as T, b[start + j] as T)) {
        pairs.push([start + i, start + j]);
        i += 1;
        j += 1;
      } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) i += 1;
      else j += 1;
    }
  }
  for (let k = 0; endA + k < a.length; k += 1) pairs.push([endA + k, endB + k]);
  return pairs;
}

interface Token {
  key: string;
  nodes: PMNode[];
}

/** A paragraph's content as words, spaces and objects, each keeping its formatting. */
function tokens(block: PMNode): Token[] {
  const out: Token[] = [];
  for (const node of block.content ?? []) {
    if (node.type !== NODE.text) {
      out.push({ key: blockKey(node) || node.type, nodes: [node] });
      continue;
    }
    for (const piece of (node.text ?? '').match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_'’-]/gu) ?? []) {
      const last = out.at(-1);
      // A word split across two runs by formatting is still one word.
      if (last && /^[\p{L}\p{N}_'’-]+$/u.test(piece) && /[\p{L}\p{N}_'’-]$/u.test(last.key) && last.nodes.every((n) => n.type === NODE.text)) {
        last.key += piece;
        last.nodes.push({ ...node, text: piece });
      } else {
        out.push({ key: piece, nodes: [{ ...node, text: piece }] });
      }
    }
  }
  return out;
}

const sameMarks = (a: PMNode, b: PMNode): boolean => JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? []);

/** Join neighbouring text nodes that carry the same marks. */
function joined(nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const node of nodes) {
    const last = out.at(-1);
    if (last && last.type === NODE.text && node.type === NODE.text && sameMarks(last, node)) {
      out[out.length - 1] = { ...last, text: (last.text ?? '') + (node.text ?? '') };
    } else out.push(node);
  }
  return out;
}

/** One paragraph compared with another, word by word. */
function diffInline(before: PMNode, after: PMNode, info: ChangeInfo): PMNode {
  const a = tokens(before);
  const b = tokens(after);
  const pairs = align(a, b, (x, y) => x.key === y.key);
  const content: PMNode[] = [];
  let i = 0;
  let j = 0;
  const flush = (toI: number, toJ: number): void => {
    for (; i < toI; i += 1) content.push(...(a[i] as Token).nodes.map((node) => markAll(node, MARK.deletion, info)));
    for (; j < toJ; j += 1) content.push(...(b[j] as Token).nodes.map((node) => markAll(node, MARK.insertion, info)));
  };
  for (const [pi, pj] of pairs) {
    flush(pi, pj);
    content.push(...(b[pj] as Token).nodes);
    i = pi + 1;
    j = pj + 1;
  }
  flush(a.length, b.length);
  const { content: _old, ...rest } = after;
  const merged = joined(content);
  return merged.length > 0 ? { ...rest, content: merged } : rest;
}

const textOf = (node: PMNode): string => {
  if (node.type === NODE.text) return node.text ?? '';
  return (node.content ?? []).map(textOf).join('');
};

/** How alike two paragraphs are, from 0 to 1, by the words they share. */
function likeness(before: PMNode, after: PMNode): number {
  const a = textOf(before).split(/\s+/u).filter(Boolean);
  const b = textOf(after).split(/\s+/u).filter(Boolean);
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const word of a) counts.set(word, (counts.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of b) {
    const left = counts.get(word) ?? 0;
    if (left > 0) {
      shared += 1;
      counts.set(word, left - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

const TEXT_BLOCK = new Set<string>([NODE.paragraph, NODE.heading]);
const CONTAINERS = new Set<string>([
  NODE.blockquote, NODE.bulletList, NODE.orderedList, NODE.listItem,
  NODE.table, NODE.tableRow, NODE.tableCell, NODE.tableHeader,
]);

/** Whether two changed blocks are one block that was edited, not one removed and one added. */
function pairs(before: PMNode, after: PMNode): boolean {
  if (TEXT_BLOCK.has(before.type) && TEXT_BLOCK.has(after.type)) return likeness(before, after) >= 0.4;
  if (before.type === after.type && CONTAINERS.has(before.type)) {
    if (before.type === NODE.table) {
      // The same table if it is the same shape; otherwise a different table.
      return (before.content ?? []).length === (after.content ?? []).length;
    }
    return true;
  }
  return false;
}

function diffBlocks(before: PMNode[], after: PMNode[], info: ChangeInfo, depth: number): PMNode[] {
  const keysA = before.map(blockKey);
  const keysB = after.map(blockKey);
  const matched = align(keysA, keysB, (x, y) => x === y);
  const out: PMNode[] = [];
  let i = 0;
  let j = 0;
  const between = (toI: number, toJ: number): void => {
    // Inside a gap, pair up what was edited and mark the rest as removed or added.
    while (i < toI || j < toJ) {
      const removed = before[i];
      const added = after[j];
      if (i < toI && j < toJ && removed && added && pairs(removed, added) && depth < 40) {
        out.push(
          TEXT_BLOCK.has(added.type)
            ? diffInline(removed, added, info)
            : { ...added, content: diffBlocks(removed.content ?? [], added.content ?? [], info, depth + 1) },
        );
        i += 1;
        j += 1;
      } else if (i < toI && removed) {
        out.push(markAll(removed, MARK.deletion, info));
        i += 1;
      } else if (added) {
        out.push(markAll(added, MARK.insertion, info));
        j += 1;
      } else break;
    }
  };
  for (const [pi, pj] of matched) {
    between(pi, pj);
    out.push(after[pj] as PMNode);
    i = pi + 1;
    j = pj + 1;
  }
  between(before.length, after.length);
  return out;
}

/**
 * A redline: `after`, with what it added marked as inserted and what it dropped
 * from `before` put back and marked as deleted. Accepting every change in the
 * result gives `after`; rejecting every change gives the words of `before`.
 */
export function compareDocuments(before: PMNode, after: PMNode, info: ChangeInfo): PMNode {
  const content = diffBlocks(before.content ?? [], after.content ?? [], info, 0);
  return { type: NODE.doc, content: content.length > 0 ? content : [{ type: NODE.paragraph }] };
}
