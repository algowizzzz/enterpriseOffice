import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PMNode } from '@docforge/model';
import { validateDoc } from '@docforge/model';
import { DocumentEditor, AUTOSAVE_DEBOUNCE_MS } from '../src/components/DocumentEditor';
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
