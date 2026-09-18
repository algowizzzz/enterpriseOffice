/**
 * A small, strict XML reader.
 *
 * OOXML is namespaced XML, and the parts this reads are written by Word and by
 * this product, not by people. It needs elements, attributes, text, CDATA and
 * entities, and nothing else: no DTDs, no entity declarations, no processing of
 * anything a document could use to make the reader do work on its behalf.
 *
 * Names are kept with their prefix (`w:p`, `a:blip`) because every part this
 * reads declares the usual prefixes, and resolving them would add a table to
 * carry for no gain in what can be read.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | { text: string };

export const isElement = (node: XmlNode): node is XmlElement => 'name' in node;

/** How deep a document may nest before it is refused rather than overflowing. */
const MAX_DEPTH = 200;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeXmlText(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/gu, (match, dec, hex, name) => {
    if (dec !== undefined) return codePoint(Number(dec)) ?? match;
    if (hex !== undefined) return codePoint(Number.parseInt(hex, 16)) ?? match;
    return ENTITIES[String(name).toLowerCase()] ?? match;
  });
}

function codePoint(value: number): string | null {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return null;
  if (value >= 0xd800 && value <= 0xdfff) return null;
  return String.fromCodePoint(value);
}

/** Parse a whole XML part. Throws on markup it cannot make sense of. */
export function parseXml(source: string): XmlElement {
  let at = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;

  const fail = (why: string): never => {
    throw new Error(`${why} at offset ${at}`);
  };

  while (at < source.length) {
    const next = source.indexOf('<', at);
    if (next < 0) break;

    if (next > at) {
      const text = source.slice(at, next);
      const parent = stack[stack.length - 1];
      if (parent && text.length > 0) parent.children.push({ text: decodeXmlText(text) });
    }
    at = next;

    if (source.startsWith('<?', at)) {
      const end = source.indexOf('?>', at);
      if (end < 0) fail('unterminated declaration');
      at = end + 2;
      continue;
    }
    if (source.startsWith('<!--', at)) {
      const end = source.indexOf('-->', at);
      if (end < 0) fail('unterminated comment');
      at = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', at)) {
      const end = source.indexOf(']]>', at);
      if (end < 0) fail('unterminated CDATA');
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push({ text: source.slice(at + 9, end) });
      at = end + 3;
      continue;
    }
    if (source.startsWith('<!', at)) {
      // A doctype or anything else declarative is skipped rather than read: it
      // is where XML parsers are asked to fetch and expand things.
      const end = source.indexOf('>', at);
      if (end < 0) fail('unterminated declaration');
      at = end + 1;
      continue;
    }

    if (source.startsWith('</', at)) {
      const end = source.indexOf('>', at);
      if (end < 0) fail('unterminated closing tag');
      const name = source.slice(at + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) fail(`closing tag "${name}" does not match`);
      at = end + 1;
      continue;
    }

    // An opening tag. Find its end, allowing for quoted attribute values.
    let cursor = at + 1;
    let quote: string | null = null;
    while (cursor < source.length) {
      const character = source[cursor];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
      cursor += 1;
    }
    if (cursor >= source.length) fail('unterminated tag');

    const selfClosing = source[cursor - 1] === '/';
    const inner = source.slice(at + 1, selfClosing ? cursor - 1 : cursor);
    const nameMatch = /^([^\s/>]+)/u.exec(inner);
    if (!nameMatch) return fail('tag without a name');
    const element: XmlElement = {
      name: nameMatch[1] as string,
      attrs: readAttrs(inner.slice(nameMatch[0].length)),
      children: [],
    };

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (root) fail('more than one root element');
    else root = element;

    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) fail('nested too deeply');
      stack.push(element);
    }
    at = cursor + 1;
  }

  if (stack.length > 0) throw new Error(`unclosed element "${stack[stack.length - 1]?.name}"`);
  if (!root) throw new Error('no root element');
  return root;
}

const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/gu;

function readAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(ATTR)) {
    attrs[match[1] as string] = decodeXmlText(match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/** Direct children with the given name. */
export function childrenNamed(element: XmlElement | undefined, name: string): XmlElement[] {
  if (!element) return [];
  return element.children.filter((node): node is XmlElement => isElement(node) && node.name === name);
}

/** The first direct child with the given name, following a path if given. */
export function child(element: XmlElement | undefined, ...path: string[]): XmlElement | undefined {
  let current = element;
  for (const name of path) {
    current = childrenNamed(current, name)[0];
    if (!current) return undefined;
  }
  return current;
}

/** An attribute of a descendant reached by the given path. */
export function attrOf(
  element: XmlElement | undefined,
  path: string[],
  attribute: string,
): string | undefined {
  return child(element, ...path)?.attrs[attribute];
}

/** Every element with the given name, at any depth. */
export function descendants(element: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  const walk = (node: XmlElement): void => {
    for (const candidate of node.children) {
      if (!isElement(candidate)) continue;
      if (candidate.name === name) found.push(candidate);
      walk(candidate);
    }
  };
  walk(element);
  return found;
}

/** All text beneath an element, in document order. */
export function textOf(element: XmlElement): string {
  let text = '';
  const walk = (node: XmlNode): void => {
    if (!isElement(node)) {
      text += node.text;
      return;
    }
    for (const candidate of node.children) walk(candidate);
  };
  walk(element);
  return text;
}
