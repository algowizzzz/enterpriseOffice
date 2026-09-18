import { useEffect, useRef, useState, type JSX } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { repairDocument, type PMNode, type RepairResult } from '@docforge/model';
import { editorExtensions } from './editorExtensions';
import { Toolbar } from './Toolbar';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

interface DocumentEditorProps {
  initialContent: PMNode;
  readOnly: boolean;
  /** Called when the document changes, after the debounce interval. */
  onChange: (content: PMNode) => void;
  /** Called on every keystroke so the caller can mark the document dirty. */
  onDirty: () => void;
  /**
   * The running header and footer, drawn on the page as Word draws them.
   *
   * They are not body content and are not typed into here: without them on the
   * page, a document that carries a header looked as though it did not, and the
   * only way to find out was to open a panel.
   */
  header?: string;
  footer?: string;
  /**
   * Called when the repair had to remove something, so the caller can say so.
   *
   * Removing content somebody can see, with no message, is worse than the
   * refusal it replaced: a refusal is visible, this is not. It is not called
   * when the repair only filled a gap, such as putting a paragraph into an
   * empty quote, because nothing was lost and saying otherwise is untrue.
   */
  onRepair?: (when: 'open' | 'save') => void;
}

/** How long the editor waits after the last keystroke before reporting a change. */
export const AUTOSAVE_DEBOUNCE_MS = 1500;

export interface DocumentStats {
  words: number;
  characters: number;
}

/** Count words the way a word processor does: runs of non-whitespace. */
export function statsFor(text: string): DocumentStats {
  const trimmed = text.trim();
  return {
    words: trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length,
    characters: text.length,
  };
}

export function DocumentEditor({
  initialContent,
  readOnly,
  onChange,
  onDirty,
  onRepair,
  header = '',
  footer = '',
}: DocumentEditorProps): JSX.Element {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [stats, setStats] = useState<DocumentStats>({ words: 0, characters: 0 });

  // Held in a ref so reporting a repair cannot restart the editor, which would
  // throw away the cursor and the undo history.
  const report = useRef(onRepair);
  report.current = onRepair;

  // Repaired on the way in, once. A document written before a rule existed, or
  // by something that is not this editor, must still open and still save.
  const opened = useRef<RepairResult | null>(null);
  opened.current ??= repairDocument(initialContent);

  const editor = useEditor(
    {
      extensions: editorExtensions,
      content: opened.current.doc,
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
        if (readOnly) return;
        onDirty();
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          // Repaired on the way out. Pasted markup can carry a remote image or
          // an odd hyperlink, and tightening a server rule without this made a
          // single paste enough to strand a document for ever.
          const result = repairDocument(instance.getJSON() as PMNode);
          if (result.removed) report.current?.('save');
          onChange(result.doc);
        }, AUTOSAVE_DEBOUNCE_MS);
      },
    },
    [],
  );

  // Derive the counts from the editor rather than recomputing them in two
  // separate callbacks. Keeping them in the update handler meant the numbers
  // were only correct once something had changed the document.
  useEffect(() => {
    if (!editor) return undefined;
    const recount = (): void => setStats(statsFor(editor.getText()));
    recount();
    editor.on('update', recount);
    return () => {
      editor.off('update', recount);
    };
  }, [editor]);

  useEffect(() => {
    if (opened.current?.removed) report.current?.('open');
  }, []);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (!editor) return;
    const editable = !readOnly;
    if (editor.isEditable === editable) return;
    // The second argument stops Tiptap emitting an update. Changing whether a
    // document can be typed into is not an edit, and treating it as one marked
    // every freshly opened document dirty and saved a revision nobody made.
    editor.setEditable(editable, false);
  }, [editor, readOnly]);

  if (!editor) return <div className="editor-loading">Preparing the editor…</div>;

  return (
    <div className="editor">
      <Toolbar editor={editor} disabled={readOnly} />
      <div className="page-surface">
        <div className="page-frame">
          {header ? (
            <div className="page-running page-running-header" aria-label="Page header">
              {header}
            </div>
          ) : null}
          <EditorContent editor={editor} />
          {footer ? (
            <div className="page-running page-running-footer" aria-label="Page footer">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
      <div className="status-bar">
        <span>{stats.words === 1 ? '1 word' : `${stats.words} words`}</span>
        <span>{stats.characters === 1 ? '1 character' : `${stats.characters} characters`}</span>
        {readOnly ? <span className="badge">Read only</span> : null}
      </div>
    </div>
  );
}
