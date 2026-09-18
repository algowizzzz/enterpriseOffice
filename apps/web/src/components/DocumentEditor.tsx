import { useEffect, useRef, useState, type JSX } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { PMNode } from '@docforge/model';
import { editorExtensions } from './editorExtensions';
import { Toolbar } from './Toolbar';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

interface DocumentEditorProps {
  initialContent: PMNode;
  readOnly: boolean;
  /** Called when the document changes, after the debounce interval. */
  onChange: (content: PMNode) => void;
  /** Called on every keystroke so the caller can mark the document dirty. */
  onDirty: () => void;
}

/** How long the editor waits after the last keystroke before reporting a change. */
export const AUTOSAVE_DEBOUNCE_MS = 1500;

export function DocumentEditor({
  initialContent,
  readOnly,
  onChange,
  onDirty,
}: DocumentEditorProps): JSX.Element {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [stats, setStats] = useState({ words: 0, characters: 0 });

  const editor = useEditor(
    {
      extensions: editorExtensions,
      content: initialContent,
      editable: !readOnly,
      editorProps: {
        attributes: {
          class: 'page',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Document body',
          spellcheck: 'true',
        },
      },
      onUpdate: ({ editor: instance }) => {
        const text = instance.getText();
        const trimmed = text.trim();
        setStats({
          words: trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length,
          characters: text.length,
        });
        if (readOnly) return;
        onDirty();
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          onChange(instance.getJSON() as PMNode);
        }, AUTOSAVE_DEBOUNCE_MS);
      },
      onCreate: ({ editor: instance }) => {
        const text = instance.getText();
        const trimmed = text.trim();
        setStats({
          words: trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length,
          characters: text.length,
        });
      },
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  if (!editor) return <div className="editor-loading">Preparing the editor…</div>;

  return (
    <div className="editor">
      <Toolbar editor={editor} disabled={readOnly} />
      <div className="page-surface">
        <EditorContent editor={editor} />
      </div>
      <div className="status-bar">
        <span>{stats.words === 1 ? '1 word' : `${stats.words} words`}</span>
        <span>{stats.characters === 1 ? '1 character' : `${stats.characters} characters`}</span>
        {readOnly ? <span className="badge">Read only</span> : null}
      </div>
    </div>
  );
}
