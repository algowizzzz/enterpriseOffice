import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PMNode } from '@docforge/model';
import { validateDoc } from '@docforge/model';
import { DocumentEditor, AUTOSAVE_DEBOUNCE_MS } from '../src/components/DocumentEditor';
import { statsFor } from '../src/components/DocumentEditor';
import { editorExtensions } from '../src/components/editorExtensions';
import { fileNameFromDisposition } from '../src/lib/api';

const startingDoc: PMNode = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
};

describe('editor extensions', () => {
  it('registers no extension whose node is missing from the shared model', () => {
    const names = editorExtensions.flatMap((extension) =>
      extension.name === 'starterKit' ? [] : [extension.name],
    );
    // These are the nodes and marks the server also understands.
    for (const name of ['textStyle', 'highlight', 'superscript', 'subscript', 'image', 'table']) {
      expect(names).toContain(name);
    }
  });

  it('switches off code and code block, which the model has no node for', () => {
    const starterKit = editorExtensions.find((extension) => extension.name === 'starterKit');
    expect(starterKit?.options.code).toBe(false);
    expect(starterKit?.options.codeBlock).toBe(false);
  });

  it('restricts link protocols to ones that cannot execute script', () => {
    const starterKit = editorExtensions.find((extension) => extension.name === 'starterKit');
    // StarterKit's own link is switched off in favour of one that also refuses
    // targets the model will not store.
    expect(starterKit?.options.link).toBe(false);
    const link = editorExtensions.find((extension) => extension.name === 'link');
    expect(link?.options.protocols).toEqual(['http', 'https', 'mailto']);
  });

  it('has a node for every node the model knows', async () => {
    // A node the model accepts and the editor does not cannot be opened at all:
    // Tiptap substitutes an empty document and warns to the console, so the
    // document reads as blank and the first save stores that.
    const { getSchema } = await import('@tiptap/core');
    const { NODE, MARK } = await import('@docforge/model');
    const schema = getSchema(editorExtensions);
    for (const name of Object.values(NODE)) expect(Object.keys(schema.nodes)).toContain(name);
    for (const name of Object.values(MARK)) expect(Object.keys(schema.marks)).toContain(name);
  });
});

describe('DocumentEditor', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the supplied content and a word count', async () => {
    render(
      <DocumentEditor
        initialContent={startingDoc}
        readOnly={false}
        onChange={() => {}}
        onDirty={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveTextContent('Hello world'));
    expect(screen.getByText('2 words')).toBeInTheDocument();
  });

  it('stays clean when a document is merely opened', async () => {
    // Regression: making the editor editable emitted an update, which marked
    // every freshly opened document dirty and autosaved a revision nobody made.
    const onChange = vi.fn();
    const onDirty = vi.fn();
    render(
      <DocumentEditor
        initialContent={startingDoc}
        readOnly={false}
        onChange={onChange}
        onDirty={onDirty}
      />,
    );
    await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument());

    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 3);
    });

    expect(onDirty).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('counts the words in a document that nobody has touched', async () => {
    // The counts used to be filled in by the update handler, so they read zero
    // until something changed.
    render(
      <DocumentEditor
        initialContent={{
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one two three four' }] }],
        }}
        readOnly={false}
        onChange={() => {}}
        onDirty={() => {}}
      />,
    );
    expect(await screen.findByText('4 words')).toBeInTheDocument();
  });

  it('stays clean when a read-only document is opened', async () => {
    const onDirty = vi.fn();
    render(
      <DocumentEditor initialContent={startingDoc} readOnly onChange={() => {}} onDirty={onDirty} />,
    );
    await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument());
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 3);
    });
    expect(onDirty).not.toHaveBeenCalled();
  });

  it('reports the document as dirty on the first keystroke, then saves once', async () => {
    const onChange = vi.fn();
    const onDirty = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <DocumentEditor
        initialContent={startingDoc}
        readOnly={false}
        onChange={onChange}
        onDirty={onDirty}
      />,
    );
    const body = await screen.findByRole('textbox');

    await user.click(body);
    await user.keyboard('!!');

    expect(onDirty).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 50);
    });

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const saved = onChange.mock.calls[0]?.[0] as PMNode;
    expect(validateDoc(saved).ok).toBe(true);
  });

  it('produces content the server model accepts', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <DocumentEditor
        initialContent={startingDoc}
        readOnly={false}
        onChange={onChange}
        onDirty={() => {}}
      />,
    );
    const body = await screen.findByRole('textbox');
    await user.click(body);
    await user.keyboard('{Enter}A second paragraph');

    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 50);
    });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const saved = onChange.mock.lastCall?.[0] as PMNode;
    expect(validateDoc(saved)).toEqual({ ok: true, errors: [] });
    expect(JSON.stringify(saved)).toContain('A second paragraph');
  });

  it('marks the surface read only and shows a badge', async () => {
    const onChange = vi.fn();
    render(
      <DocumentEditor
        initialContent={startingDoc}
        readOnly
        onChange={onChange}
        onDirty={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument());
    expect(screen.getByText('Read only')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable', 'false');
  });

  it('remembers zoom per person, in local storage, and offers zoom in and out', async () => {
    window.localStorage.removeItem('docforge-zoom');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <DocumentEditor initialContent={startingDoc} readOnly={false} onChange={() => {}} onDirty={() => {}} />,
    );
    await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument());

    const zoomSelect = screen.getByTitle<HTMLSelectElement>('Zoom');
    expect(zoomSelect.value).toBe('100');

    await user.selectOptions(zoomSelect, '150');
    expect(zoomSelect.value).toBe('150');
    expect(window.localStorage.getItem('docforge-zoom')).toBe('150');

    await user.click(screen.getByTitle('Zoom out'));
    expect(zoomSelect.value).toBe('140');
    expect(window.localStorage.getItem('docforge-zoom')).toBe('140');
  });

  it('shows the formatting toolbar with the expected controls', async () => {
    render(
      <DocumentEditor
        initialContent={startingDoc}
        readOnly={false}
        onChange={() => {}}
        onDirty={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByRole('toolbar')).toBeInTheDocument());
    for (const control of [
      'Bold',
      'Italic',
      'Underline',
      'Strikethrough',
      'Superscript',
      'Subscript',
      'Highlight',
      'Bulleted list',
      'Numbered list',
      'Insert table',
      'Insert link',
      'Insert image',
      'Align center',
      'Undo',
      'Redo',
    ]) {
      expect(screen.getByRole('button', { name: control })).toBeInTheDocument();
    }
  });

  it('applies bold to the selection through the toolbar', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <DocumentEditor
        initialContent={startingDoc}
        readOnly={false}
        onChange={onChange}
        onDirty={() => {}}
      />,
    );
    const body = await screen.findByRole('textbox');
    await user.click(body);
    await user.keyboard('{Control>}a{/Control}');
    await user.click(screen.getByRole('button', { name: 'Bold' }));

    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 50);
    });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const saved = onChange.mock.lastCall?.[0] as PMNode;
    expect(JSON.stringify(saved)).toContain('"bold"');
    expect(validateDoc(saved).ok).toBe(true);
  });

  it('moves the caret to the document start and end with the Word shortcuts', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const threeParagraphs: PMNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Third' }] },
      ],
    };
    render(
      <DocumentEditor
        initialContent={threeParagraphs}
        readOnly={false}
        onChange={onChange}
        onDirty={() => {}}
      />,
    );
    const body = await screen.findByRole('textbox');
    await user.click(body);

    // Without these bindings the caret would not move and the typed text would
    // land wherever the click left it.
    await user.keyboard('{Control>}{End}{/Control}');
    await user.keyboard('!');
    await user.keyboard('{Control>}{Home}{/Control}');
    await user.keyboard('>');

    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 50);
    });
    await waitFor(() => expect(onChange).toHaveBeenCalled());

    const saved = onChange.mock.lastCall?.[0] as PMNode;
    const paragraphs = (saved.content ?? []).map((node) =>
      (node.content ?? []).map((child) => child.text ?? '').join(''),
    );
    expect(paragraphs[0]).toBe('>First');
    expect(paragraphs[2]).toBe('Third!');
  });

  it('disables the toolbar when the document is read only', async () => {
    render(
      <DocumentEditor
        initialContent={startingDoc}
        readOnly
        onChange={() => {}}
        onDirty={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByRole('toolbar')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Bold' })).toBeDisabled();
  });
});

describe('download file names', () => {
  it('prefers the UTF-8 form of a content disposition header', () => {
    expect(
      fileNameFromDisposition(
        `attachment; filename="_____.docx"; filename*=UTF-8''${encodeURIComponent('تقرير.docx')}`,
      ),
    ).toBe('تقرير.docx');
  });

  it('falls back to the ASCII form', () => {
    expect(fileNameFromDisposition('attachment; filename="Report.docx"')).toBe('Report.docx');
  });

  it('returns null when the header carries no name', () => {
    expect(fileNameFromDisposition('attachment')).toBeNull();
  });
});

describe('word and character counts', () => {
  it('counts nothing in an empty document', () => {
    expect(statsFor('')).toEqual({ words: 0, characters: 0 });
    expect(statsFor('   \n  ')).toEqual({ words: 0, characters: 6 });
  });

  it('counts runs of non-whitespace as words', () => {
    expect(statsFor('one two three')).toEqual({ words: 3, characters: 13 });
    expect(statsFor('  padded  words  ')).toMatchObject({ words: 2 });
  });

  it('counts across line breaks', () => {
    expect(statsFor('first line\nsecond line')).toMatchObject({ words: 4 });
  });

  it('counts a non-Latin script', () => {
    expect(statsFor('یہ ایک جملہ ہے')).toMatchObject({ words: 4 });
  });
});

describe('a document the editor has to repair before it can show it', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens with a place to type rather than with nothing at all', async () => {
    // Regression: the only thing in the document was a picture held outside the
    // file. Removing it left a document with no content, which opened as a
    // blank page with nowhere to put the cursor, and the first save wrote that
    // blankness over the stored work.
    const stranded = {
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'https://example.com/a.png' } }],
    } as PMNode;
    const repairs: string[] = [];
    render(
      <DocumentEditor
        initialContent={stranded}
        readOnly={false}
        onChange={() => {}}
        onDirty={() => {}}
        onRepair={(when) => repairs.push(when)}
      />,
    );
    const body = await screen.findByRole('textbox');
    expect(body.querySelectorAll('p')).toHaveLength(1);
    await waitFor(() => expect(repairs).toEqual(['open']));
  });

  it('does not take the page down when the stored shape is wrong', async () => {
    const malformed = { type: 'doc', content: { not: 'a list' } } as unknown as PMNode;
    expect(() =>
      render(
        <DocumentEditor
          initialContent={malformed}
          readOnly={false}
          onChange={() => {}}
          onDirty={() => {}}
        />,
      ),
    ).not.toThrow();
    await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument());
  });

  it('does not claim a removal when it only filled an empty quote', async () => {
    // Regression: the message said content had been left out although nothing
    // had, because the repair reported any change at all rather than a loss.
    const repairs: string[] = [];
    render(
      <DocumentEditor
        initialContent={{ type: 'doc', content: [{ type: 'blockquote', content: [] }] }}
        readOnly={false}
        onChange={() => {}}
        onDirty={() => {}}
        onRepair={(when) => repairs.push(when)}
      />,
    );
    await screen.findByRole('textbox');
    expect(repairs).toEqual([]);
  });

  it('says so when a save had to remove something', async () => {
    const repairs: string[] = [];
    const saved: PMNode[] = [];
    render(
      <DocumentEditor
        initialContent={startingDoc}
        readOnly={false}
        onChange={(content) => saved.push(content)}
        onDirty={() => {}}
        onRepair={(when) => repairs.push(when)}
      />,
    );
    const body = await screen.findByRole('textbox');
    await userEvent.type(body, ' more');
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 50);
    });
    // Ordinary typing removes nothing, so it must not claim otherwise.
    expect(repairs).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(validateDoc(saved[0] as PMNode).ok).toBe(true);
  });
});

describe('what a Word file carries that the editor does not edit', () => {
  // Everything the reader keeps by reference. Tiptap drops whatever its schema
  // does not declare, without a word, on the first transaction: if any of this
  // goes missing here, the export puts the document back together without it
  // and the letterhead, the numbering or the chart is gone.
  const carried: PMNode = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1, styleId: 'Heading1', pprRef: 'aaaa000000000001', numLevel: 0 },
        content: [{ type: 'text', text: 'Purpose' }],
      },
      {
        type: 'paragraph',
        attrs: {
          styleId: 'PolicyClause',
          pprRef: 'aaaa000000000002',
          textAlign: 'justify',
          indentLeft: 850,
          indentRight: 120,
          indentFirstLine: -425,
          spacingBefore: 120,
          spacingAfter: 240,
          lineHeight: 1.15,
        },
        content: [
          { type: 'text', text: 'Kept ' },
          {
            type: 'text',
            text: 'Record Owner',
            marks: [{ type: 'wordRun', attrs: { ref: 'bbbb000000000001', styleId: 'Defined', font: 'Georgia' } }],
          },
          { type: 'wordInline', attrs: { ref: 'cccc000000000001', kind: 'footnote', label: '1' } },
          { type: 'wordInline', attrs: { ref: 'cccc000000000002', kind: 'bookmark', label: '' } },
          { type: 'wordInline', attrs: { ref: 'cccc000000000003', kind: 'field', label: '18 September 2026' } },
        ],
      },
      { type: 'paragraph', attrs: { lineExact: 360 }, content: [{ type: 'text', text: 'Exact' }] },
      { type: 'wordBlock', attrs: { ref: 'dddd000000000001', kind: 'toc', label: 'Purpose 1\nSchedule 2' } },
      {
        type: 'orderedList',
        attrs: { start: 1, numId: '7', numLevel: 0, listFormat: 'lowerLetter' },
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First' }] }] },
        ],
      },
      {
        type: 'table',
        attrs: { tblRef: 'eeee000000000001', gridRef: 'eeee000000000002', gridColumns: 1 },
        content: [
          {
            type: 'tableRow',
            attrs: { trRef: 'eeee000000000003' },
            content: [
              {
                type: 'tableCell',
                attrs: { colspan: 1, rowspan: 1, tcRef: 'eeee000000000004', background: '#ffc000' },
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cell' }] }],
              },
            ],
          },
        ],
      },
    ],
  };

  it('comes back out of the editor with all of it', async () => {
    const { Editor } = await import('@tiptap/core');
    const { withoutDefaults } = await import('../src/components/DocumentEditor');
    const editor = new Editor({ extensions: editorExtensions, content: carried });
    // A keystroke, so this is the document after a transaction and not only
    // the one that was handed in.
    editor.commands.insertContentAt(1, 'x');
    editor.commands.deleteRange({ from: 1, to: 2 });
    expect(withoutDefaults(editor.getJSON() as PMNode)).toEqual(carried);
    editor.destroy();
  });

  it('is accepted by the rules every save is checked against', () => {
    expect(validateDoc(carried)).toEqual({ ok: true, errors: [] });
  });

  it('draws what the paragraph states about itself', async () => {
    const { Editor } = await import('@tiptap/core');
    const editor = new Editor({ extensions: editorExtensions, content: carried });
    const html = editor.getHTML();
    expect(html).toContain('data-style="PolicyClause"');
    // The serialiser folds the four margins into one declaration.
    expect(html).toMatch(/margin: 8px 8px 16px 56\.67px/u);
    expect(html).toMatch(/text-indent: -28\.33px/u);
    expect(html).toContain('list-style-type: lower-alpha');
    expect(html).toContain('data-run-style="Defined"');
    editor.destroy();
  });
});
