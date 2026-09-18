import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import type { JSX } from 'react';
import { sanitizeDocument, validateDoc, type PMNode } from '@docforge/model';
import { editorExtensions } from '../src/components/editorExtensions';

let current: Editor | null = null;

function Harness(): JSX.Element | null {
  const editor = useEditor({ extensions: editorExtensions, content: '<p>start</p>' }, []);
  current = editor;
  return editor ? <EditorContent editor={editor} /> : null;
}

/**
 * Markup somebody could paste in, from a web page, an intranet document or a
 * deliberately hostile source. None of it may produce a document that cannot be
 * saved: that stranded somebody's work twice, once for a percentage image width
 * and once for a pasted remote image.
 */
const FRAGMENTS: Record<string, string> = {
  'a remote image': '<p>text<img src="http://intranet/logo.png"></p>',
  'an https image': '<p><img src="https://example.com/a.png"></p>',
  'a protocol-relative image': '<p><img src="//example.com/a.png"></p>',
  'a site-relative image': '<p><img src="/static/a.png"></p>',
  'an inline svg data uri': '<p><img src="data:image/svg+xml,<svg/>"></p>',
  'a percentage width': '<p><img src="data:image/png;base64,AAAA" width="100%" height="auto"></p>',
  'an enormous width': '<p><img src="data:image/png;base64,AAAA" width="99999999"></p>',
  'a scheme-relative link': '<p><a href="//evil.test/page">click</a></p>',
  'a bare scheme link': '<p><a href="https:">click</a></p>',
  'a script link': '<p><a href="javascript:alert(1)">click</a></p>',
  'a data link': '<p><a href="data:text/html,<script>">click</a></p>',
  'an enormous column span': '<table><tr><td colspan="99999">cell</td></tr></table>',
  'a negative row span': '<table><tr><td rowspan="-4">cell</td></tr></table>',
  'a heading level that does not exist': '<p>text</p>',
  'a mixture of all of it':
    '<p><img src="http://x/y.png"><a href="//evil.test">link</a></p><table><tr><td colspan="9999">c</td></tr></table>',
  'markup with no content at all': '<p></p>',
};

async function mountEditor(): Promise<Editor> {
  render(<Harness />);
  await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument());
  if (!current) throw new Error('editor did not start');
  return current;
}

describe('nothing pasted can make a document unsavable', () => {
  for (const [name, html] of Object.entries(FRAGMENTS)) {
    it(`survives ${name}`, async () => {
      const editor = await mountEditor();
      editor.commands.setContent(html);

      // What the editor would hand over on save is what matters.
      const saved = sanitizeDocument(editor.getJSON() as PMNode);
      const result = validateDoc(saved);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }

  it('drops a remote image as it arrives, rather than showing it and losing it later', async () => {
    const editor = await mountEditor();
    editor.commands.setContent('<p>kept<img src="http://intranet/logo.png"></p>');
    const json = JSON.stringify(editor.getJSON());
    expect(json).not.toContain('intranet');
    expect(json).toContain('kept');
  });

  it('keeps an embedded image', async () => {
    const editor = await mountEditor();
    editor.commands.setContent('<p><img src="data:image/png;base64,AAAA"></p>');
    expect(JSON.stringify(editor.getJSON())).toContain('data:image/png');
  });

  it('keeps the words around anything it removes', async () => {
    const editor = await mountEditor();
    editor.commands.setContent(
      '<p>before <a href="//evil.test">the link text</a> after</p>',
    );
    const saved = sanitizeDocument(editor.getJSON() as PMNode);
    const text = JSON.stringify(saved);
    expect(text).toContain('before');
    expect(text).toContain('the link text');
    expect(text).toContain('after');
    expect(text).not.toContain('evil.test');
  });
});

describe('the repair on the way in', () => {
  it('lets a document written before a rule existed still be opened and saved', async () => {
    // A document stored by an older build, or by something that is not this
    // editor, must not be permanently unsavable.
    const legacy: PMNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Still here' },
            { type: 'image', attrs: { src: 'http://intranet/old.png' } },
          ],
        },
      ],
    };
    expect(validateDoc(legacy).ok).toBe(false);

    const repaired = sanitizeDocument(legacy);
    expect(validateDoc(repaired)).toEqual({ ok: true, errors: [] });
    expect(JSON.stringify(repaired)).toContain('Still here');
    expect(JSON.stringify(repaired)).not.toContain('intranet');
  });
});
