/**
 * Shared document model.
 *
 * The document is stored as ProseMirror JSON. This package holds the node and
 * mark vocabulary plus pure helpers used by BOTH the browser editor and the
 * server, so importers, exporters and validators cannot drift from the editor.
 *
 * Node and mark names are deliberately chosen to map onto OOXML concepts:
 *   paragraph  -> w:p          (attrs mirror w:pPr)
 *   text marks -> w:r/w:rPr
 *   table      -> w:tbl
 */

export const NODE = {
  doc: 'doc',
  paragraph: 'paragraph',
  heading: 'heading',
  text: 'text',
  hardBreak: 'hardBreak',
  pageBreak: 'pageBreak',
  horizontalRule: 'horizontalRule',
  blockquote: 'blockquote',
  bulletList: 'bulletList',
  orderedList: 'orderedList',
  listItem: 'listItem',
  table: 'table',
  tableRow: 'tableRow',
  tableCell: 'tableCell',
  tableHeader: 'tableHeader',
  image: 'image',
} as const;

export const MARK = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strike: 'strike',
  superscript: 'superscript',
  subscript: 'subscript',
  textStyle: 'textStyle',
  highlight: 'highlight',
  link: 'link',
} as const;

export type NodeName = (typeof NODE)[keyof typeof NODE];
export type MarkName = (typeof MARK)[keyof typeof MARK];

export interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: PMMark[];
  text?: string;
}

/** Alignment values, matching OOXML w:jc. */
export type Alignment = 'left' | 'center' | 'right' | 'justify';

/** An empty, valid document: one blank paragraph. */
export function emptyDoc(): PMNode {
  return { type: NODE.doc, content: [{ type: NODE.paragraph }] };
}

/** A document containing the given plain-text paragraphs. */
export function docFromParagraphs(paragraphs: string[]): PMNode {
  const content = paragraphs.map((line) =>
    line.length > 0
      ? { type: NODE.paragraph, content: [{ type: NODE.text, text: line }] }
      : { type: NODE.paragraph },
  );
  return { type: NODE.doc, content: content.length > 0 ? content : [{ type: NODE.paragraph }] };
}

/** Depth-first walk over every node in the tree, parents before children. */
export function walk(node: PMNode, visit: (node: PMNode, depth: number) => void, depth = 0): void {
  visit(node, depth);
  for (const child of node.content ?? []) walk(child, visit, depth + 1);
}

/** Concatenated text content, with one newline per block boundary. */
export function toPlainText(doc: PMNode): string {
  const blocks: string[] = [];
  const collect = (node: PMNode): string => {
    if (node.type === NODE.text) return node.text ?? '';
    return (node.content ?? []).map(collect).join('');
  };
  for (const child of doc.content ?? []) blocks.push(collect(child));
  return blocks.join('\n');
}

/** Word count using the same rule as most word processors: whitespace runs. */
export function wordCount(doc: PMNode): number {
  const text = toPlainText(doc).trim();
  if (text.length === 0) return 0;
  return text.split(/\s+/u).length;
}

export interface OutlineEntry {
  level: number;
  text: string;
}

/** Heading outline, used by the navigation pane and by table-of-contents build. */
export function outline(doc: PMNode): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  walk(doc, (node) => {
    if (node.type !== NODE.heading) return;
    const level = Number(node.attrs?.['level'] ?? 1);
    const text = toPlainText({ type: NODE.doc, content: [node] }).trim();
    if (text.length > 0) entries.push({ level, text });
  });
  return entries;
}

const KNOWN_NODES = new Set<string>(Object.values(NODE));
const KNOWN_MARKS = new Set<string>(Object.values(MARK));

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Structural validation of untrusted document JSON.
 *
 * This runs on every save. It is a guard against malformed or hostile payloads,
 * not a full schema check: the editor enforces content expressions client side.
 */
export function validateDoc(value: unknown): ValidationResult {
  const errors: string[] = [];
  const seen = { nodes: 0 };
  const MAX_NODES = 500_000;
  const MAX_DEPTH = 100;

  const check = (node: unknown, path: string, depth: number): void => {
    if (errors.length > 50) return;
    if (depth > MAX_DEPTH) {
      errors.push(`${path}: nesting deeper than ${MAX_DEPTH}`);
      return;
    }
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      errors.push(`${path}: expected an object`);
      return;
    }
    if (++seen.nodes > MAX_NODES) {
      errors.push('document exceeds the maximum node count');
      return;
    }
    const n = node as Record<string, unknown>;
    if (typeof n['type'] !== 'string') {
      errors.push(`${path}: missing node type`);
      return;
    }
    const type = n['type'];
    if (!KNOWN_NODES.has(type)) errors.push(`${path}: unknown node type "${type}"`);
    if (type === NODE.text) {
      if (typeof n['text'] !== 'string') errors.push(`${path}: text node without text`);
      if (n['content'] !== undefined) errors.push(`${path}: text node cannot have content`);
    }
    if (n['marks'] !== undefined) {
      if (!Array.isArray(n['marks'])) {
        errors.push(`${path}: marks must be an array`);
      } else {
        n['marks'].forEach((mark, i) => {
          const m = mark as Record<string, unknown> | null;
          if (typeof m !== 'object' || m === null || typeof m['type'] !== 'string') {
            errors.push(`${path}.marks[${i}]: malformed mark`);
          } else if (!KNOWN_MARKS.has(m['type'] as string)) {
            errors.push(`${path}.marks[${i}]: unknown mark "${String(m['type'])}"`);
          }
        });
      }
    }
    if (n['content'] !== undefined) {
      if (!Array.isArray(n['content'])) {
        errors.push(`${path}: content must be an array`);
        return;
      }
      n['content'].forEach((child, i) => check(child, `${path}.content[${i}]`, depth + 1));
    }
  };

  check(value, 'doc', 0);
  const root = value as { type?: unknown } | null;
  if (root && typeof root === 'object' && root.type !== NODE.doc) {
    errors.push('doc: root node must be of type "doc"');
  }
  return { ok: errors.length === 0, errors };
}
