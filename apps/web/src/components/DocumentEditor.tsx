import { useEffect, useRef, useState, type JSX } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import {
  repairDocument,
  styleSheetFor,
  type PMNode,
  type RepairResult,
  type StyleTable,
} from '@docforge/model';
import { buildExtensions, editorExtensions, type SharedEditing } from './editorExtensions';
import { Toolbar } from './Toolbar';
import { FindBar } from './FindBar';
import { api } from '../lib/api';
import {
  correctSpelling,
  loadSpeller,
  misspellingAt,
  recheckSpelling,
  setSpeller,
  type Misspelling,
  type SpellLanguage,
  type Speller,
} from './spellcheck';

/**
 * A document without the attributes the editor left at their default.
 *
 * Tiptap writes every attribute a node could have, and nearly all of them are
 * null: a paragraph that says nothing about itself was stored as a dozen ways
 * of saying nothing. On a long document that doubled what every autosave sent.
 */
export function withoutDefaults(node: PMNode): PMNode {
  const clean: PMNode = { type: node.type };
  if (node.attrs) {
    const kept = Object.entries(node.attrs).filter(([, value]) => value !== null && value !== undefined);
    if (kept.length > 0) clean.attrs = Object.fromEntries(kept);
  }
  if (node.marks) {
    clean.marks = node.marks.map((mark) => {
      const kept = Object.entries(mark.attrs ?? {}).filter(([, value]) => value !== null && value !== undefined);
      return kept.length > 0 ? { type: mark.type, attrs: Object.fromEntries(kept) } : { type: mark.type };
    });
  }
  if (node.text !== undefined) clean.text = node.text;
  if (node.content) clean.content = node.content.map(withoutDefaults);
  return clean;
}

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'offline';

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
   * The document's own styles, read from the file it was uploaded as. Without
   * them every heading is the editor's idea of a heading, and "my formatting
   * changed" is the first thing anybody says.
   */
  styles?: StyleTable | null;
  /**
   * Called when the repair had to remove something, so the caller can say so.
   *
   * Removing content somebody can see, with no message, is worse than the
   * refusal it replaced: a refusal is visible, this is not. It is not called
   * when the repair only filled a gap, such as putting a paragraph into an
   * empty quote, because nothing was lost and saying otherwise is untrue.
   */
  onRepair?: (when: 'open' | 'save') => void;
  /**
   * Set when several people hold this document at once. The text then comes
   * from the shared document rather than from `initialContent`, and is stored by
   * the server as they work, so `onChange` is not called.
   */
  shared?: SharedEditing | undefined;
  /** Hands the editor to the page, for the panels that work alongside it. */
  onReady?: (editor: Editor | null) => void;
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
  onReady,
  shared,
  header = '',
  footer = '',
  styles = null,
}: DocumentEditorProps): JSX.Element {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useRef<(() => void) | null>(null);
  const [stats, setStats] = useState<DocumentStats>({ words: 0, characters: 0 });
  const [finding, setFinding] = useState(false);
  const [spelling, setSpelling] = useState<SpellLanguage | null>(() => {
    const kept = window.localStorage.getItem('docforge-spelling');
    return kept === 'en-GB' || kept === 'en-US' ? kept : null;
  });
  const speller = useRef<Speller | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; target: Misspelling; suggestions: string[] } | null>(null);
  const [notes, setNotes] = useState<{ kind: string; number: string; words: string }[]>([]);

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
      extensions: shared ? buildExtensions(shared) : editorExtensions,
      // A shared document brings its own text. Handing it this as well would
      // insert the whole document a second time for everybody.
      ...(shared ? {} : { content: opened.current.doc }),
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
        if (shared) return;
        if (timer.current) clearTimeout(timer.current);
        const handOver = (): void => {
          timer.current = null;
          flush.current = null;
          // Repaired on the way out. Pasted markup can carry a remote image or
          // an odd hyperlink, and tightening a server rule without this made a
          // single paste enough to strand a document for ever.
          const result = repairDocument(withoutDefaults(instance.getJSON() as PMNode));
          if (result.removed) report.current?.('save');
          onChange(result.doc);
        };
        flush.current = handOver;
        timer.current = setTimeout(handOver, AUTOSAVE_DEBOUNCE_MS);
      },
    },
    [],
  );

  // Derive the counts from the editor rather than recomputing them in two
  // separate callbacks. Keeping them in the update handler meant the numbers
  // were only correct once something had changed the document.
  useEffect(() => {
    if (!editor) return undefined;
    const recount = (): void => {
      setStats(statsFor(editor.getText()));
      // The notes at the foot of the page, in the order their marks appear.
      const found: { kind: string; number: string; words: string }[] = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name !== 'wordInline') return true;
        const { kind, label, note } = node.attrs as { kind?: string; label?: string; note?: string };
        if ((kind === 'footnote' || kind === 'endnote') && note) found.push({ kind, number: label ?? '', words: note });
        return false;
      });
      setNotes(found.slice(0, 500));
    };
    recount();
    editor.on('update', recount);
    return () => {
      editor.off('update', recount);
    };
  }, [editor]);

  useEffect(() => {
    if (opened.current?.removed) report.current?.('open');
  }, []);

  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    ready.current?.(editor);
    return () => ready.current?.(null);
  }, [editor]);

  useEffect(() => {
    return () => {
      // Whatever was typed in the last moment is handed over before the editor
      // goes. Switching to the redline and back within the debounce used to
      // throw those keystrokes away, because the timer was simply cancelled.
      if (timer.current) clearTimeout(timer.current);
      flush.current?.();
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

  // Spelling: the dictionary, then this person's own words on top of it.
  useEffect(() => {
    if (!editor) return undefined;
    let cancelled = false;
    window.localStorage.setItem('docforge-spelling', spelling ?? '');
    if (!spelling) {
      speller.current = null;
      setSpeller(editor, null);
      return undefined;
    }
    void (async () => {
      try {
        const [dictionary, own] = await Promise.all([
          loadSpeller(spelling),
          api.listWords().catch(() => ({ words: [] as string[] })),
        ]);
        if (cancelled) return;
        for (const word of own.words) dictionary.add(word);
        speller.current = dictionary;
        setSpeller(editor, dictionary);
      } catch {
        // No dictionary, no underlines: the browser's own check is left on.
        if (!cancelled) setSpelling(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editor, spelling]);

  // Right-click on an underlined word: what it might have been, and "it is right".
  useEffect(() => {
    if (!editor) return undefined;
    const dom = editor.view.dom;
    const onContext = (event: MouseEvent): void => {
      if (!speller.current || !(event.target as HTMLElement | null)?.closest?.('.spell-error')) return;
      const at = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      const target = at ? misspellingAt(editor, at.pos) : null;
      if (!target) return;
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY, target, suggestions: speller.current.suggest(target.word).slice(0, 6) });
    };
    const close = (): void => setMenu(null);
    dom.addEventListener('contextmenu', onContext);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      dom.removeEventListener('contextmenu', onContext);
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [editor]);

  // Ctrl+F and Ctrl+H open the find bar, as they do in Word, instead of the
  // browser's own search, which cannot see past what is on screen or replace.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'f' && key !== 'h') return;
      event.preventDefault();
      setFinding(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!editor) return <div className="editor-loading">Preparing the editor…</div>;

  return (
    <div className="editor">
      {/* Built from numbers and checked words only: see styleSheetFor. */}
      {styles ? <style>{styleSheetFor(styles, '.page')}</style> : null}
      <Toolbar
        editor={editor}
        disabled={readOnly}
        styles={styles}
        onFind={() => setFinding((open) => !open)}
        spelling={spelling}
        onSpelling={setSpelling}
      />
      {menu ? (
        <div className="spell-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
          {menu.suggestions.length === 0 ? <span className="muted">No suggestions</span> : null}
          {readOnly
            ? null
            : menu.suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  role="menuitem"
                  onClick={() => correctSpelling(editor, menu.target, suggestion)}
                >
                  {suggestion}
                </button>
              ))}
          <button
            type="button"
            role="menuitem"
            className="spell-menu-add"
            title="Remembered for you, wherever you sign in"
            onClick={() => {
              speller.current?.add(menu.target.word);
              recheckSpelling(editor);
              void api.addWord(menu.target.word).catch(() => undefined);
            }}
          >
            Add “{menu.target.word}” to my dictionary
          </button>
        </div>
      ) : null}
      {finding ? <FindBar editor={editor} readOnly={readOnly} onClose={() => setFinding(false)} /> : null}
      <div className="page-surface">
        <div className="page-frame">
          {header ? (
            <div className="page-running page-running-header" aria-label="Page header">
              {header}
            </div>
          ) : null}
          <EditorContent editor={editor} />
          {notes.length > 0 ? (
            <div className="page-notes" aria-label="Footnotes and endnotes">
              {notes.map((entry, index) => (
                <p key={`${entry.kind}-${index}`}>
                  <sup>{entry.number}</sup> {entry.words}
                </p>
              ))}
              <p className="hint">Notes are kept as they are in the Word file. Edit their wording in Word.</p>
            </div>
          ) : null}
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
