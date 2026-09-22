import { useEffect, useState, type JSX } from 'react';
import type { Editor } from '@tiptap/react';

export interface HeadingEntry {
  /** Position of the heading node itself, so a click can select just past it. */
  position: number;
  level: number;
  text: string;
}

/**
 * The document's own outline, the way Word's Navigation pane builds one: every
 * heading, in document order, nested by level. Nothing here is stored or sent
 * anywhere; it is read straight off the editor's own state, so it is never out
 * of step with what is on the page, live co-editing included.
 */
export function headingsIn(editor: Editor): HeadingEntry[] {
  const found: HeadingEntry[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name !== 'heading') return true;
    found.push({
      position,
      level: Number(node.attrs['level'] ?? 1),
      text: node.textContent.trim(),
    });
    return false;
  });
  return found;
}

interface NavigationPaneProps {
  editor: Editor | null;
  onClose: () => void;
}

/**
 * A left-hand jump list built from the document's headings, the everyday use
 * of Word's Navigation pane: find a section in a long document without
 * scrolling through it. Renaming a heading style is a Toolbar concern; this
 * only reads and jumps.
 */
export function NavigationPane({ editor, onClose }: NavigationPaneProps): JSX.Element {
  const [headings, setHeadings] = useState<HeadingEntry[]>([]);

  useEffect(() => {
    if (!editor) {
      setHeadings([]);
      return undefined;
    }
    const recount = (): void => setHeadings(headingsIn(editor));
    recount();
    editor.on('update', recount);
    // Switching between the Document, Original and Redline tabs replaces the
    // editor instance, which recount() alone would not notice.
    editor.on('transaction', recount);
    return () => {
      editor.off('update', recount);
      editor.off('transaction', recount);
    };
  }, [editor]);

  const jumpTo = (position: number): void => {
    if (!editor) return;
    // One past the heading's own start, so the caret lands inside its text
    // rather than selecting the heading node as a whole.
    const target = Math.min(position + 1, editor.state.doc.content.size);
    editor.chain().focus().setTextSelection(target).scrollIntoView().run();
  };

  return (
    <aside className="nav-pane" aria-label="Navigation">
      <div className="nav-pane-head">
        <h2>Navigation</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      {headings.length === 0 ? (
        <p className="muted">
          No headings yet. Give a line a Heading style in the toolbar to see it here.
        </p>
      ) : (
        <ul className="nav-pane-list">
          {headings.map((heading) => (
            <li key={heading.position}>
              <button
                type="button"
                className="nav-pane-item"
                style={{ paddingLeft: `${8 + (heading.level - 1) * 14}px` }}
                title={heading.text || 'Untitled heading'}
                onClick={() => jumpTo(heading.position)}
              >
                {heading.text || <em>Untitled heading</em>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
