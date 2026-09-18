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

interface EditorPageProps {
  documentId: string;
  onBack: () => void;
}

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'All changes saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  error: 'Save failed',
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
      setSaveState('saving');
      try {
        const { document: saved } = await api.saveDocument(documentId, {
          ...payload,
          expectedRevision: revision.current,
        });
        revision.current = saved.revision;
        setDocument((current) => (current ? { ...current, ...saved } : saved));
        setSaveState('saved');
        setError(null);
      } catch (caught) {
        setSaveState('error');
        setError(
          caught instanceof ApiError ? caught.message : 'Could not save. Your changes are still here.',
        );
      }
    },
    [documentId],
  );

  // Warn before leaving with unsaved work.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent): void => {
      if (saveState === 'dirty' || saveState === 'saving') event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [saveState]);

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
        <div className="actions">
          <button type="button" onClick={() => void downloadExport(documentId, 'docx')}>
            Export .docx
          </button>
          <button type="button" onClick={() => void downloadExport(documentId, 'txt')}>
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
                  onClick={async () => {
                    const { shares: updated } = await api.unshare(documentId, share.userId);
                    setShares(updated);
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <form
            className="share-form"
            onSubmit={async (event) => {
              event.preventDefault();
              // Read the form before yielding: React clears currentTarget.
              const form = new FormData(event.currentTarget);
              const userId = String(form.get('userId') ?? '');
              const permission = String(form.get('permission') ?? 'view') as 'view' | 'edit';
              if (!userId) return;
              const { shares: updated } = await api.share(documentId, userId, permission);
              setShares(updated);
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
        onDirty={() => setSaveState((current) => (current === 'saving' ? current : 'dirty'))}
        onChange={(content) => void persist({ content })}
      />
    </div>
  );
}
