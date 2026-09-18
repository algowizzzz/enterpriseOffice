import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import type { PMNode } from '@docforge/model';
import { editorExtensions } from '../src/components/editorExtensions';
import { findMatches, replaceAll, replaceCurrent, searchState, setSearch, stepSearch } from '../src/components/searchReplace';
import { listChanges, setTracking } from '../src/components/trackChanges';

const content: PMNode = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'The Record ' },
        { type: 'text', text: 'Own', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'er keeps each record. Records are reviewed.' },
      ],
    },
    { type: 'paragraph', content: [{ type: 'text', text: 'A record owner signs. RECORD kept.' }] },
  ],
};
const open = (): Editor => new Editor({ extensions: editorExtensions, content });
const query = (text: string, more: Partial<{ matchCase: boolean; wholeWord: boolean }> = {}) => ({ text, matchCase: false, wholeWord: false, ...more });

describe('find', () => {
  it('finds a word that is half bold, because a reader sees one word', () => {
    const editor = open();
    expect(findMatches(editor.state.doc, query('Owner'))).toHaveLength(2);
    editor.destroy();
  });

  it('tells capitals apart only when asked to', () => {
    const editor = open();
    expect(findMatches(editor.state.doc, query('record'))).toHaveLength(5);
    expect(findMatches(editor.state.doc, query('record', { matchCase: true }))).toHaveLength(2);
    editor.destroy();
  });

  it('finds whole words only when asked to, so "record" does not match "Records"', () => {
    const editor = open();
    expect(findMatches(editor.state.doc, query('record', { wholeWord: true }))).toHaveLength(4);
    editor.destroy();
  });

  it('treats what is typed as words, not as a pattern', () => {
    // Somebody searching for "(a)" or "1.2" in a policy means those characters.
    const editor = new Editor({
      extensions: editorExtensions,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'See clause 1.2 (a) and 102.' }] }] },
    });
    expect(findMatches(editor.state.doc, query('1.2'))).toHaveLength(1);
    expect(findMatches(editor.state.doc, query('(a)'))).toHaveLength(1);
    editor.destroy();
  });

  it('goes round from the last match to the first', () => {
    const editor = open();
    setSearch(editor, query('owner'));
    expect(searchState(editor)?.current).toBe(0);
    stepSearch(editor, 1);
    stepSearch(editor, 1);
    expect(searchState(editor)?.current).toBe(0);
    stepSearch(editor, -1);
    expect(searchState(editor)?.current).toBe(1);
    editor.destroy();
  });
});

describe('replace', () => {
  it('replaces one match and moves to the next', () => {
    const editor = open();
    setSearch(editor, query('owner'));
    replaceCurrent(editor, 'Keeper');
    expect(editor.getText()).toContain('The Record Keeper keeps');
    expect(searchState(editor)?.matches).toHaveLength(1);
    editor.destroy();
  });

  it('replaces every match in one step that one undo takes back', () => {
    const editor = open();
    setSearch(editor, query('record', { wholeWord: true }));
    expect(replaceAll(editor, 'file')).toBe(4);
    expect(editor.getText()).toBe('The file Owner keeps each file. Records are reviewed.\n\nA file owner signs. file kept.');
    editor.commands.undo();
    expect(editor.getText()).toContain('The Record Owner keeps each record.');
    editor.destroy();
  });

  it('is a tracked change when changes are being tracked', () => {
    const editor = open();
    setTracking(editor, true, 'Rae Reviewer');
    setSearch(editor, query('signs'));
    replaceCurrent(editor, 'approves');
    expect(listChanges(editor.state.doc).map((change) => `${change.type}:${change.text}`)).toEqual([
      'deletion:signs',
      'insertion:approves',
    ]);
    editor.destroy();
  });
});
