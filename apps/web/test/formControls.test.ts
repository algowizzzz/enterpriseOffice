import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import type { PMNode } from '@docforge/model';
import { editorExtensions } from '../src/components/editorExtensions';
import { withoutDefaults } from '../src/components/DocumentEditor';

const form: PMNode = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Classification: ' },
        { type: 'wordInline', attrs: { ref: 'a1', kind: 'control', label: 'Internal', controlType: 'dropdown', options: 'Internal\nPublic', value: 'Internal' } },
        { type: 'wordInline', attrs: { ref: 'a2', kind: 'control', label: '', controlType: 'checkbox', value: 'false' } },
        { type: 'wordInline', attrs: { ref: 'a3', kind: 'footnote', label: '1', noteId: '2', note: 'A note.' } },
      ],
    },
  ],
};

describe('a form, in the editor', () => {
  it('offers a drop-down what its list offers, and stores the choice', () => {
    const editor = new Editor({ extensions: editorExtensions, content: form });
    const select = editor.view.dom.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['Internal', 'Public']);
    select.value = 'Public';
    select.dispatchEvent(new Event('change'));
    const stored = withoutDefaults(editor.getJSON() as PMNode).content?.[0]?.content?.[1]?.attrs;
    expect(stored).toMatchObject({ value: 'Public', ref: 'a1', options: 'Internal\nPublic' });
    // And the control on the page now shows it.
    expect((editor.view.dom.querySelector('select') as HTMLSelectElement).value).toBe('Public');
    editor.destroy();
  });

  it('ticks a box', () => {
    const editor = new Editor({ extensions: editorExtensions, content: form });
    const box = editor.view.dom.querySelector('input[type=checkbox]') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(withoutDefaults(editor.getJSON() as PMNode).content?.[0]?.content?.[2]?.attrs?.['value']).toBe('true');
    editor.destroy();
  });

  it('cannot be filled in by somebody who can only read', () => {
    const editor = new Editor({ extensions: editorExtensions, content: form, editable: false });
    expect((editor.view.dom.querySelector('select') as HTMLSelectElement).disabled).toBe(true);
    editor.destroy();
  });

  it('keeps everything a note and a control carry through the editor', () => {
    const editor = new Editor({ extensions: editorExtensions, content: form });
    expect(withoutDefaults(editor.getJSON() as PMNode)).toEqual(form);
    editor.destroy();
  });
});
