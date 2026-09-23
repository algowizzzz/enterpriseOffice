import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const ROMAN: [number, string][] = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
];
const roman = (value: number): string => {
  let left = Math.max(1, Math.min(value, 3999));
  let out = '';
  for (const [size, letters] of ROMAN) {
    while (left >= size) {
      out += letters;
      left -= size;
    }
  }
  return out;
};
const letters = (value: number): string => {
  // a, b, ... z, aa, bb, as Word counts them.
  const index = (Math.max(1, value) - 1) % 26;
  const repeat = Math.floor((Math.max(1, value) - 1) / 26) + 1;
  return String.fromCharCode(97 + index).repeat(Math.min(repeat, 10));
};

/** A count drawn in one of Word's numbering formats. */
export function formatNumber(value: number, format: string): string {
  switch (format) {
    case 'lowerLetter': return letters(value);
    case 'upperLetter': return letters(value).toUpperCase();
    case 'lowerRoman': return roman(value);
    case 'upperRoman': return roman(value).toUpperCase();
    case 'decimalZero': return String(value).padStart(2, '0');
    case 'bullet':
    case 'none': return '';
    default: return String(value);
  }
}

/**
 * The number each numbered heading shows, in document order.
 *
 * A heading at one level counts on from the last at that level and starts every
 * deeper level again, per numbering definition, which is the rule Word follows.
 */
export function headingNumbers(doc: PMNode): { position: number; text: string }[] {
  const counters = new Map<string, number[]>();
  const found: { position: number; text: string }[] = [];
  doc.descendants((node, position) => {
    if (node.type.name !== 'heading') return !node.isTextblock;
    const level = node.attrs['numLevel'] as number | null;
    const pattern = node.attrs['numPattern'] as string | null;
    if (level === null || level === undefined || !pattern || level < 0 || level > 8) return false;
    const key = String(node.attrs['numId'] ?? '');
    const counts = counters.get(key) ?? [];
    counts[level] = (counts[level] ?? 0) + 1;
    counts.length = level + 1;
    for (let index = 0; index < level; index += 1) counts[index] ??= 1;
    counters.set(key, counts);
    const formats = String(node.attrs['numFormats'] ?? '').split(',');
    const text = pattern.replace(/%([1-9])/gu, (_match, digit: string) => {
      const index = Number(digit) - 1;
      return formatNumber(counts[index] ?? 1, formats[index] ?? 'decimal');
    });
    if (text.trim().length > 0) found.push({ position: position + 1, text });
    return false;
  });
  return found;
}

const key = new PluginKey<DecorationSet>('headingNumbers');

/**
 * Draws clause numbers in front of numbered headings.
 *
 * They are not text: Word works them out, and so does this. Typing a number
 * into the heading instead would put "2.1" in the file twice.
 */
export const HeadingNumbers = Extension.create({
  name: 'headingNumbers',
  addProseMirrorPlugins() {
    const build = (doc: PMNode): DecorationSet =>
      DecorationSet.create(
        doc,
        headingNumbers(doc).map((entry) =>
          Decoration.widget(
            entry.position,
            () => {
              const span = document.createElement('span');
              span.className = 'heading-number';
              span.contentEditable = 'false';
              span.textContent = `${entry.text}${String.fromCodePoint(0xa0)}`;
              return span;
            },
            { side: -1, key: `n-${entry.text}` },
          ),
        ),
      );
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) => build(state.doc),
          apply: (transaction, value) => (transaction.docChanged ? build(transaction.doc) : value),
        },
        props: { decorations: (state) => key.getState(state) },
      }),
    ];
  },
});
