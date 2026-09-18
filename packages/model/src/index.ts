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
  /**
   * Something Word holds that the editor has no node for: a chart, a shape, a
   * field, a footnote mark, a bookmark, an equation. It carries a reference to
   * its own markup, kept beside the document, and goes back out untouched.
   */
  wordInline: 'wordInline',
  wordBlock: 'wordBlock',
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
  /** The run properties Word wrote that no other mark stands for. */
  wordRun: 'wordRun',
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
const MAX_SRC_LENGTH = 16 * 1024 * 1024;

/**
 * A link target that cannot execute anything. The editor restricts what can be
 * typed, but stored content can come from an uploaded file or a client that is
 * not the editor, so the rule is enforced here as well.
 */
const SAFE_HREF = /^(?:https?:\/\/[^/]|mailto:|#|\/(?!\/))/iu;

/**
 * Whether a link target is one the model will store.
 *
 * Exported so the editor can refuse the same targets as they arrive. Keeping
 * this rule on the server alone meant the editor happily held a `tel:` or
 * relative link that was stripped from every save: the person saw a link on
 * screen that was never stored and vanished on the next reload.
 */
export function isSafeHref(href: unknown): boolean {
  return typeof href === 'string' && href.length <= MAX_ATTR_LENGTH && SAFE_HREF.test(href);
}

/**
 * What an image may point at. Only data embedded in the document itself: a
 * remote address would make the page fetch something, which the air gap forbids
 * and the content security policy blocks anyway. The rule belongs here too,
 * because a document can be written by a client that is not the editor.
 */
const SAFE_SRC = /^data:image\/[a-z0-9.+-]+;base64,/iu;

/** Whether a picture is embedded in the document itself, as the air gap requires. */
export function isEmbeddedImageSrc(src: unknown): boolean {
  return typeof src === 'string' && src.length <= MAX_SRC_LENGTH && SAFE_SRC.test(src);
}

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
  href: isSafeHref,
  src: isEmbeddedImageSrc,
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

/** How much of a document the model will look at, shared by the checker and the repair. */
const MAX_NODES = 500_000;
const MAX_DEPTH = 100;

/** Nodes that sit inside a paragraph rather than beside one. */
const INLINE_NODES: ReadonlySet<string> = new Set([
  NODE.text,
  NODE.hardBreak,
  NODE.image,
  NODE.wordInline,
]);

/**
 * Nodes the editor's schema requires at least one block inside.
 *
 * ProseMirror does not throw when one arrives empty: it builds the node
 * anyway, so the person sees a document with nothing in it and nowhere to put
 * the cursor, and the first save writes that emptiness back over their work.
 * Both the check and the repair below know about this list, so a document
 * cannot be repaired into something the editor will hollow out.
 */
const NEEDS_BLOCK: ReadonlySet<string> = new Set([
  NODE.doc,
  NODE.blockquote,
  NODE.listItem,
  NODE.tableCell,
  NODE.tableHeader,
]);

/**
 * Containers that mean nothing once everything inside them has gone.
 *
 * The repair drops them, so the checker has to refuse them as well. While it
 * accepted them, opening a document holding an empty table quietly removed the
 * table and told the person something had been left out, although the checker
 * had been perfectly happy with it.
 */
const DROP_IF_EMPTY: ReadonlySet<string> = new Set([
  NODE.bulletList,
  NODE.orderedList,
  NODE.table,
  NODE.tableRow,
]);

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * A node that must hold blocks, and holds them.
 *
 * A stored document that fails this opens as an empty editor rather than as an
 * error, which is the one failure the person cannot see happening, so it is
 * checked on the way in and repaired on the way out.
 */
const hasChildren = (content: unknown): content is unknown[] =>
  Array.isArray(content) && content.length > 0;

function checkBlockContent(type: string, content: unknown, path: string, errors: string[]): void {
  if (!hasChildren(content)) {
    errors.push(`${path}: "${type}" must contain at least one block`);
    return;
  }
  const inline = content.some(
    (child) =>
      typeof child === 'object' &&
      child !== null &&
      INLINE_NODES.has((child as { type?: unknown }).type as string),
  );
  if (inline) errors.push(`${path}: "${type}" cannot hold inline content directly`);
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
    if (NEEDS_BLOCK.has(type)) checkBlockContent(type, n['content'], path, errors);
    if (DROP_IF_EMPTY.has(type) && !hasChildren(n['content'])) {
      errors.push(`${path}: "${type}" cannot be empty`);
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
 * arrive from an uploaded file or from a build that predates a rule. Tightening
 * a rule on the server without this meant one pasted image or hyperlink made a
 * document impossible to save, for ever, with nothing on screen to say which
 * element was at fault. That happened twice. So the rules live in one place and
 * the client repairs against them rather than each rule being a new way to
 * strand somebody's work.
 *
 * The repair is conservative, and above all it never produces something the
 * editor would show as blank:
 *   an attribute a node cannot do without, such as an image's source, is not
 *   repairable, so the node is dropped;
 *   any other bad attribute is removed, leaving the node with its default;
 *   a mark whose required attribute is bad is dropped, keeping the text;
 *   a node that must hold blocks and has lost them gets an empty paragraph,
 *   and a container that means nothing when empty is dropped;
 *   if nothing survives, the words are recovered into plain paragraphs rather
 *   than the document being replaced with a blank one.
 *
 * It reports whether it changed anything, so the editor can say so instead of
 * removing what somebody can see with no message at all.
 */
export interface RepairResult {
  doc: PMNode;
  /** True when anything at all was removed, replaced or restructured. */
  changed: boolean;
  /**
   * True only when something was taken away.
   *
   * Filling an empty quote with a paragraph changes a document without costing
   * anybody anything, and telling them content was left out would be a lie. The
   * editor's message is keyed on this rather than on `changed`.
   */
  removed: boolean;
}

interface RepairContext {
  /** Nodes still within the budget, mirroring the checker's node limit. */
  left: number;
  changed: boolean;
  removed: boolean;
}

/** Record that something was taken out of the document. */
function dropped(ctx: RepairContext): null {
  ctx.changed = true;
  ctx.removed = true;
  return null;
}

export function sanitizeDocument(value: unknown): PMNode {
  return repairDocument(value).doc;
}

export function repairDocument(value: unknown): RepairResult {
  const ctx: RepairContext = { left: MAX_NODES, changed: false, removed: false };
  const root = sanitizeNode(value, 0, ctx);

  if (root && root.type === NODE.doc) {
    return { doc: root, changed: ctx.changed, removed: ctx.removed };
  }

  // A root that is not a document at all still holds the person's words.
  if (root) {
    const content = asBlocks([root], ctx, 1);
    return {
      doc: { type: NODE.doc, content: content.length > 0 ? content : [{ type: NODE.paragraph }] },
      changed: true,
      removed: ctx.removed,
    };
  }

  const lines = salvageText(value);
  // Everything but the words is gone, and when there were no words the document
  // itself is.
  return {
    doc: lines.length > 0 ? docFromParagraphs(lines) : emptyDoc(),
    changed: true,
    removed: true,
  };
}

/**
 * The text of a document too malformed to repair node by node.
 *
 * Returning an empty document here would throw away work that is plainly still
 * there, so the words are read out of whatever shape the value has and put back
 * as paragraphs. Formatting is lost; the writing is not.
 */
function salvageText(value: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length >= 10000 || depth > MAX_DEPTH) return out;
  if (Array.isArray(value)) {
    for (const entry of value) salvageText(entry, out, depth + 1);
    return out;
  }
  if (typeof value !== 'object' || value === null) return out;
  const node = value as Record<string, unknown>;
  const text = node['text'];
  if (typeof text === 'string' && text.length > 0) out.push(text);
  salvageText(node['content'], out, depth + 1);
  return out;
}

function sanitizeAttrs(
  kind: string,
  attrs: unknown,
  exempt: ReadonlySet<string>,
  ctx: RepairContext,
): { attrs?: Record<string, unknown>; drop: boolean } {
  const required = REQUIRED_ATTRS[kind] ?? [];
  if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) {
    // A node that cannot do without an attribute, and carries none at all, is
    // not repairable. Skipping this check let the repair disagree with the
    // rules, which is the whole way a document becomes impossible to save.
    if (attrs !== undefined) {
      ctx.changed = true;
      ctx.removed = true;
    }
    return { drop: required.length > 0 };
  }

  const source = attrs as Record<string, unknown>;
  const accepts = (name: string, value: unknown): boolean => {
    const check = ATTR_CHECKS[name];
    return check && !exempt.has(name) ? check(value) : isPlainAttrValue(value);
  };

  // Required attributes are kept first. Truncating the list before looking at
  // them could discard the one the node cannot do without, leaving a node that
  // passed the presence check and then failed the rules for ever after.
  const kept: Record<string, unknown> = {};
  for (const name of required) {
    if (!(name in source) || !accepts(name, source[name])) return { drop: true };
    kept[name] = source[name];
  }

  for (const [name, value] of Object.entries(source)) {
    if (name in kept) continue;
    if (Object.keys(kept).length >= 64) {
      ctx.changed = true;
      ctx.removed = true;
      break;
    }
    if (accepts(name, value)) kept[name] = value;
    else {
      ctx.changed = true;
      ctx.removed = true;
    }
  }
  return { attrs: kept, drop: false };
}

function sanitizeMarks(marks: unknown, ctx: RepairContext): PMMark[] | undefined {
  if (marks === undefined || marks === null) return undefined;
  if (!Array.isArray(marks)) {
    dropped(ctx);
    return undefined;
  }
  const kept: PMMark[] = [];
  for (const mark of marks) {
    if (typeof mark !== 'object' || mark === null || Array.isArray(mark)) {
      dropped(ctx);
      continue;
    }
    const type = (mark as PMMark).type;
    if (typeof type !== 'string' || !KNOWN_MARKS.has(type)) {
      dropped(ctx);
      continue;
    }
    const attrs = sanitizeAttrs(`mark:${type}`, (mark as PMMark).attrs, NOT_AN_IMAGE, ctx);
    if (attrs.drop) {
      dropped(ctx);
      continue;
    }
    kept.push(
      attrs.attrs && Object.keys(attrs.attrs).length > 0 ? { type, attrs: attrs.attrs } : { type },
    );
  }
  return kept.length > 0 ? kept : undefined;
}

function sanitizeChildren(content: unknown, depth: number, ctx: RepairContext): PMNode[] {
  if (content === undefined || content === null) return [];
  if (!Array.isArray(content)) {
    // Reaching this used to throw out of the editor's own start-up, which took
    // the whole page down with no message and no way back to the document.
    dropped(ctx);
    return [];
  }
  const kept: PMNode[] = [];
  for (const child of content) {
    const cleaned = sanitizeNode(child, depth + 1, ctx);
    if (cleaned) kept.push(cleaned);
  }
  return kept;
}

/**
 * Wrap loose inline content in paragraphs, so a block container holds blocks.
 *
 * `depth` is where the wrapper would sit. A wrapper deeper than the checker
 * allows would make the document unsavable, and its content could not have been
 * kept at that depth anyway, so it is dropped instead of wrapped.
 */
function asBlocks(children: PMNode[], ctx: RepairContext, depth: number): PMNode[] {
  const blocks: PMNode[] = [];
  let run: PMNode[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    ctx.changed = true;
    const wrapped = run;
    run = [];
    if (depth + 1 > MAX_DEPTH) {
      ctx.removed = true;
      return;
    }
    // Charged like any other node: a wrapper the repair invents counts against
    // the same budget, or a repaired document can come back over the limit.
    ctx.left -= 1;
    blocks.push({ type: NODE.paragraph, content: wrapped });
  };
  for (const child of children) {
    if (INLINE_NODES.has(child.type)) run.push(child);
    else {
      flush();
      blocks.push(child);
    }
  }
  flush();
  return blocks;
}

function sanitizeNode(value: unknown, depth: number, ctx: RepairContext): PMNode | null {
  if (depth > MAX_DEPTH) return dropped(ctx);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return dropped(ctx);
  const node = value as PMNode;
  if (typeof node.type !== 'string' || !KNOWN_NODES.has(node.type)) return dropped(ctx);

  // The checker refuses a document past its node budget, so a repair that kept
  // every node produced another document nobody could save. A node that must
  // hold a block reserves a second place for the paragraph it may need, and
  // gives it back once it turns out to have content of its own: counting only
  // the nodes that were already there let the substitutes push the total back
  // over the limit.
  const reserve = NEEDS_BLOCK.has(node.type) ? 2 : 1;
  if (ctx.left < reserve) return dropped(ctx);
  ctx.left -= reserve;

  /** Give the places back when this node turns out not to be kept. */
  const refund = (): null => {
    ctx.left += reserve;
    return dropped(ctx);
  };

  const exempt = node.type === NODE.image ? NO_EXEMPTIONS : NOT_AN_IMAGE;
  const attrs = sanitizeAttrs(node.type, node.attrs, exempt, ctx);
  if (attrs.drop) return refund();

  const clean: PMNode = { type: node.type };
  if (attrs.attrs && Object.keys(attrs.attrs).length > 0) clean.attrs = attrs.attrs;

  const marks = sanitizeMarks(node.marks, ctx);
  if (marks) clean.marks = marks;

  if (node.type === NODE.text) {
    if (typeof node.text !== 'string' || node.text.length === 0) return refund();
    // A text node carrying children is refused by the checker, so the repair
    // returns here rather than copying them across.
    if (node.content !== undefined) dropped(ctx);
    clean.text = node.text;
    return clean;
  }

  const children = sanitizeChildren(node.content, depth, ctx);

  if (NEEDS_BLOCK.has(node.type)) {
    const blocks = asBlocks(children, ctx, depth + 1);
    if (blocks.length > 0) {
      ctx.left += 1; // the reserved place was not needed
      clean.content = blocks;
      return clean;
    }
    // Nothing left inside something that cannot be empty. An empty paragraph is
    // a place to type; no content at all is a document that opens blank.
    if (depth + 1 > MAX_DEPTH) return refund();
    ctx.changed = true;
    clean.content = [{ type: NODE.paragraph }];
    return clean;
  }

  if (children.length > 0) clean.content = children;
  else if (DROP_IF_EMPTY.has(node.type)) return refund();

  return clean;
}

/**
 * What sits outside the body of a document: the running header, the running
 * footer and the orientation of the page.
 *
 * None of it belongs in the body, because none of it is content somebody types
 * into the flow of the document, and ProseMirror has nowhere sensible to put
 * it. It is stored beside the document and read and written by both ends, so a
 * Word file that arrives with a header leaves with the same one.
 */
export interface PageSetup {
  header: string;
  footer: string;
  orientation: 'portrait' | 'landscape';
}

/** How long a running header or footer may be. Word allows more; this is a line. */
export const MAX_RUNNING_TEXT = 300;

export function defaultPageSetup(): PageSetup {
  return { header: '', footer: '', orientation: 'portrait' };
}

/** Read page setup from anything, falling back to the default field by field. */
export function pageSetupFrom(value: unknown): PageSetup {
  const setup = defaultPageSetup();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return setup;
  const source = value as Record<string, unknown>;
  const line = (raw: unknown): string =>
    typeof raw === 'string' ? raw.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, MAX_RUNNING_TEXT) : '';
  return {
    header: line(source['header']),
    footer: line(source['footer']),
    orientation: source['orientation'] === 'landscape' ? 'landscape' : 'portrait',
  };
}

/** Whether a page setup is the default, which is what a blank document has. */
export function isDefaultPageSetup(setup: PageSetup): boolean {
  return setup.header === '' && setup.footer === '' && setup.orientation === 'portrait';
}

/**
 * What a style looks like, resolved. Measurements are in twips (twentieths of a
 * point), as Word states them, and sizes in points.
 */
export interface StyleProps {
  fontFamily?: string | undefined;
  fontSize?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  caps?: boolean;
  smallCaps?: boolean;
  textAlign?: Alignment | undefined;
  indentLeft?: number;
  indentRight?: number;
  /** Negative for a hanging indent. */
  indentFirstLine?: number;
  spacingBefore?: number;
  spacingAfter?: number;
  /** A multiple of the line, such as 1.15. */
  lineHeight?: number;
  /** An exact line height, in twips. */
  lineExact?: number;
  background?: string;
  outlineLevel?: number;
}

export interface StyleEntry {
  name: string;
  props: StyleProps;
}

/** A document's own styles, as read from the file it came from. */
export interface StyleTable {
  defaults: StyleProps;
  paragraph: Record<string, StyleEntry>;
  character: Record<string, StyleEntry>;
  defaultParagraph?: string;
}

/**
 * Fonts a machine with no Office installed will not have, and what to draw
 * instead. The metric-compatible replacements are tried first, so lines break
 * where they broke in Word.
 */
const FONT_FALLBACKS: Record<string, string> = {
  calibri: 'Carlito, "Segoe UI", Arial, sans-serif',
  aptos: '"Segoe UI", Carlito, Arial, sans-serif',
  cambria: 'Caladea, Georgia, serif',
  arial: '"Liberation Sans", Helvetica, sans-serif',
  'times new roman': '"Liberation Serif", Times, serif',
  'courier new': '"Liberation Mono", Courier, monospace',
};

/** A font name that is safe to write into a stylesheet. */
export function cssFontFamily(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const clean = name.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 80);
  if (clean.length === 0) return null;
  const fallback = FONT_FALLBACKS[clean.toLowerCase()] ?? 'sans-serif';
  return `"${clean}", ${fallback}`;
}

const CSS_COLOUR = /^#[0-9a-f]{6}$/iu;
const twipsToPx = (twips: number): number => Math.round((twips / 15) * 100) / 100;
const bounded = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;

/**
 * The declarations that draw a set of style properties.
 *
 * Every value is rebuilt from a number, a fixed word or a checked pattern, and
 * nothing from the file is copied into the stylesheet as it stands: a style
 * name is attacker-controlled text, and a stylesheet is a place text can do
 * harm.
 */
export function cssDeclarations(props: StyleProps): string[] {
  const css: string[] = [];
  const family = cssFontFamily(props.fontFamily);
  if (family) css.push(`font-family: ${family}`);
  const size = bounded(props.fontSize, 1, 400);
  if (size !== null) css.push(`font-size: ${size}pt`);
  if (typeof props.color === 'string' && CSS_COLOUR.test(props.color)) css.push(`color: ${props.color}`);
  if (props.bold !== undefined) css.push(`font-weight: ${props.bold ? '700' : '400'}`);
  if (props.italic !== undefined) css.push(`font-style: ${props.italic ? 'italic' : 'normal'}`);
  const lines = [props.underline ? 'underline' : '', props.strike ? 'line-through' : ''].filter(Boolean);
  if (lines.length > 0) css.push(`text-decoration: ${lines.join(' ')}`);
  else if (props.underline === false || props.strike === false) css.push('text-decoration: none');
  if (props.caps) css.push('text-transform: uppercase');
  if (props.smallCaps) css.push('font-variant: small-caps');
  if (props.textAlign && ALIGNMENTS.has(props.textAlign)) css.push(`text-align: ${props.textAlign}`);
  const left = bounded(props.indentLeft, -20000, 20000);
  if (left !== null) css.push(`margin-left: ${twipsToPx(left)}px`);
  const right = bounded(props.indentRight, -20000, 20000);
  if (right !== null) css.push(`margin-right: ${twipsToPx(right)}px`);
  const first = bounded(props.indentFirstLine, -20000, 20000);
  if (first !== null) css.push(`text-indent: ${twipsToPx(first)}px`);
  const before = bounded(props.spacingBefore, 0, 20000);
  if (before !== null) css.push(`margin-top: ${twipsToPx(before)}px`);
  const after = bounded(props.spacingAfter, 0, 20000);
  if (after !== null) css.push(`margin-bottom: ${twipsToPx(after)}px`);
  const height = bounded(props.lineHeight, 0.5, 10);
  const exact = bounded(props.lineExact, 20, 20000);
  if (height !== null) css.push(`line-height: ${Math.round(height * 1.2 * 100) / 100}`);
  else if (exact !== null) css.push(`line-height: ${twipsToPx(exact)}px`);
  if (typeof props.background === 'string' && CSS_COLOUR.test(props.background)) {
    css.push(`background-color: ${props.background}`);
  }
  return css;
}

/** A style id as it may appear in an attribute selector. */
export function cssStyleId(id: unknown): string | null {
  return typeof id === 'string' && /^[\w .-]{1,120}$/u.test(id) ? id : null;
}

/** Read a style table from anything, keeping only what is shaped like one. */
export function styleTableFrom(value: unknown): StyleTable | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const source = value as Partial<StyleTable>;
  const entries = (group: unknown): Record<string, StyleEntry> => {
    const kept: Record<string, StyleEntry> = {};
    if (typeof group !== 'object' || group === null) return kept;
    for (const [id, entry] of Object.entries(group as Record<string, unknown>).slice(0, 2000)) {
      if (!cssStyleId(id) || typeof entry !== 'object' || entry === null) continue;
      const { name, props } = entry as Partial<StyleEntry>;
      kept[id] = {
        name: typeof name === 'string' ? name.slice(0, 120) : id,
        props: typeof props === 'object' && props !== null ? props : {},
      };
    }
    return kept;
  };
  return {
    defaults: typeof source.defaults === 'object' && source.defaults !== null ? source.defaults : {},
    paragraph: entries(source.paragraph),
    character: entries(source.character),
    ...(cssStyleId(source.defaultParagraph) ? { defaultParagraph: source.defaultParagraph as string } : {}),
  };
}

/**
 * The stylesheet that draws a document's own styles inside `scope`.
 *
 * The defaults go on the page, each paragraph style on the blocks that name it,
 * each character style on the runs that name it. Direct formatting is written
 * inline by the editor and so still wins, as it does in Word.
 */
export function styleSheetFor(table: StyleTable | null, scope = '.page'): string {
  if (!table) return '';
  const rules: string[] = [];
  const rule = (selector: string, props: StyleProps): void => {
    const css = cssDeclarations(props);
    if (css.length > 0) rules.push(`${selector} { ${css.join('; ')}; }`);
  };
  const base = table.defaultParagraph ? table.paragraph[table.defaultParagraph]?.props : undefined;
  // The page takes the look of the default style, but not its indent: that
  // belongs to each paragraph, and on the page it would shift every table too.
  const { indentLeft: _left, indentRight: _right, indentFirstLine: _first, ...page } = {
    ...table.defaults,
    ...(base ?? {}),
  };
  rule(scope, page);
  rule(`${scope} p, ${scope} h1, ${scope} h2, ${scope} h3, ${scope} h4, ${scope} h5, ${scope} h6`, {
    spacingBefore: base?.spacingBefore ?? table.defaults.spacingBefore ?? 0,
    spacingAfter: base?.spacingAfter ?? table.defaults.spacingAfter ?? 0,
  });
  for (const [id, entry] of Object.entries(table.paragraph)) {
    if (cssStyleId(id)) rule(`${scope} [data-style="${id}"]`, entry.props);
  }
  for (const [id, entry] of Object.entries(table.character)) {
    if (cssStyleId(id)) rule(`${scope} [data-run-style="${id}"]`, entry.props);
  }
  return rules.join('\n');
}
