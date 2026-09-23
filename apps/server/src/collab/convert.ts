/**
 * The document model to and from the shared (CRDT) form.
 *
 * The mapping is the one `y-prosemirror` uses in the browser, so both ends read
 * the same shared document: a node is an XML element named after its type with
 * its attributes on it, and a run of text nodes is one XML text whose formatting
 * attributes are its marks, keyed by mark name.
 *
 * It is written out here rather than imported because the library needs a
 * ProseMirror schema to build a document, and the schema lives in the browser.
 * The model's JSON needs no schema to walk. A test asserts that what this
 * writes, the browser's binding reads back as the same document.
 */
import * as Y from 'yjs';
import { NODE, type PMMark, type PMNode } from '@docforge/model';

/** The name of the shared fragment. Tiptap's collaboration extension uses this one. */
export const FRAGMENT = 'default';

type Attributes = Record<string, unknown>;

const marksToAttributes = (marks: PMMark[] | undefined): Attributes => {
  const attributes: Attributes = {};
  for (const mark of marks ?? []) attributes[mark.type] = mark.attrs ?? {};
  return attributes;
};

function toShared(node: PMNode): Y.XmlElement {
  const element = new Y.XmlElement(node.type);
  for (const [name, value] of Object.entries(node.attrs ?? {})) {
    if (value !== null && value !== undefined) element.setAttribute(name, value as string);
  }
  const children: (Y.XmlElement | Y.XmlText)[] = [];
  let run: PMNode[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const text = new Y.XmlText();
    text.applyDelta(run.map((piece) => ({ insert: piece.text ?? '', attributes: marksToAttributes(piece.marks) })));
    children.push(text);
    run = [];
  };
  for (const inner of node.content ?? []) {
    if (inner.type === NODE.text) run.push(inner);
    else {
      flush();
      // The binding keeps marks on text only, so a mark on an inline object (a
      // tracked change on a picture) does not travel. It is left off here as
      // well, so that both ends agree about what the shared document says.
      children.push(toShared(inner));
    }
  }
  flush();
  if (children.length > 0) element.insert(0, children);
  return element;
}

/** Fill an empty shared document from the model. */
export function seedShared(shared: Y.Doc, doc: PMNode): void {
  const fragment = shared.getXmlFragment(FRAGMENT);
  shared.transact(() => {
    fragment.insert(0, (doc.content ?? []).map(toShared));
  }, 'seed');
}

function fromShared(item: Y.XmlElement | Y.XmlText | Y.XmlHook): PMNode[] {
  if (item instanceof Y.XmlText) {
    const pieces: PMNode[] = [];
    for (const op of item.toDelta() as { insert: unknown; attributes?: Attributes }[]) {
      if (typeof op.insert !== 'string' || op.insert.length === 0) continue;
      const marks = Object.entries(op.attributes ?? {}).map(([key, attrs]) => {
        // Marks that may overlap themselves (tracked changes, kept run
        // properties) are keyed by the binding as "name--hash".
        const type = /^(.+)--[A-Za-z0-9+/=]{8}$/u.exec(key)?.[1] ?? key;
        const kept = attrs && typeof attrs === 'object' ? Object.entries(attrs as Attributes).filter(([, v]) => v !== null) : [];
        return kept.length > 0 ? { type, attrs: Object.fromEntries(kept) } : { type };
      });
      pieces.push({ type: NODE.text, text: op.insert, ...(marks.length > 0 ? { marks } : {}) });
    }
    return pieces;
  }
  if (!(item instanceof Y.XmlElement)) return [];
  const node: PMNode = { type: item.nodeName };
  const attrs: Attributes = {};
  for (const [name, value] of Object.entries(item.getAttributes())) {
    if (value !== null && value !== undefined) attrs[name] = value;
  }
  if (Object.keys(attrs).length > 0) node.attrs = attrs;
  const content = item.toArray().flatMap((inner) => fromShared(inner as Y.XmlElement | Y.XmlText));
  if (content.length > 0) node.content = content;
  return [node];
}

/** The shared document as the model stores it. */
export function readShared(shared: Y.Doc): PMNode {
  const content = shared
    .getXmlFragment(FRAGMENT)
    .toArray()
    .flatMap((inner) => fromShared(inner as Y.XmlElement | Y.XmlText));
  return { type: NODE.doc, content: content.length > 0 ? content : [{ type: NODE.paragraph }] };
}
