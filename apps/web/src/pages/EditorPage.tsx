import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { PMNode } from '@docforge/model';
import {
  api,
  ApiError,
  downloadExport,
  type DocumentDetail,
  type ShareEntry,
  type User,
  type VersionSummary,
} from '../lib/api';
import { DocumentEditor, type SaveState } from '../components/DocumentEditor';
import { useSession } from '../lib/session';
import { textField } from '../lib/forms';

interface EditorPageProps {
  documentId: string;
  onBack: () => void;
}

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'All changes saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  error: 'Save failed',
  conflict: 'Someone else saved first',
};

export function EditorPage({ documentId, onBack }: EditorPageProps): JSX.Element {
  const { user } = useSession();
  const [document, setDocument] = useState<DocumentDetail | null>(null);
  const [title, setTitle] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [shares, setShares] = useState<ShareEntry[] | null>(null);
  const [directory, setDirectory] = useState<User[]>([]);
  const revision = useRef(0);
  // One save at a time, with the next one waiting its turn.
  //
  // Without this, the title field losing focus at the same moment the body
  // autosaves sent two writes carrying the same expected revision. The first
  // won, the second was rejected as a conflict, and because the revision was
  // only updated on success the editor then failed every later save while the
  // person carried on typing into text that would never be stored again.
  const inFlight = useRef(false);
  const queued = useRef<{ content?: PMNode; title?: string } | null>(null);
  // Keystrokes that have happened but have not yet been handed over.
  //
  // The editor waits a moment after typing stops before reporting a change, so
  // "nothing queued" is not the same as "nothing unsaved". Treating them as the
  // same showed "All changes saved" while recent keystrokes were still sitting
  // in that gap, and the warning shown when closing the tab is keyed on the
  // same state, so a tab closed in that window lost them without a word.
  const typedSinceQueued = useRef(false);
  // Bumped when the document is replaced wholesale, so an answer from before
  // the replacement is recognised and ignored.
  const generation = useRef(0);
  // Bumped to remount the editing surface. The editor takes its content once,
  // when it is created, so replacing the text wholesale means giving it a new
  // instance. This used to reload the whole page, which threw away the scroll
  // position and every other piece of page state along with it.
  const [surface, setSurface] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { document: loaded } = await api.getDocument(documentId);
        if (cancelled) return;
        setDocument(loaded);
        setTitle(loaded.title);
        revision.current = loaded.revision;
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : 'Could not open that document.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  const readOnly = document?.access === 'view';

  const persist = useCallback(
    async (payload: { content?: PMNode; title?: string }) => {
      queued.current = { ...(queued.current ?? {}), ...payload };
      // The editor only hands over content once it has gone quiet, so at this
      // point everything typed so far is accounted for.
      if (payload.content !== undefined) typedSinceQueued.current = false;
      if (inFlight.current) return;

      inFlight.current = true;
      let startedAt = generation.current;
      try {
        while (queued.current) {
          const next = queued.current;
          queued.current = null;
          setSaveState('saving');
          try {
            const { document: saved } = await api.saveDocument(documentId, {
              ...next,
              expectedRevision: revision.current,
            });
            if (generation.current !== startedAt) {
              // The document was replaced while this was on its way, so its
              // answer says nothing about the document now open. Returning here
              // left anything queued since the replacement stranded, with the
              // badge claiming everything was saved.
              startedAt = generation.current;
              continue;
            }
            revision.current = saved.revision;
            setDocument((current) => (current ? { ...current, ...saved } : saved));
            setError(null);
            if (!queued.current) setSaveState(typedSinceQueued.current ? 'dirty' : 'saved');
          } catch (caught) {
            if (generation.current !== startedAt) {
              // The failure belongs to a document that is no longer open, and
              // so does the payload that caused it.
              startedAt = generation.current;
              continue;
            }
            // Put the work back so it is not lost, whatever went wrong.
            queued.current = { ...next, ...(queued.current ?? {}) };
            if (caught instanceof ApiError && caught.status === 409) {
              // Somebody else has moved the document on. Retrying would either
              // fail forever or overwrite their work, so stop and say so.
              queued.current = null;
              setSaveState('conflict');
              setError(caught.message);
              return;
            }
            setSaveState('error');
            setError(
              caught instanceof ApiError
                ? caught.message
                : 'Could not save. Your changes are still here.',
            );
            return;
          }
        }
      } finally {
        inFlight.current = false;
      }
    },
    [documentId],
  );

  // Warn before leaving with unsaved work.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent): void => {
      if (saveState !== 'saved') event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [saveState]);

  /** A failed download used to be an unhandled rejection with nothing on screen. */
  const download = async (format: 'docx' | 'txt'): Promise<void> => {
    try {
      await downloadExport(documentId, format);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not download this document.');
    }
  };

  const saveTitle = async (): Promise<void> => {
    if (!document || title === document.title) return;
    await persist({ title });
  };

  const openVersions = async (): Promise<void> => {
    if (versions) {
      setVersions(null);
      return;
    }
    try {
      const { versions: list } = await api.listVersions(documentId);
      setVersions(list);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the version history.');
    }
  };

  const restore = async (target: number): Promise<void> => {
    if (!window.confirm(`Restore revision ${target}? The current text is kept as a new version.`)) {
      return;
    }
    try {
      const { document: restored } = await api.restoreVersion(documentId, target);
      // Abandon any save still in flight or waiting. Its answer would put the
      // revision and the document back to where they were before the restore,
      // while the editor showed the restored text.
      generation.current += 1;
      queued.current = null;
      typedSinceQueued.current = false;
      revision.current = restored.revision;
      setDocument(restored);
      setTitle(restored.title);
      setVersions(null);
      setSaveState('saved');
      setError(null);
      setSurface((count) => count + 1);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not restore that version.');
    }
  };

  const openSharing = async (): Promise<void> => {
    if (shares) {
      setShares(null);
      return;
    }
    try {
      const [{ shares: list }, { users }] = await Promise.all([
        api.listShares(documentId),
        api.listUsers(),
      ]);
      setShares(list);
      setDirectory(users.filter((candidate) => candidate.id !== user?.id));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the sharing list.');
    }
  };

  if (error && !document) {
    return (
      <div className="page-wrap">
        <p className="error" role="alert">
          {error}
        </p>
        <button type="button" onClick={onBack}>
          Back to documents
        </button>
      </div>
    );
  }

  if (!document) return <p className="muted page-wrap">Opening…</p>;

  return (
    <div className="editor-page">
      <header className="editor-header">
        <button type="button" className="link" onClick={onBack}>
          ← Documents
        </button>
        <input
          className="title-input"
          value={title}
          readOnly={readOnly}
          aria-label="Document title"
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void saveTitle()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        <span className={`save-state save-${saveState}`}>{SAVE_LABEL[saveState]}</span>
        {saveState === 'conflict' ? (
          <button
            type="button"
            className="primary"
            onClick={() => {
              window.location.reload();
            }}
          >
            Reload
          </button>
        ) : null}
        <div className="actions">
          <button type="button" onClick={() => { void download('docx'); }}>
            Export .docx
          </button>
          <button type="button" onClick={() => { void download('txt'); }}>
            Export .txt
          </button>
          <button type="button" onClick={() => void openVersions()}>
            History
          </button>
          {document.access === 'owner' ? (
            <button type="button" onClick={() => void openSharing()}>
              Share
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      {versions ? (
        <aside className="panel">
          <h2>Version history</h2>
          <ul className="version-list">
            {versions.map((version) => (
              <li key={version.revision}>
                <span>
                  Revision {version.revision} by {version.authorName} on{' '}
                  {new Date(version.createdAt).toLocaleString()}
                </span>
                {!readOnly && version.revision !== document.revision ? (
                  <button type="button" onClick={() => void restore(version.revision)}>
                    Restore
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </aside>
      ) : null}

      {shares ? (
        <aside className="panel">
          <h2>Sharing</h2>
          {shares.length === 0 ? <p className="muted">Not shared with anyone yet.</p> : null}
          <ul className="version-list">
            {shares.map((share) => (
              <li key={share.userId}>
                <span>
                  {share.name} can {share.permission}
                </span>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    void (async () => {
                      try {
                        const { shares: updated } = await api.unshare(documentId, share.userId);
                        setShares(updated);
                      } catch (caught) {
                        setError(
                          caught instanceof ApiError ? caught.message : 'Could not remove that share.',
                        );
                      }
                    })();
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <form
            className="share-form"
            onSubmit={(event) => {
              event.preventDefault();
              // Read the form before yielding: React clears currentTarget.
              const form = new FormData(event.currentTarget);
              const userId = textField(form, 'userId');
              const permission = textField(form, 'permission', 'view') as 'view' | 'edit';
              if (!userId) return;
              void (async () => {
                try {
                  const { shares: updated } = await api.share(documentId, userId, permission);
                  setShares(updated);
                } catch (caught) {
                  setError(
                    caught instanceof ApiError ? caught.message : 'Could not share that document.',
                  );
                }
              })();
            }}
          >
            <label>
              Person
              <select name="userId" required>
                <option value="">Choose a person</option>
                {directory.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} ({candidate.email})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Permission
              <select name="permission" defaultValue="view">
                <option value="view">Can view</option>
                <option value="edit">Can edit</option>
              </select>
            </label>
            <button type="submit" className="primary">
              Share
            </button>
          </form>
        </aside>
      ) : null}

      <DocumentEditor
        key={surface}
        initialContent={document.content}
        readOnly={readOnly ?? false}
        onDirty={() => {
          typedSinceQueued.current = true;
          setSaveState((current) => (current === 'conflict' ? current : 'dirty'));
        }}
        onChange={(content) => void persist({ content })}
      />
    </div>
  );
}
