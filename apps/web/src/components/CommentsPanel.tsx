import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { Editor } from '@tiptap/react';
import { anchorFor, textBlocks, type CommentAnchor, type PMNode } from '@docforge/model';
import { api, ApiError, type CommentThread, type DocumentComment } from '../lib/api';
import { commentHighlightsKey, type HighlightedThread } from './commentHighlights';

interface CommentsPanelProps {
  documentId: string;
  editor: Editor | null;
  onClose: () => void;
  onCount?: (open: number) => void;
}

/**
 * The anchor for what is selected, or null when nothing usable is.
 *
 * A selection that runs over several paragraphs is cut at the end of the first:
 * an anchor lives in one block of text, which is also all Word can say.
 */
export function anchorForSelection(editor: Editor): CommentAnchor | null {
  const { from, to } = editor.state.selection;
  if (from === to) return null;
  const blocks = textBlocks(editor.state.doc.toJSON() as PMNode);
  const index = blocks.findIndex((block) => from >= block.start && from <= block.start + block.text.length);
  const block = blocks[index];
  if (!block) return null;
  const end = Math.min(to, block.start + block.text.length);
  return anchorFor(blocks, index, from - block.start, end - block.start);
}

const when = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
};

function Entry({
  comment,
  onEdit,
  onRemove,
}: {
  comment: DocumentComment;
  onEdit: (body: string) => Promise<void>;
  onRemove: () => Promise<void>;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  return (
    <div className="comment-entry">
      <div className="comment-meta">
        <strong>{comment.authorName}</strong>
        <span className="muted">{when(comment.createdAt)}</span>
      </div>
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onEdit(draft).then(() => setEditing(false));
          }}
        >
          <textarea value={draft} aria-label="Edit comment" onChange={(event) => setDraft(event.target.value)} />
          <div className="comment-actions">
            <button type="submit" className="primary" disabled={draft.trim().length === 0}>
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="comment-body">{comment.body}</p>
      )}
      {comment.mine && !editing ? (
        <div className="comment-actions">
          {comment.authorId ? (
            <button type="button" className="link" onClick={() => setEditing(true)}>
              Edit
            </button>
          ) : null}
          <button type="button" className="link danger-link" onClick={() => void onRemove()}>
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function CommentsPanel({ documentId, editor, onClose, onCount }: CommentsPanelProps): JSX.Element {
  const [threads, setThreads] = useState<CommentThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<CommentAnchor | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [detached, setDetached] = useState<string[]>([]);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [reply, setReply] = useState('');

  const fail = (caught: unknown, fallback: string): void =>
    setError(caught instanceof ApiError ? caught.message : fallback);

  const reload = useCallback(async () => {
    try {
      const { threads: list } = await api.listComments(documentId);
      setThreads(list);
      setError(null);
    } catch (caught) {
      fail(caught, 'Could not load the comments.');
    }
  }, [documentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    onCount?.((threads ?? []).filter((thread) => !thread.resolvedAt).length);
  }, [threads, onCount]);

  // Hand the editor what to highlight, and learn back what it could not find.
  const highlighted = useMemo<HighlightedThread[]>(
    () =>
      (threads ?? [])
        .filter((thread) => thread.anchor && (showResolved || !thread.resolvedAt))
        .map((thread) => ({
          id: thread.id,
          anchor: thread.anchor as CommentAnchor,
          resolved: thread.resolvedAt !== null,
        })),
    [threads, showResolved],
  );

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(commentHighlightsKey, { threads: highlighted, active }));
    setDetached(commentHighlightsKey.getState(editor.state)?.detached ?? []);
  }, [editor, highlighted, active]);

  // Leaving the panel takes the highlights with it.
  useEffect(
    () => () => {
      if (editor && !editor.isDestroyed) {
        editor.view.dispatch(editor.state.tr.setMeta(commentHighlightsKey, { threads: [], active: null }));
      }
    },
    [editor],
  );

  // Clicking highlighted words opens their thread.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return undefined;
    const dom = editor.view.dom;
    const onClick = (event: MouseEvent): void => {
      const mark = (event.target as HTMLElement | null)?.closest?.('[data-thread]');
      const id = mark?.getAttribute('data-thread');
      if (id) {
        setActive(id);
        document.getElementById(`thread-${id}`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    dom.addEventListener('click', onClick);
    return () => dom.removeEventListener('click', onClick);
  }, [editor]);

  const startComment = (): void => {
    setPending(editor ? anchorForSelection(editor) : null);
    setDraft('');
    setReplyTo(null);
    setActive('new');
  };

  const submit = async (): Promise<void> => {
    try {
      await api.addComment(documentId, { body: draft, ...(pending ? { anchor: pending } : {}) });
      setDraft('');
      setPending(null);
      setActive(null);
      await reload();
    } catch (caught) {
      fail(caught, 'Could not add that comment.');
    }
  };

  const act = async (work: () => Promise<unknown>, fallback: string): Promise<void> => {
    try {
      await work();
      await reload();
    } catch (caught) {
      fail(caught, fallback);
    }
  };

  const visible = (threads ?? []).filter((thread) => showResolved || !thread.resolvedAt);
  const resolvedCount = (threads ?? []).length - (threads ?? []).filter((thread) => !thread.resolvedAt).length;

  return (
    <aside className="comments-panel" aria-label="Comments">
      <div className="comments-head">
        <h2>Comments</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        className="primary"
        title="Select some words first to comment on them, or comment on the whole document"
        onClick={startComment}
      >
        New comment
      </button>

      {active === 'new' ? (
        <form
          className="comment-thread comment-thread-active"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="comment-quote">
            {pending ? `“${pending.quote.slice(0, 160)}${pending.quote.length > 160 ? '…' : ''}”` : 'On the whole document'}
          </p>
          <textarea
            value={draft}
            autoFocus
            aria-label="Comment"
            placeholder="Write a comment"
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="comment-actions">
            <button type="submit" className="primary" disabled={draft.trim().length === 0}>
              Comment
            </button>
            <button type="button" onClick={() => setActive(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {threads === null ? <p className="muted">Loading…</p> : null}
      {threads !== null && visible.length === 0 && active !== 'new' ? (
        <p className="muted">No open comments.</p>
      ) : null}

      {visible.map((thread) => (
        <section
          key={thread.id}
          id={`thread-${thread.id}`}
          className={`comment-thread${active === thread.id ? ' comment-thread-active' : ''}${
            thread.resolvedAt ? ' comment-thread-resolved' : ''
          }`}
          onClick={() => setActive(thread.id)}
        >
          {thread.anchor ? (
            <p className="comment-quote">
              “{thread.anchor.quote.slice(0, 160)}
              {thread.anchor.quote.length > 160 ? '…' : ''}”
              {detached.includes(thread.id) ? (
                <span className="badge" title="The words this comment was made on have since been rewritten">
                  Detached
                </span>
              ) : null}
            </p>
          ) : (
            <p className="comment-quote">On the whole document</p>
          )}
          <Entry
            comment={thread}
            onEdit={(body) => act(() => api.updateComment(documentId, thread.id, { body }), 'Could not change that comment.')}
            onRemove={() => act(() => api.removeComment(documentId, thread.id), 'Could not remove that comment.')}
          />
          {thread.replies.map((entry) => (
            <div key={entry.id} className="comment-reply">
              <Entry
                comment={entry}
                onEdit={(body) => act(() => api.updateComment(documentId, entry.id, { body }), 'Could not change that reply.')}
                onRemove={() => act(() => api.removeComment(documentId, entry.id), 'Could not remove that reply.')}
              />
            </div>
          ))}
          {replyTo === thread.id ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void act(
                  () => api.addComment(documentId, { body: reply, parentId: thread.id }),
                  'Could not add that reply.',
                ).then(() => {
                  setReply('');
                  setReplyTo(null);
                });
              }}
            >
              <textarea value={reply} autoFocus aria-label="Reply" placeholder="Reply" onChange={(event) => setReply(event.target.value)} />
              <div className="comment-actions">
                <button type="submit" className="primary" disabled={reply.trim().length === 0}>
                  Reply
                </button>
                <button type="button" onClick={() => setReplyTo(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="comment-actions">
              <button type="button" className="link" onClick={() => setReplyTo(thread.id)}>
                Reply
              </button>
              <button
                type="button"
                className="link"
                onClick={() =>
                  void act(
                    () => api.updateComment(documentId, thread.id, { resolved: !thread.resolvedAt }),
                    'Could not change that thread.',
                  )
                }
              >
                {thread.resolvedAt ? 'Reopen' : 'Resolve'}
              </button>
            </div>
          )}
        </section>
      ))}

      {resolvedCount > 0 ? (
        <button type="button" className="link" onClick={() => setShowResolved((shown) => !shown)}>
          {showResolved ? 'Hide' : 'Show'} {resolvedCount} resolved
        </button>
      ) : null}
    </aside>
  );
}
