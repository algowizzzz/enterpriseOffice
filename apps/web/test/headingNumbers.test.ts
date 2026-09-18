import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import type { PMNode } from '@docforge/model';
import { editorExtensions } from '../src/components/editorExtensions';
import { formatNumber, headingNumbers } from '../src/components/headingNumbers';
import { withoutDefaults } from '../src/components/DocumentEditor';

const heading = (level: number, text: string, numLevel: number | null, pattern = ''): PMNode => ({
  type: 'heading',
  attrs: {
    level,
    ...(numLevel === null ? {} : { numLevel, numId: '4', numPattern: pattern, numFormats: 'decimal,decimal,lowerLetter' }),
  },
  content: [{ type: 'text', text }],
});
const policy: PMNode = {
  type: 'doc',
  content: [
    heading(1, 'Purpose', 0, '%1.'),
    heading(2, 'Scope', 1, '%1.%2'),
    heading(2, 'Exclusions', 1, '%1.%2'),
    heading(1, 'Retention', 0, '%1.'),
    heading(2, 'Periods', 1, '%1.%2'),
    heading(3, 'Finance', 2, '%1.%2(%3)'),
    heading(1, 'An unnumbered annex', null),
  ],
};

describe('clause numbers on headings', () => {
  it('counts as Word does: on at its own level, and again from one underneath a new parent', () => {
    // A policy is read and argued about by clause number. Showing "Periods"
    // where Word shows "2.1 Periods" made every reference a guess.
    const editor = new Editor({ extensions: editorExtensions, content: policy });
    expect(headingNumbers(editor.state.doc).map((entry) => entry.text)).toEqual(['1.', '1.1', '1.2', '2.', '2.1', '2.1(a)']);
    editor.destroy();
  });

  it('draws them in front of the heading without putting them into the text', () => {
    const editor = new Editor({ extensions: editorExtensions, content: policy });
    const drawn = [...editor.view.dom.querySelectorAll('.heading-number')].map((node) => node.textContent?.trim());
    expect(drawn).toEqual(['1.', '1.1', '1.2', '2.', '2.1', '2.1(a)']);
    expect(editor.getText()).not.toContain('2.1');
    expect(withoutDefaults(editor.getJSON() as PMNode)).toEqual(policy);
    editor.destroy();
  });

  it('renumbers when a heading is removed', () => {
    const editor = new Editor({ extensions: editorExtensions, content: policy });
    editor.commands.deleteRange({ from: 0, to: 9 });
    // The first heading is now "Scope", with no parent above it: Word counts
    // the missing parent as one, and so does this.
    expect(headingNumbers(editor.state.doc).map((entry) => entry.text).slice(0, 3)).toEqual(['1.1', '1.2', '2.']);
    editor.destroy();
  });

  it('knows letters and roman numerals', () => {
    expect([1, 26, 27].map((value) => formatNumber(value, 'lowerLetter'))).toEqual(['a', 'z', 'aa']);
    expect([4, 9, 14].map((value) => formatNumber(value, 'upperRoman'))).toEqual(['IV', 'IX', 'XIV']);
  });
});
