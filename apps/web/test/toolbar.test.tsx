import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import type { JSX } from 'react';
import type { PMNode } from '@docforge/model';
import { validateDoc } from '@docforge/model';
import { editorExtensions, FONT_FAMILIES, FONT_SIZES } from '../src/components/editorExtensions';
import { Toolbar } from '../src/components/Toolbar';

const START: PMNode = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
};

let current: Editor | null = null;

function Harness({ disabled = false }: { disabled?: boolean }): JSX.Element | null {
  const editor = useEditor({ extensions: editorExtensions, content: START }, []);
  current = editor;
  if (!editor) return null;
  return (
    <div>
      <Toolbar editor={editor} disabled={disabled} />
      <EditorContent editor={editor} />
    </div>
  );
}

const json = (): PMNode => current?.getJSON() as PMNode;
const asText = (): string => JSON.stringify(json());

async function mount(disabled = false) {
  const user = userEvent.setup();
  render(<Harness disabled={disabled} />);
  await waitFor(() => expect(screen.getByRole('toolbar')).toBeInTheDocument());
  return user;
}

/** Put the caret across the whole document, the way a person would before formatting. */
async function selectAll(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('textbox'));
  await user.keyboard('{Control>}a{/Control}');
}

beforeEach(() => {
  current = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toolbar, character formatting', () => {
  const marks: { label: string; mark: string }[] = [
    { label: 'Bold', mark: 'bold' },
    { label: 'Italic', mark: 'italic' },
    { label: 'Underline', mark: 'underline' },
    { label: 'Strikethrough', mark: 'strike' },
    { label: 'Superscript', mark: 'superscript' },
    { label: 'Subscript', mark: 'subscript' },
    { label: 'Highlight', mark: 'highlight' },
  ];

  for (const { label, mark } of marks) {
    it(`applies and removes ${label.toLowerCase()}`, async () => {
      const user = await mount();
      await selectAll(user);

      await user.click(screen.getByRole('button', { name: label }));
      expect(asText(), `${mark} applied`).toContain(`"${mark}"`);
      expect(validateDoc(json()).ok).toBe(true);

      await user.click(screen.getByRole('button', { name: label }));
      expect(asText(), `${mark} removed`).not.toContain(`"${mark}"`);
    });
  }

  it('shows a control as pressed while it applies to the selection', async () => {
    const user = await mount();
    await selectAll(user);
    const bold = screen.getByRole('button', { name: 'Bold' });
    expect(bold).toHaveAttribute('aria-pressed', 'false');
    await user.click(bold);
    await waitFor(() => expect(bold).toHaveAttribute('aria-pressed', 'true'));
  });

  it('sets a text colour', async () => {
    const user = await mount();
    await selectAll(user);
    const colour = screen.getByLabelText('Text colour');
    // A colour input cannot be typed into, so drive its change event directly.
    fireEvent.change(colour, { target: { value: '#cc0000' } });
    await waitFor(() => expect(asText()).toContain('#cc0000'));
  });

  it('clears every mark from the selection', async () => {
    const user = await mount();
    await selectAll(user);
    await user.click(screen.getByRole('button', { name: 'Bold' }));
    await user.click(screen.getByRole('button', { name: 'Italic' }));
    expect(asText()).toContain('"bold"');

    await selectAll(user);
    await user.click(screen.getByRole('button', { name: 'Clear formatting' }));
    expect(asText()).not.toContain('"bold"');
    expect(asText()).not.toContain('"italic"');
  });
});

describe('toolbar, paragraph style', () => {
  it('turns the paragraph into each heading level and back', async () => {
    const user = await mount();
    await user.click(screen.getByRole('textbox'));

    for (const level of ['1', '3', '6']) {
      await user.selectOptions(screen.getByLabelText('Paragraph style'), level);
      await waitFor(() => expect(json().content?.[0]?.type).toBe('heading'));
      expect(json().content?.[0]?.attrs?.['level']).toBe(Number(level));
    }

    await user.selectOptions(screen.getByLabelText('Paragraph style'), 'p');
    await waitFor(() => expect(json().content?.[0]?.type).toBe('paragraph'));
  });

  it('shows which style the caret is in', async () => {
    const user = await mount();
    await user.click(screen.getByRole('textbox'));
    const select = screen.getByLabelText('Paragraph style');
    expect(select).toHaveValue('p');
    await user.selectOptions(select, '2');
    await waitFor(() => expect(screen.getByLabelText('Paragraph style')).toHaveValue('2'));
  });

  it('applies each alignment', async () => {
    const user = await mount();
    await user.click(screen.getByRole('textbox'));
    for (const [label, value] of [
      ['Align center', 'center'],
      ['Align right', 'right'],
      ['Align justify', 'justify'],
      ['Align left', 'left'],
    ] as const) {
      await user.click(screen.getByRole('button', { name: label }));
      await waitFor(() => expect(json().content?.[0]?.attrs?.['textAlign']).toBe(value));
    }
  });

  it('applies a font family and then clears it', async () => {
    const user = await mount();
    await selectAll(user);
    const named = FONT_FAMILIES.find((font) => font.value !== '');
    await user.selectOptions(screen.getByLabelText('Font'), named?.value ?? '');
    await waitFor(() => expect(asText()).toContain('fontFamily'));

    await selectAll(user);
    await user.selectOptions(screen.getByLabelText('Font'), '');
    await waitFor(() => expect(asText()).not.toContain('fontFamily'));
  });

  it('applies a font size in points and then clears it', async () => {
    const user = await mount();
    await selectAll(user);
    await user.selectOptions(screen.getByLabelText('Font size'), FONT_SIZES[4] ?? '12');
    await waitFor(() => expect(asText()).toContain(`${FONT_SIZES[4]}pt`));

    await selectAll(user);
    await user.selectOptions(screen.getByLabelText('Font size'), '');
    await waitFor(() => expect(asText()).not.toContain('fontSize'));
  });
});

describe('toolbar, blocks', () => {
  it('makes a bulleted list and a numbered list', async () => {
    const user = await mount();
    await user.click(screen.getByRole('textbox'));

    await user.click(screen.getByRole('button', { name: 'Bulleted list' }));
    await waitFor(() => expect(asText()).toContain('bulletList'));

    await user.click(screen.getByRole('button', { name: 'Numbered list' }));
    await waitFor(() => expect(asText()).toContain('orderedList'));
  });

  it('makes a block quote', async () => {
    const user = await mount();
    await user.click(screen.getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: 'Block quote' }));
    await waitFor(() => expect(asText()).toContain('blockquote'));
  });

  it('inserts a horizontal rule', async () => {
    const user = await mount();
    await user.click(screen.getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: 'Horizontal rule' }));
    await waitFor(() => expect(asText()).toContain('horizontalRule'));
  });

  it('inserts a table with a header row, then adds and removes parts of it', async () => {
    const user = await mount();
    await user.click(screen.getByRole('textbox'));

    await user.click(screen.getByRole('button', { name: 'Insert table' }));
    await waitFor(() => expect(asText()).toContain('tableHeader'));
    const rowsAfterInsert = json().content?.find((n) => n.type === 'table')?.content?.length ?? 0;

    await user.click(screen.getByRole('button', { name: 'Add row below' }));
    await waitFor(() => {
      const rows = json().content?.find((n) => n.type === 'table')?.content?.length ?? 0;
      expect(rows).toBe(rowsAfterInsert + 1);
    });

    await user.click(screen.getByRole('button', { name: 'Delete row' }));
    await waitFor(() => {
      const rows = json().content?.find((n) => n.type === 'table')?.content?.length ?? 0;
      expect(rows).toBe(rowsAfterInsert);
    });
  });

  it('adds a column to a table', async () => {
    const user = await mount();
    await user.click(screen.getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: 'Insert table' }));
    await waitFor(() => expect(asText()).toContain('tableHeader'));

    const cellsBefore =
      json().content?.find((n) => n.type === 'table')?.content?.[0]?.content?.length ?? 0;
    await user.click(screen.getByRole('button', { name: 'Add column after' }));
    await waitFor(() => {
      const cells =
        json().content?.find((n) => n.type === 'table')?.content?.[0]?.content?.length ?? 0;
      expect(cells).toBe(cellsBefore + 1);
    });
  });

  it('disables the table controls while the caret is outside a table', async () => {
    const user = await mount();
    await user.click(screen.getByRole('textbox'));
    expect(screen.getByRole('button', { name: 'Add row below' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete row' })).toBeDisabled();
  });

  it('produces content the server model accepts for every block control', async () => {
    const user = await mount();
    await user.click(screen.getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: 'Bulleted list' }));
    await user.click(screen.getByRole('button', { name: 'Horizontal rule' }));
    await user.click(screen.getByRole('button', { name: 'Insert table' }));
    await waitFor(() => expect(asText()).toContain('table'));
    expect(validateDoc(json())).toEqual({ ok: true, errors: [] });
  });
});

describe('toolbar, links', () => {
  it('applies a link the person typed', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('https://intranet/handbook');
    const user = await mount();
    await selectAll(user);
    await user.click(screen.getByRole('button', { name: 'Insert link' }));
    await waitFor(() => expect(asText()).toContain('https://intranet/handbook'));
  });

  it('accepts a mail address', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('mailto:someone@localhost');
    const user = await mount();
    await selectAll(user);
    await user.click(screen.getByRole('button', { name: 'Insert link' }));
    await waitFor(() => expect(asText()).toContain('mailto:someone@localhost'));
  });

  it('refuses an address that could run script, and says why', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('javascript:alert(1)');
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const user = await mount();
    await selectAll(user);
    await user.click(screen.getByRole('button', { name: 'Insert link' }));
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('http://'));
    expect(asText()).not.toContain('javascript');
  });

  it('does nothing when the prompt is dismissed', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    const user = await mount();
    await selectAll(user);
    await user.click(screen.getByRole('button', { name: 'Insert link' }));
    expect(asText()).not.toContain('"link"');
  });

  it('removes the link when the address is cleared', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('https://intranet/page');
    const user = await mount();
    await selectAll(user);
    await user.click(screen.getByRole('button', { name: 'Insert link' }));
    await waitFor(() => expect(asText()).toContain('"link"'));

    prompt.mockReturnValue('');
    await selectAll(user);
    await user.click(screen.getByRole('button', { name: 'Insert link' }));
    await waitFor(() => expect(asText()).not.toContain('"link"'));
  });
});

describe('toolbar, images', () => {
  /** Stand in for the file picker, which jsdom cannot open. */
  function stubFilePicker(file: File | null): HTMLInputElement {
    const input = document.createElement('input');
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag !== 'input') return create(tag);
      vi.spyOn(input, 'click').mockImplementation(() => {
        Object.defineProperty(input, 'files', {
          configurable: true,
          value: file ? [file] : [],
        });
        input.onchange?.(new Event('change'));
      });
      return input;
    });
    return input;
  }

  it('embeds a chosen image', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'dot.png', { type: 'image/png' });
    stubFilePicker(file);
    const user = await mount();
    await user.click(screen.getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: 'Insert image' }));
    await waitFor(() => expect(asText()).toContain('"image"'), { timeout: 3000 });
    expect(asText()).toContain('data:image/png');
  });

  it('refuses an image that is too large to embed', async () => {
    const big = new File([new Uint8Array(3 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    stubFilePicker(big);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const user = await mount();
    await user.click(screen.getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: 'Insert image' }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringContaining('2 MB')));
    expect(asText()).not.toContain('"image"');
  });

  it('does nothing when no file is chosen', async () => {
    stubFilePicker(null);
    const user = await mount();
    await user.click(screen.getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: 'Insert image' }));
    expect(asText()).not.toContain('"image"');
  });
});

describe('toolbar, history and read-only', () => {
  it('undoes and redoes an edit', async () => {
    const user = await mount();
    await user.click(screen.getByRole('textbox'));
    await user.keyboard(' extra');
    await waitFor(() => expect(asText()).toContain('extra'));

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(asText()).not.toContain('extra'));

    await user.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(asText()).toContain('extra'));
  });

  it('offers nothing to undo in a document nobody has edited', async () => {
    await mount();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
  });

  it('disables every control when the document is read only', async () => {
    await mount(true);
    for (const label of [
      'Bold',
      'Italic',
      'Insert table',
      'Insert link',
      'Insert image',
      'Bulleted list',
      'Align center',
      'Clear formatting',
      'Horizontal rule',
    ]) {
      expect(screen.getByRole('button', { name: label }), label).toBeDisabled();
    }
    expect(screen.getByLabelText('Paragraph style')).toBeDisabled();
    expect(screen.getByLabelText('Font')).toBeDisabled();
    expect(screen.getByLabelText('Font size')).toBeDisabled();
    expect(screen.getByRole('toolbar')).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('format painter', () => {
  it('gives the next selection the formatting under the cursor, once', async () => {
    const { Editor } = await import('@tiptap/core');
    const { render: draw, screen: page, act: run } = await import('@testing-library/react');
    const { default: userEvents } = await import('@testing-library/user-event');
    const { Toolbar: Ribbon } = await import('../src/components/Toolbar');
    const { editorExtensions: extensions } = await import('../src/components/editorExtensions');
    const editor = new Editor({
      extensions,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Bold red', marks: [{ type: 'bold' }, { type: 'textStyle', attrs: { color: '#c00000' } }] },
              { type: 'text', text: ' and plain words.' },
            ],
          },
        ],
      },
    });
    draw(<Ribbon editor={editor as never} />);
    await run(async () => {
      editor.commands.setTextSelection(3);
    });
    await userEvents.click(page.getByRole('button', { name: /Format painter/u }));
    await run(async () => {
      editor.commands.setTextSelection({ from: 14, to: 19 });
    });
    const runs = (): { text?: string; marks?: { type: string }[] }[] =>
      (editor.getJSON().content?.[0]?.content ?? []) as { text?: string; marks?: { type: string }[] }[];
    const painted = runs().find((node) => node.text === 'plain');
    expect(painted?.marks?.map((mark) => mark.type).sort()).toEqual(['bold', 'textStyle']);
    // One use: the next selection is left alone.
    await run(async () => {
      editor.commands.setTextSelection({ from: 20, to: 25 });
    });
    expect(runs().find((node) => node.text === 'words')).toBeUndefined();
    expect(editor.getText()).toBe('Bold red and plain words.');
    editor.destroy();
  });
});
