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

describe('tracking Enter and joined paragraphs', () => {
  const two: PMNode = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'First paragraph.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph.' }] },
    ],
  };
  const open = (content: PMNode): Editor => {
    const editor = new Editor({ extensions: editorExtensions, content });
    setTracking(editor, true, 'Rae Reviewer');
    return editor;
  };
  const kinds = (editor: Editor): string[] => listChanges(editor.state.doc).map((change) => `${change.type}:${change.text}`);

  it('records Enter as a new paragraph mark, which rejecting takes back', () => {
    // Splitting a paragraph used to take effect with nothing to show for it, so
    // a reviewer could restructure a clause and nobody could see or undo it.
    const editor = open(start);
    editor.chain().setTextSelection(17).splitBlock().run();
    expect(kinds(editor)).toEqual(['insertion:¶']);
    expect(editor.state.doc.childCount).toBe(2);
    settleChanges(editor, 'reject');
    expect(json(editor)).toEqual(start);
    editor.destroy();
  });

  it('keeps both paragraphs when they are joined, and joins them when that is accepted', () => {
    const editor = open(two);
    // Backspace at the start of the second paragraph: the cursor is put there
    // first, as it is when somebody does this by hand.
    editor.commands.setTextSelection(19);
    editor.commands.joinBackward();
    expect(editor.state.doc.childCount).toBe(2);
    expect(kinds(editor)).toEqual(['deletion:¶']);
    // The cursor is at the end of the first, so the next backspace carries on.
    expect(editor.state.selection.head).toBe(17);
    settleChanges(editor, 'accept');
    expect(editor.getText()).toBe('First paragraph.Second paragraph.');
    expect(kinds(editor)).toEqual([]);
    editor.destroy();
  });

  it('leaves them as they were when the join is rejected', () => {
    const editor = open(two);
    editor.chain().setTextSelection(19).joinBackward().run();
    settleChanges(editor, 'reject');
    expect(json(editor)).toEqual(two);
    editor.destroy();
  });

  it('simply takes back an Enter the same person has just pressed', () => {
    const editor = open(start);
    editor.chain().setTextSelection(17).splitBlock().run();
    editor.chain().joinBackward().run();
    expect(kinds(editor)).toEqual([]);
    expect(json(editor)).toEqual(start);
    editor.destroy();
  });

  it('strikes out a deletion that runs over two paragraphs rather than making it', () => {
    const editor = open(two);
    editor.chain().setTextSelection({ from: 7, to: 26 }).deleteSelection().run();
    expect(editor.state.doc.childCount).toBe(2);
    expect(kinds(editor)).toEqual(['deletion:paragraph.', 'deletion:¶', 'deletion:Second ']);
    const stored = json(editor);
    expect(toPlainText(acceptAllChanges(stored))).toBe('First paragraph.');
    expect(toPlainText(rejectAllChanges(stored))).toBe('First paragraph.\nSecond paragraph.');
    editor.destroy();
  });

  it('agrees with the model about what accepting and rejecting give', () => {
    // The editor settles changes one way and the server another (for export
    // with changes accepted). They must arrive at the same document.
    const editor = open(two);
    editor.chain().setTextSelection(7).splitBlock().run();
    editor.chain().setTextSelection(21).joinBackward().run();
    const stored = json(editor);
    const viaModel = toPlainText(acceptAllChanges(stored));
    settleChanges(editor, 'accept');
    expect(editor.getText().replace(/\n\n/gu, '\n')).toBe(viaModel);
    editor.destroy();
  });
});
