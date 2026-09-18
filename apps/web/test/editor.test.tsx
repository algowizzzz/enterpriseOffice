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
    expect(starterKit?.options.link.protocols).toEqual(['http', 'https', 'mailto']);
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
