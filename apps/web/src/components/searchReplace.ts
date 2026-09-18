import { Extension, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface SearchQuery {
  text: string;
  matchCase: boolean;
  wholeWord: boolean;
}

export interface SearchMatch {
  from: number;
  to: number;
}

interface SearchState {
  query: SearchQuery;
  matches: SearchMatch[];
  current: number;
  decorations: DecorationSet;
}

export const searchKey = new PluginKey<SearchState>('searchReplace');

const EMPTY: SearchQuery = { text: '', matchCase: false, wholeWord: false };
/** Enough for any document; a bound so a one-letter search cannot freeze a long one. */
const MAX_MATCHES = 5000;

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Every place the query occurs. The search runs one paragraph at a time over
 * its text as a whole, so a word that is half bold is still found, and never
 * matches across two paragraphs, which is what Word does as well.
 */
export function findMatches(doc: PMNode, query: SearchQuery): SearchMatch[] {
  if (query.text.length === 0) return [];
  const body = escapeForRegExp(query.text);
  const pattern = new RegExp(
    query.wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body,
    query.matchCase ? 'gu' : 'giu',
  );
  const matches: SearchMatch[] = [];
  doc.descendants((node, position) => {
    if (!node.isTextblock) return true;
    if (matches.length >= MAX_MATCHES) return false;
    // Offsets into this string are offsets into the block's content: anything
    // that is not text takes one position there and one character here.
    let text = '';
    node.forEach((inner) => {
      text += inner.isText ? (inner.text ?? '') : String.fromCodePoint(0xfffc).repeat(inner.nodeSize);
    });
    for (const found of text.matchAll(pattern)) {
      if (found[0].length === 0) continue;
      const from = position + 1 + found.index;
      matches.push({ from, to: from + found[0].length });
      if (matches.length >= MAX_MATCHES) break;
    }
    return false;
  });
  return matches;
}

function build(doc: PMNode, query: SearchQuery, wanted: number): SearchState {
  const matches = findMatches(doc, query);
  const current = matches.length === 0 ? -1 : Math.min(Math.max(wanted, 0), matches.length - 1);
  return {
    query,
    matches,
    current,
    decorations: DecorationSet.create(
      doc,
      matches.map((match, index) =>
        Decoration.inline(match.from, match.to, { class: index === current ? 'search-hit search-hit-current' : 'search-hit' }),
      ),
    ),
  };
}

export const SearchReplace = Extension.create({
  name: 'searchReplace',
  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchKey,
        state: {
          init: (_config, state) => build(state.doc, EMPTY, -1),
          apply(transaction, value, _old, state) {
            const meta = transaction.getMeta(searchKey) as { query?: SearchQuery; current?: number } | undefined;
            if (meta) return build(state.doc, meta.query ?? value.query, meta.current ?? value.current);
            if (!transaction.docChanged || value.query.text.length === 0) return value;
            // The text moved under the search: look again, staying near where we were.
            return build(state.doc, value.query, value.current);
          },
        },
        props: {
          decorations: (state) => searchKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
      }),
    ];
  },
});

export const searchState = (editor: Editor): SearchState | undefined => searchKey.getState(editor.state);

export function setSearch(editor: Editor, query: SearchQuery): void {
  // Start from the first match at or after the cursor, as Word does.
  const matches = findMatches(editor.state.doc, query);
  const from = editor.state.selection.from;
  const near = matches.findIndex((match) => match.to >= from);
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, { query, current: near === -1 ? 0 : near }));
  reveal(editor);
}

export function clearSearch(editor: Editor): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, { query: EMPTY, current: -1 }));
}

function reveal(editor: Editor): void {
  const state = searchState(editor);
  const match = state?.matches[state.current];
  if (!match) return;
  const transaction = editor.state.tr
    .setSelection(TextSelection.create(editor.state.doc, match.from, match.to))
    .scrollIntoView();
  editor.view.dispatch(transaction);
}

export function stepSearch(editor: Editor, direction: 1 | -1): void {
  const state = searchState(editor);
  if (!state || state.matches.length === 0) return;
  const next = (state.current + direction + state.matches.length) % state.matches.length;
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, { current: next }));
  reveal(editor);
}

/**
 * Replace the current match, keeping the formatting of the words replaced, and
 * move on to the next. Goes through the ordinary transaction path, so that with
 * tracking on a replacement is a tracked deletion and a tracked insertion.
 */
export function replaceCurrent(editor: Editor, replacement: string): boolean {
  const state = searchState(editor);
  const match = state?.matches[state.current];
  if (!state || !match) return false;
  const marks = editor.state.doc.resolve(match.from + 1).marks();
  const transaction = editor.state.tr;
  if (replacement.length === 0) transaction.delete(match.from, match.to);
  else transaction.replaceWith(match.from, match.to, editor.state.schema.text(replacement, marks));
  editor.view.dispatch(transaction.setMeta(searchKey, { current: state.current }));
  reveal(editor);
  return true;
}

/** Replace every match, in one step that one undo takes back. Returns how many. */
export function replaceAll(editor: Editor, replacement: string): number {
  const state = searchState(editor);
  if (!state || state.matches.length === 0) return 0;
  const transaction = editor.state.tr;
  // From the end backwards, so that a replacement of a different length never
  // moves a match that is still to be replaced.
  for (const match of [...state.matches].reverse()) {
    const marks = editor.state.doc.resolve(match.from + 1).marks();
    if (replacement.length === 0) transaction.delete(match.from, match.to);
    else transaction.replaceWith(match.from, match.to, editor.state.schema.text(replacement, marks));
  }
  editor.view.dispatch(transaction);
  return state.matches.length;
}
