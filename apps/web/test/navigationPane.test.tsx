import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import type { JSX } from 'react';
import type { PMNode } from '@docforge/model';
import { editorExtensions } from '../src/components/editorExtensions';
import { headingsIn, NavigationPane } from '../src/components/NavigationPane';

const DOC: PMNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Purpose' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Some introductory text.' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Scope' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'What this covers.' }] },
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Definitions' }] },
  ],
};

let current: Editor | null = null;

function Harness({ doc = DOC, onClose = () => {} }: { doc?: PMNode; onClose?: () => void }): JSX.Element | null {
  const editor = useEditor({ extensions: editorExtensions, content: doc }, []);
  current = editor;
  if (!editor) return null;
  return (
    <div>
      <NavigationPane editor={editor} onClose={onClose} />
      <EditorContent editor={editor} />
    </div>
  );
}

async function mount(doc?: PMNode, onClose?: () => void) {
  const user = userEvent.setup();
  render(<Harness doc={doc} onClose={onClose} />);
  await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument());
  return user;
}

beforeEach(() => {
  current = null;
});

describe('headingsIn', () => {
  it('lists every heading, in document order, with its level', async () => {
    await mount();
    const found = headingsIn(current!);
    expect(found.map((entry) => [entry.level, entry.text])).toEqual([
      [1, 'Purpose'],
      [2, 'Scope'],
      [1, 'Definitions'],
    ]);
  });
});

describe('NavigationPane', () => {
  it('shows the document outline, nested by heading level', async () => {
    await mount();
    // All three headings are offered as jump targets.
    expect(screen.getByRole('button', { name: 'Purpose' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scope' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Definitions' })).toBeInTheDocument();
    // A sub-heading sits further in than a top-level one, the way an outline does.
    const top = screen.getByRole('button', { name: 'Purpose' });
    const nested = screen.getByRole('button', { name: 'Scope' });
    expect(parseFloat(nested.style.paddingLeft)).toBeGreaterThan(parseFloat(top.style.paddingLeft));
  });

  it('says so when the document has no headings yet', async () => {
    await mount({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'No headings here.' }] }] });
    expect(screen.getByText(/No headings yet/u)).toBeInTheDocument();
  });

  it('moves the caret to the chosen heading when it is clicked', async () => {
    const user = await mount();
    await user.click(screen.getByRole('button', { name: 'Scope' }));
    // "Scope" is the second heading; its content starts after "Purpose",
    // the paragraph after it, and the heading's own opening token.
    await waitFor(() => expect(current!.state.selection.from).toBeGreaterThan(0));
    const { from } = current!.state.selection;
    const scopeText = current!.state.doc.textBetween(from, from + 5);
    expect(scopeText.startsWith('Scop')).toBe(true);
  });

  it('closes when the close button is clicked', async () => {
    let closed = false;
    const user = await mount(DOC, () => {
      closed = true;
    });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(closed).toBe(true);
  });
});
