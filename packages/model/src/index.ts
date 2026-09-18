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

/** The nodes that end a line of plain text. Everything else is a container. */
const LINE_NODES = new Set<string>([NODE.paragraph, NODE.heading]);

/**
 * The document as plain text, one line per paragraph or heading.
 *
 * Walking only the top level put every list item and table cell on one line,
 * because a list is a single top-level block: a two-item list came out as
 * "AlphaBeta". This walks to the paragraphs instead, wherever they sit, so a
 * list, a quote and a table each read as separate lines.
 */
export function toPlainText(doc: PMNode): string {
  const lines: string[] = [];
  let current = '';

  const walk = (node: PMNode): void => {
    if (node.type === NODE.text) {
      current += node.text ?? '';
      return;
    }
    if (node.type === NODE.hardBreak) {
      lines.push(current);
      current = '';
      return;
    }
    if (LINE_NODES.has(node.type)) {
      current = '';
      for (const child of node.content ?? []) walk(child);
      lines.push(current);
      current = '';
      return;
    }
    for (const child of node.content ?? []) walk(child);
  };

  for (const child of doc.content ?? []) walk(child);
  if (current.length > 0) lines.push(current);
  return lines.join('\n');
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

const ALIGNMENTS = new Set(['left', 'center', 'right', 'justify']);

/** Attribute values long enough to be a problem on their own. */
const MAX_ATTR_LENGTH = 4096;
/** An embedded image is a data URI, so it needs far more room than a label. */
const MAX_SRC_LENGTH = 4 * 1024 * 1024;

/**
 * A link target that cannot execute anything. The editor restricts what can be
 * typed, but stored content can come from an uploaded file or a client that is
 * not the editor, so the rule is enforced here as well.
 */
const SAFE_HREF = /^(?:https?:\/\/[^/]|mailto:|#|\/(?!\/))/iu;

/**
 * What an image may point at. Only data embedded in the document itself: a
 * remote address would make the page fetch something, which the air gap forbids
 * and the content security policy blocks anyway. The rule belongs here too,
 * because a document can be written by a client that is not the editor.
 */
const SAFE_SRC = /^data:image\/[a-z0-9.+-]+;base64,/iu;

const isBoundedInteger = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/**
 * An image dimension.
 *
 * Pasted markup carries CSS values such as "100%" or "auto", and the editor
 * stores them as written. Refusing those made the whole document unsavable
 * from the moment somebody pasted an image from a web page, with nothing on
 * screen to say which element was at fault. A count is bounded; anything else
 * is kept as a short string, which the exporter ignores in favour of measuring
 * the picture itself.
 */
const isDimension = (value: unknown): boolean => {
  if (value === null) return true;
  if (typeof value === 'number') return isBoundedInteger(value, 1, 20000);
  return typeof value === 'string' && value.length <= 32;
};

/**
 * Checks for the attributes that reach a serializer. Anything not listed is
 * allowed through as long as it is a plain value, because the editor's
 * extensions add attributes of their own and rejecting an unknown name would
 * break a document for no gain. What matters is that a value cannot carry a
 * structure, a hostile link, or a number that produces an unopenable file.
 */
const ATTR_CHECKS: Record<string, (value: unknown) => boolean> = {
  level: (value) => isBoundedInteger(value, 1, 6),
  textAlign: (value) => value === null || (typeof value === 'string' && ALIGNMENTS.has(value)),
  colspan: (value) => value === null || isBoundedInteger(value, 1, 1000),
  rowspan: (value) => value === null || isBoundedInteger(value, 1, 1000),
  width: isDimension,
  height: isDimension,
  href: (value) =>
    typeof value === 'string' && value.length <= MAX_ATTR_LENGTH && SAFE_HREF.test(value),
  src: (value) =>
    typeof value === 'string' && value.length <= MAX_SRC_LENGTH && SAFE_SRC.test(value),
};

/** A value that can be written into a document without carrying structure. */
function isPlainAttrValue(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  if (type === 'string') return (value as string).length <= MAX_ATTR_LENGTH;
  // Tiptap stores a table's column widths as a list of numbers.
  if (Array.isArray(value)) {
    return value.length <= 256 && value.every((entry) => entry === null || typeof entry === 'number');
  }
  return false;
}

function checkAttrs(
  attrs: unknown,
  path: string,
  errors: string[],
  exempt: ReadonlySet<string>,
): void {
  if (attrs === undefined || attrs === null) return;
  if (typeof attrs !== 'object' || Array.isArray(attrs)) {
    errors.push(`${path}: attrs must be an object`);
    return;
  }
  const entries = Object.entries(attrs as Record<string, unknown>);
  if (entries.length > 64) {
    errors.push(`${path}: too many attributes`);
    return;
  }
  for (const [name, value] of entries) {
    const check = ATTR_CHECKS[name];
    if (check && !exempt.has(name)) {
      if (!check(value)) errors.push(`${path}: attribute "${name}" is not valid`);
      continue;
    }
    if (!isPlainAttrValue(value)) errors.push(`${path}: attribute "${name}" is not a plain value`);
  }
}

/**
 * Attributes a node or mark cannot do without. A link with no target is not a
 * link, and letting one through means the check above never runs on it.
 */
const REQUIRED_ATTRS: Record<string, readonly string[]> = {
  [`mark:${MARK.link}`]: ['href'],
  [NODE.image]: ['src'],
};

function checkRequired(kind: string, attrs: unknown, path: string, errors: string[]): void {
  for (const name of REQUIRED_ATTRS[kind] ?? []) {
    const present =
      typeof attrs === 'object' && attrs !== null && !Array.isArray(attrs) && name in attrs;
    if (!present) errors.push(`${path}: attribute "${name}" is required`);
  }
}

/** `src` on anything other than an image is an ordinary string, not a picture. */
const NO_EXEMPTIONS: ReadonlySet<string> = new Set();
const NOT_AN_IMAGE: ReadonlySet<string> = new Set(['src']);

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
    checkAttrs(n['attrs'], path, errors, type === NODE.image ? NO_EXEMPTIONS : NOT_AN_IMAGE);
    checkRequired(type, n['attrs'], path, errors);
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
          } else if (!KNOWN_MARKS.has(m['type'])) {
            errors.push(`${path}.marks[${i}]: unknown mark "${String(m['type'])}"`);
          } else {
            checkAttrs(m['attrs'], `${path}.marks[${i}]`, errors, NOT_AN_IMAGE);
            checkRequired(`mark:${m['type']}`, m['attrs'], `${path}.marks[${i}]`, errors);
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

/**
 * Make a document satisfy `validateDoc`.
 *
 * The editor accepts whatever pasted markup carries, and a document can also
 * arrive from an uploaded file. Tightening a rule on the server without this
 * meant one pasted image or hyperlink made a document impossible to save, for
 * ever, with nothing on screen to say which element was at fault. That happened
 * twice. So the rules live in one place and the client repairs against them
 * rather than each rule being a new way to strand somebody's work.
 *
 * The repair is conservative:
 *   an attribute a node cannot do without, such as an image's source, is not
 *   repairable, so the node is dropped;
 *   any other bad attribute is removed, leaving the node with its default;
 *   a mark whose required attribute is bad is dropped, keeping the text.
 */
export function sanitizeDocument(doc: PMNode): PMNode {
  return sanitizeNode(doc) ?? emptyDoc();
}

function sanitizeAttrs(
  kind: string,
  attrs: Record<string, unknown> | undefined,
  exempt: ReadonlySet<string>,
): { attrs?: Record<string, unknown>; drop: boolean } {
  const required = new Set(REQUIRED_ATTRS[kind] ?? []);
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) {
    // A node that cannot do without an attribute, and carries none at all, is
    // not repairable. Skipping this check let the repair disagree with the
    // rules, which is the whole way a document becomes impossible to save.
    return { drop: required.size > 0 };
  }

  for (const name of required) {
    if (!(name in attrs)) return { drop: true };
  }

  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(attrs).slice(0, 64)) {
    const check = ATTR_CHECKS[name];
    const valid = check && !exempt.has(name) ? check(value) : isPlainAttrValue(value);
    if (valid) {
      kept[name] = value;
    } else if (required.has(name)) {
      return { drop: true };
    }
  }
  return { attrs: kept, drop: false };
}

function sanitizeNode(node: PMNode, depth = 0): PMNode | null {
  if (depth > 100) return null;
  if (typeof node?.type !== 'string' || !KNOWN_NODES.has(node.type)) return null;

  const exempt = node.type === NODE.image ? NO_EXEMPTIONS : NOT_AN_IMAGE;
  const attrs = sanitizeAttrs(node.type, node.attrs, exempt);
  if (attrs.drop) return null;

  const clean: PMNode = { type: node.type };
  if (attrs.attrs && Object.keys(attrs.attrs).length > 0) clean.attrs = attrs.attrs;

  if (node.type === NODE.text) {
    if (typeof node.text !== 'string') return null;
    clean.text = node.text;
  }

  if (node.marks) {
    const marks: PMMark[] = [];
    for (const mark of node.marks) {
      if (typeof mark?.type !== 'string' || !KNOWN_MARKS.has(mark.type)) continue;
      const markAttrs = sanitizeAttrs(`mark:${mark.type}`, mark.attrs, NOT_AN_IMAGE);
      if (markAttrs.drop) continue;
      marks.push(
        markAttrs.attrs && Object.keys(markAttrs.attrs).length > 0
          ? { type: mark.type, attrs: markAttrs.attrs }
          : { type: mark.type },
      );
    }
    if (marks.length > 0) clean.marks = marks;
  }

  if (node.content) {
    const content: PMNode[] = [];
    for (const child of node.content) {
      const cleaned = sanitizeNode(child, depth + 1);
      if (cleaned) content.push(cleaned);
    }
    if (content.length > 0) clean.content = content;
  }

  return clean;
}
