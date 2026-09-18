import { useEffect, useState, type JSX } from 'react';
import type { Editor } from '@tiptap/react';
import { listChanges, settleChanges, type TrackedChange } from './trackChanges';

interface ReviewPanelProps {
  editor: Editor | null;
  readOnly: boolean;
  tracking: boolean;
  onTracking: (enabled: boolean) => void;
  onClose: () => void;
}

const when = (iso: string): string => {
  const date = new Date(iso);
  return iso && !Number.isNaN(date.getTime()) ? date.toLocaleString() : '';
};

/** Tracked changes: switch tracking on and off, and accept or reject what is there. */
export function ReviewPanel({ editor, readOnly, tracking, onTracking, onClose }: ReviewPanelProps): JSX.Element {
  const [changes, setChanges] = useState<TrackedChange[]>([]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return undefined;
    const refresh = (): void => setChanges(listChanges(editor.state.doc));
    refresh();
    editor.on('update', refresh);
    return () => {
      editor.off('update', refresh);
    };
  }, [editor]);

  const go = (change: TrackedChange): void => {
    editor?.chain().focus().setTextSelection({ from: change.from, to: change.to }).scrollIntoView().run();
  };

  return (
    <aside className="comments-panel" aria-label="Review">
      <div className="comments-head">
        <h2>Review</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>

      <label className="track-toggle" title="While this is on, what you type is marked as inserted and what you delete is kept, struck out, until somebody accepts it">
        <input type="checkbox" checked={tracking} disabled={readOnly} onChange={(event) => onTracking(event.target.checked)} />
        Track changes
      </label>

      {changes.length > 0 && !readOnly ? (
        <div className="comment-actions">
          <button type="button" className="primary" onClick={() => editor && settleChanges(editor, 'accept')}>
            Accept all
          </button>
          <button type="button" onClick={() => editor && settleChanges(editor, 'reject')}>
            Reject all
          </button>
        </div>
      ) : null}

      {changes.length === 0 ? <p className="muted">No tracked changes.</p> : null}

      {changes.map((change) => (
        <section key={`${change.from}-${change.type}-${change.paragraphAt ?? 't'}`} className="comment-thread" onClick={() => go(change)}>
          <div className="comment-meta">
            <strong>{change.author || 'Unknown'}</strong>
            <span className="muted">{when(change.date)}</span>
          </div>
          <p className="comment-body">
            <span className={`change-kind change-kind-${change.type}`}>
              {change.type === 'insertion' ? 'Inserted' : 'Deleted'}
            </span>{' '}
            {change.paragraphAt !== undefined
              ? 'Paragraph break'
              : change.text.length > 140
                ? `${change.text.slice(0, 140)}…`
                : change.text}
          </p>
          {readOnly ? null : (
            <div className="comment-actions">
              <button
                type="button"
                className="link"
                onClick={(event) => {
                  event.stopPropagation();
                  if (editor) settleChanges(editor, 'accept', { from: change.from, to: change.to - 1 });
                }}
              >
                Accept
              </button>
              <button
                type="button"
                className="link"
                onClick={(event) => {
                  event.stopPropagation();
                  if (editor) settleChanges(editor, 'reject', { from: change.from, to: change.to - 1 });
                }}
              >
                Reject
              </button>
            </div>
          )}
        </section>
      ))}
    </aside>
  );
}
