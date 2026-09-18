import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Editor } from '@tiptap/core';
import nspell from 'nspell';
import { editorExtensions } from '../src/components/editorExtensions';
import { correctSpelling, misspellingAt, misspellingsIn, recheckSpelling, setSpeller, spellKey, type Speller } from '../src/components/spellcheck';
import { setTracking, listChanges } from '../src/components/trackChanges';

/** The dictionary that ships, read from disk the way the browser fetches it. */
const real = (name: string): Speller => {
  // By path: the packages export only an entry point that reads these itself.
  const dir = join(process.cwd(), '../../node_modules', name);
  return nspell(readFileSync(join(dir, 'index.aff'), 'utf8'), readFileSync(join(dir, 'index.dic'), 'utf8'));
};
const british = real('dictionary-en-gb');

const open = (text: string): Editor =>
  new Editor({ extensions: editorExtensions, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } });
const underlined = (editor: Editor): string[] =>
  (spellKey.getState(editor.state)?.decorations.find() ?? []).map((hit) => editor.state.doc.textBetween(hit.from, hit.to));

describe('the dictionary that ships', () => {
  it('knows British spelling and says so about American', () => {
    expect(british.correct('colour')).toBe(true);
    expect(british.correct('organisation')).toBe(true);
    expect(british.correct('color')).toBe(false);
    expect(real('dictionary-en').correct('color')).toBe(true);
  });

  it('suggests the word that was meant', () => {
    expect(british.suggest('recieve')).toContain('receive');
  });
});

describe('which words are questioned', () => {
  const words = (text: string): string[] => misspellingsIn(text, british).map((entry) => entry.word);

  it('questions a misspelt word and nothing around it', () => {
    expect(words('The commitee will recieve the report.')).toEqual(['commitee', 'recieve']);
  });

  it('leaves alone what Word leaves alone: acronyms, references, addresses, possessives, sentence capitals', () => {
    // Every one of these underlined in a policy is noise, and noise is how
    // people learn to ignore the underline that matters.
    expect(words("The CISO's report REF-2026a is at records@example.invalid. Policy's scope. Records are kept.")).toEqual([]);
  });

  it('understands a curly apostrophe', () => {
    expect(words('It doesn’t apply.')).toEqual([]);
  });
});

describe('spelling in the editor', () => {
  it('underlines only while it is switched on', () => {
    const editor = open('The commitee met.');
    expect(underlined(editor)).toEqual([]);
    setSpeller(editor, british);
    expect(underlined(editor)).toEqual(['commitee']);
    expect(editor.view.dom.getAttribute('spellcheck')).toBe('false');
    setSpeller(editor, null);
    expect(underlined(editor)).toEqual([]);
    editor.destroy();
  });

  it('follows the text as it is typed', () => {
    const editor = open('The committee met.');
    setSpeller(editor, british);
    editor.commands.insertContentAt(18, ' It was adjurned.');
    expect(underlined(editor)).toEqual(['adjurned']);
    editor.destroy();
  });

  it('replaces the word with the suggestion chosen, keeping how it was formatted', () => {
    const editor = new Editor({
      extensions: editorExtensions,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'recieve', marks: [{ type: 'bold' }] }] }] },
    });
    setSpeller(editor, british);
    correctSpelling(editor, misspellingAt(editor, 3)!, 'receive');
    expect(editor.getJSON().content?.[0]?.content).toEqual([{ type: 'text', text: 'receive', marks: [{ type: 'bold' }] }]);
    expect(underlined(editor)).toEqual([]);
    editor.destroy();
  });

  it('stops questioning a word once it has been added to the dictionary', () => {
    const editor = open('Reviewed by Okonkwo.');
    setSpeller(editor, british);
    expect(underlined(editor)).toEqual(['Okonkwo']);
    british.add('Okonkwo');
    recheckSpelling(editor);
    expect(underlined(editor)).toEqual([]);
    editor.destroy();
  });

  it('does not question words that have been struck out, and a correction is a tracked change', () => {
    const editor = open('They recieve it.');
    setTracking(editor, true, 'Rae Reviewer');
    setSpeller(editor, british);
    correctSpelling(editor, misspellingAt(editor, 8)!, 'receive');
    expect(listChanges(editor.state.doc).map((change) => `${change.type}:${change.text}`)).toEqual(['deletion:recieve', 'insertion:receive']);
    expect(underlined(editor)).toEqual([]);
    editor.destroy();
  });
});
