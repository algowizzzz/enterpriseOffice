import { Extension, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** What a dictionary has to be able to do. nspell does; so does a test's stand-in. */
export interface Speller {
  correct: (word: string) => boolean;
  suggest: (word: string) => string[];
  add: (word: string) => void;
}

export type SpellLanguage = 'en-GB' | 'en-US';

interface SpellState {
  speller: Speller | null;
  /** Bumped when words are added, so that what was checked before is checked again. */
  generation: number;
  decorations: DecorationSet;
}

export const spellKey = new PluginKey<SpellState>('spellcheck');

export interface Misspelling {
  from: number;
  to: number;
  word: string;
}

const WORD = /[\p{L}][\p{L}\p{M}'’]*/gu;

/**
 * The words in a stretch of text that the dictionary does not know.
 *
 * Left alone, as Word leaves them by default: words in capitals (acronyms),
 * words with a digit in them (references, part numbers), single letters, and
 * anything in an address.
 */
export function misspellingsIn(text: string, speller: Speller): { start: number; end: number; word: string }[] {
  const found: { start: number; end: number; word: string }[] = [];
  for (const match of text.matchAll(WORD)) {
    const raw = match[0].replace(/['’]+$/u, '');
    const start = match.index;
    const end = start + raw.length;
    // "CISO's" is an acronym with a possessive on it, and still an acronym.
    const stem = raw.replace(/['’]s$/iu, '');
    if (raw.length < 2 || stem === stem.toUpperCase()) continue;
    if (/[\p{N}@/\\_]/u.test(text[end] ?? '') || /[\p{N}@/\\_.]/u.test(text[start - 1] ?? '')) continue;
    const word = raw.replace(/’/gu, "'");
    if (speller.correct(word)) continue;
    // A possessive of a word it knows, and a word it only knows uncapitalised
    // at the start of a sentence.
    if (/'s$/iu.test(word) && speller.correct(word.slice(0, -2))) continue;
    if (speller.correct(word.toLowerCase())) continue;
    found.push({ start, end, word });
  }
  return found;
}

/**
 * Underlines misspelt words, from a dictionary that ships with the application.
 *
 * The browser has a spell check of its own, and on a locked-down workstation it
 * may be switched off, send what is typed to a service, or know only American.
 * This one needs nothing but the page. Each paragraph is checked once and
 * remembered by its text, so typing in one paragraph of a long document does
 * not check the rest again.
 */
export const Spellcheck = Extension.create({
  name: 'spellcheck',
  addProseMirrorPlugins() {
    const cache = new Map<string, { start: number; end: number; word: string }[]>();
    let cachedFor = -1;

    const build = (doc: PMNode, speller: Speller | null, generation: number): DecorationSet => {
      if (!speller) return DecorationSet.empty;
      if (cachedFor !== generation) {
        cache.clear();
        cachedFor = generation;
      }
      const decorations: Decoration[] = [];
      doc.descendants((node, position) => {
        if (!node.isTextblock) return true;
        let text = '';
        node.forEach((inner) => {
          // A tracked deletion is not part of what the document says.
          const gone = inner.marks.some((mark) => mark.type.name === 'deletion');
          text += inner.isText && !gone ? (inner.text ?? '') : ' '.repeat(inner.nodeSize);
        });
        let found = cache.get(text);
        if (!found) {
          found = misspellingsIn(text, speller);
          if (cache.size > 20000) cache.clear();
          cache.set(text, found);
        }
        for (const entry of found) {
          decorations.push(
            Decoration.inline(position + 1 + entry.start, position + 1 + entry.end, {
              class: 'spell-error',
              'data-word': entry.word,
            }),
          );
        }
        return false;
      });
      return DecorationSet.create(doc, decorations);
    };

    return [
      new Plugin<SpellState>({
        key: spellKey,
        state: {
          init: () => ({ speller: null, generation: 0, decorations: DecorationSet.empty }),
          apply(transaction, value, _old, state) {
            const meta = transaction.getMeta(spellKey) as { speller?: Speller | null; recheck?: boolean } | undefined;
            if (meta) {
              const speller = meta.speller === undefined ? value.speller : meta.speller;
              const generation = value.generation + 1;
              return { speller, generation, decorations: build(state.doc, speller, generation) };
            }
            if (!transaction.docChanged || !value.speller) return value;
            return { ...value, decorations: build(state.doc, value.speller, value.generation) };
          },
        },
        props: { decorations: (state) => spellKey.getState(state)?.decorations ?? DecorationSet.empty },
      }),
    ];
  },
});

export function setSpeller(editor: Editor, speller: Speller | null): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(spellKey, { speller }));
  // Two red underlines under one word, one of them the browser's, helps nobody.
  editor.view.dom.setAttribute('spellcheck', speller ? 'false' : 'true');
}

/** Check everything again, after a word has been added to the dictionary. */
export function recheckSpelling(editor: Editor): void {
  if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(spellKey, { recheck: true }));
}

/** The misspelling at a position, if there is one. */
export function misspellingAt(editor: Editor, position: number): Misspelling | null {
  const found = spellKey.getState(editor.state)?.decorations.find(position, position) ?? [];
  const hit = found[0];
  if (!hit) return null;
  return { from: hit.from, to: hit.to, word: editor.state.doc.textBetween(hit.from, hit.to) };
}

/** Replace a misspelt word, keeping its formatting. */
export function correctSpelling(editor: Editor, target: Misspelling, replacement: string): void {
  const marks = editor.state.doc.resolve(target.from + 1).marks();
  editor.view.dispatch(
    editor.state.tr.replaceWith(target.from, target.to, editor.state.schema.text(replacement, marks)),
  );
}

// The dictionaries are files of the application, fetched from this origin when
// spelling is first switched on. Reached by path because the packages export
// only a Node entry point that reads them from disk.
const FILES: Record<SpellLanguage, () => Promise<[{ default: string }, { default: string }]>> = {
  'en-GB': () =>
    Promise.all([
      import('../../../../node_modules/dictionary-en-gb/index.aff?url'),
      import('../../../../node_modules/dictionary-en-gb/index.dic?url'),
    ]),
  'en-US': () =>
    Promise.all([
      import('../../../../node_modules/dictionary-en/index.aff?url'),
      import('../../../../node_modules/dictionary-en/index.dic?url'),
    ]),
};

const loaded = new Map<SpellLanguage, Promise<Speller>>();

/** The dictionary for a language, loaded once. About half a megabyte and a second. */
export function loadSpeller(language: SpellLanguage): Promise<Speller> {
  let pending = loaded.get(language);
  if (!pending) {
    pending = (async () => {
      const [{ default: nspell }, [aff, dic]] = await Promise.all([import('nspell'), FILES[language]()]);
      const [affix, words] = await Promise.all(
        [aff.default, dic.default].map(async (url) => {
          const response = await fetch(url, { credentials: 'same-origin' });
          if (!response.ok) throw new Error('The dictionary could not be loaded.');
          return response.text();
        }),
      );
      return nspell(affix as string, words as string);
    })();
    loaded.set(language, pending);
    pending.catch(() => loaded.delete(language));
  }
  return pending;
}
