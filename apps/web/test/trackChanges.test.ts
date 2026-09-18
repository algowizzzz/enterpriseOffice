import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { acceptAllChanges, rejectAllChanges, toPlainText, type PMNode } from '@docforge/model';
import { editorExtensions } from '../src/components/editorExtensions';
import { listChanges, setTracking, settleChanges } from '../src/components/trackChanges';
import { withoutDefaults } from '../src/components/DocumentEditor';

const start: PMNode = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Records are kept for seven years.' }] }],
};

function tracking(): Editor {
  const editor = new Editor({ extensions: editorExtensions, content: start });
  setTracking(editor, true, 'Rae Reviewer');
  return editor;
}

const json = (editor: Editor): PMNode => withoutDefaults(editor.getJSON() as PMNode);
// "seven" sits at positions 22 to 27 of the paragraph.
const SEVEN = { from: 22, to: 27 };

describe('tracking changes while somebody types', () => {
  it('keeps deleted words, struck out, and marks typed words as inserted', () => {
    const editor = tracking();
    editor.chain().setTextSelection(SEVEN).insertContent('ten').run();
    const changes = listChanges(editor.state.doc);
    expect(changes.map((change) => `${change.type}:${change.text}:${change.author}`)).toEqual([
      'deletion:seven:Rae Reviewer',
      'insertion:ten:Rae Reviewer',
    ]);
    // The document says both things until somebody decides.
    expect(toPlainText(acceptAllChanges(json(editor)))).toBe('Records are kept for ten years.');
    expect(toPlainText(rejectAllChanges(json(editor)))).toBe('Records are kept for seven years.');
    editor.destroy();
  });

  it('treats a sentence typed in one go as one insertion, not one per keystroke', () => {
    const editor = tracking();
    editor.commands.setTextSelection(34);
    for (const letter of ' Longer for tax.') editor.commands.insertContent(letter);
    expect(listChanges(editor.state.doc)).toHaveLength(1);
    expect(listChanges(editor.state.doc)[0]?.text).toBe(' Longer for tax.');
    editor.destroy();
  });

  it('simply removes what the same person typed a moment ago', () => {
    // Changing your mind about your own insertion is not a proposal to delete.
    const editor = tracking();
    editor.chain().setTextSelection(34).insertContent(' Oops').run();
    editor.chain().setTextSelection({ from: 34, to: 39 }).deleteSelection().run();
    expect(listChanges(editor.state.doc)).toEqual([]);
    expect(editor.getText()).toBe('Records are kept for seven years.');
    editor.destroy();
  });

  it('leaves the cursor before a word struck out with backspace, so the next press carries on', () => {
    const editor = tracking();
    editor.commands.setTextSelection(27);
    editor.commands.deleteRange({ from: 26, to: 27 });
    // Still one character to the left of where it was, with the letter kept.
    expect(editor.state.selection.head).toBe(26);
    expect(editor.getText()).toBe('Records are kept for seven years.');
    editor.destroy();
  });

  it('does nothing while tracking is off', () => {
    const editor = new Editor({ extensions: editorExtensions, content: start });
    editor.chain().setTextSelection(SEVEN).insertContent('ten').run();
    expect(listChanges(editor.state.doc)).toEqual([]);
    expect(editor.getText()).toBe('Records are kept for ten years.');
    editor.destroy();
  });

  it('accepts one change and leaves the others', () => {
    const editor = tracking();
    editor.chain().setTextSelection(SEVEN).insertContent('ten').run();
    const [deletion] = listChanges(editor.state.doc);
    settleChanges(editor, 'accept', { from: deletion!.from, to: deletion!.to - 1 });
    expect(listChanges(editor.state.doc).map((change) => change.type)).toEqual(['insertion']);
    expect(editor.getText()).toBe('Records are kept for ten years.');
    editor.destroy();
  });

  it('rejects everything and is back where it started, with nothing left to review', () => {
    const editor = tracking();
    editor.chain().setTextSelection(SEVEN).insertContent('ten').run();
    settleChanges(editor, 'reject');
    expect(json(editor)).toEqual(start);
    editor.destroy();
  });

  it('does not track settling itself', () => {
    const editor = tracking();
    editor.chain().setTextSelection(SEVEN).insertContent('ten').run();
    settleChanges(editor, 'accept');
    expect(listChanges(editor.state.doc)).toEqual([]);
    expect(editor.getText()).toBe('Records are kept for ten years.');
    editor.destroy();
  });

  it('keeps the changes through the editor, so they are saved', () => {
    const editor = tracking();
    editor.chain().setTextSelection(SEVEN).insertContent('ten').run();
    const stored = json(editor);
    const reopened = new Editor({ extensions: editorExtensions, content: stored });
    expect(withoutDefaults(reopened.getJSON() as PMNode)).toEqual(stored);
    editor.destroy();
    reopened.destroy();
  });
});
