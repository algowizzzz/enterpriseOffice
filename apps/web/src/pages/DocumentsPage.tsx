import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { api, ApiError, downloadExport, type DocumentSummary } from '../lib/api';
import { useSession } from '../lib/session';

interface DocumentsPageProps {
  onOpen: (id: string) => void;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export function DocumentsPage({ onOpen }: DocumentsPageProps): JSX.Element {
  const { user } = useSession();
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { documents: list } = await api.listDocuments();
      setDocuments(list);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load your documents.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createBlank = async (): Promise<void> => {
    setBusy(true);
    try {
      const { document } = await api.createDocument({ title: 'Untitled document' });
      onOpen(document.id);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the document.');
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File): Promise<void> => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const { document, messages } = await api.importDocx(file);
      if (messages.length > 0) setNotice(messages.join(' '));
      onOpen(document.id);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The upload failed.');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const remove = async (document: DocumentSummary): Promise<void> => {
    if (!window.confirm(`Delete "${document.title}"? This cannot be undone.`)) return;
    try {
      await api.deleteDocument(document.id);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not delete the document.');
    }
  };

  const canCreate = user?.role !== 'viewer';

  return (
    <div className="page-wrap">
      <header className="page-header">
        <div>
          <h1>Documents</h1>
          <p className="muted">Create a document, or upload a Word file to keep working on it.</p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="primary"
            onClick={createBlank}
            disabled={busy || !canCreate}
          >
            New blank document
          </button>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy || !canCreate}
          >
            Upload .docx
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </div>
      </header>

      {!canCreate ? (
        <p className="hint">Your account can read documents shared with you, but not create them.</p>
      ) : null}
      {notice ? <p className="notice">{notice}</p> : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : documents.length === 0 ? (
        <div className="empty">
          <p>You have no documents yet.</p>
          <p className="muted">Start a blank one, or upload a .docx file.</p>
        </div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Owner</th>
              <th scope="col">Words</th>
              <th scope="col">Last saved</th>
              <th scope="col">Access</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {documents.map((document) => (
              <tr key={document.id}>
                <td>
                  <button type="button" className="link" onClick={() => onOpen(document.id)}>
                    {document.title}
                  </button>
                  {document.origin === 'import' ? (
                    <span className="badge" title={document.sourceName ?? ''}>
                      imported
                    </span>
                  ) : null}
                </td>
                <td>{document.ownerId === user?.id ? 'You' : document.ownerName}</td>
                <td>{document.wordCount}</td>
                <td>{formatWhen(document.updatedAt)}</td>
                <td>{document.access}</td>
                <td className="row-actions">
                  <button type="button" onClick={() => void downloadExport(document.id, 'docx')}>
                    Download
                  </button>
                  {document.access === 'owner' ? (
                    <button type="button" className="danger" onClick={() => void remove(document)}>
                      Delete
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
