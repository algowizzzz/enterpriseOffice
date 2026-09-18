import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  api,
  ApiError,
  downloadExport,
  DOCUMENT_TYPES,
  type DocumentSummary,
  type DocumentType,
} from '../lib/api';
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

  const [docType, setDocType] = useState<DocumentType | ''>('');
  const [stripRunning, setStripRunning] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const upload = async (file: File): Promise<void> => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const options = { ...(docType ? { docType } : {}), ...(stripRunning ? { stripRunning } : {}) };
      const { document, messages } = await (Object.keys(options).length > 0
        ? api.importDocx(file, options)
        : api.importDocx(file));
      if (messages.length > 0) setNotice(messages.join(' '));
      onOpen(document.id);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The upload failed.');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  /** A failed download used to be an unhandled rejection with nothing on screen. */
  const download = async (id: string, format: 'docx' | 'txt'): Promise<void> => {
    setError(null);
    try {
      await downloadExport(id, format);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not download that document.');
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
          <p className="muted">Create a document, or upload a Word file or a PDF to keep working on it.</p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="primary"
            onClick={() => {
              void createBlank();
            }}
            disabled={busy || !canCreate}
          >
            New blank document
          </button>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy || !canCreate}
          >
            Upload Word or PDF
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".docx,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </div>
      </header>

      {canCreate ? (
        <div className="upload-options">
          <label title="Recorded with the document and shown beside its name">
            Type of document for the next upload
            <select value={docType} onChange={(event) => setDocType(event.target.value as DocumentType | '')}>
              <option value="">Not stated</option>
              {DOCUMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label title="Leave the uploaded file's own header and footer out, so that the approved ones can be applied. The original file is kept either way">
            <input type="checkbox" checked={stripRunning} onChange={(event) => setStripRunning(event.target.checked)} />{' '}
            Remove the file&rsquo;s header and footer
          </label>
          <button type="button" className="link" aria-expanded={helpOpen} onClick={() => setHelpOpen((open) => !open)}>
            {helpOpen ? 'Hide the guide' : 'How this works'}
          </button>
        </div>
      ) : null}
      {helpOpen ? (
        <section className="panel guide" aria-label="How this works">
          <h2>How this works</h2>
          <ol>
            <li>
              <strong>Upload</strong> a Word file. It opens looking as it did in Word: its own styles, numbering, tables,
              pictures, header and footer. The file you uploaded is kept untouched and can be downloaded again with
              <em> Original</em>.
            </li>
            <li>
              <strong>Edit</strong> it here. Several people can type in the same document at once and see each other.
              Anything Word holds that cannot be edited here (a chart, a text box, a footnote mark) is shown as a
              placeholder and goes back out exactly as it came in.
            </li>
            <li>
              <strong>Review</strong>. Switch on <em>Track changes</em> to propose edits, comment on selected words, reply
              and resolve. People with view access can comment. <em>Redline</em> shows everything that has changed since
              the original.
            </li>
            <li>
              <strong>Export</strong> to Word at any time, with tracked changes as they stand or all accepted, or as a
              redline other people can accept and reject in Word.
            </li>
          </ol>
          <p className="hint">
            Hover over any button for a description. Ctrl+F finds and replaces. Every save is kept under History.
          </p>
        </section>
      ) : null}

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
          <p className="muted">Start a blank one, or upload a Word file or a PDF.</p>
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
                  {document.docType ? <span className="badge badge-type">{document.docType}</span> : null}
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
                  <button type="button" onClick={() => { void download(document.id, 'docx'); }}>
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
