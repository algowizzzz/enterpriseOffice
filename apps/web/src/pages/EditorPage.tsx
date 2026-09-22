import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { defaultPageSetup, type PageSetup, type PMNode } from '@docforge/model';
import {
  api,
  ApiError,
  downloadExport,
  type DocumentDetail,
  type ExportFormat,
  type ExportOptions,
  type ShareEntry,
  type User,
  type VersionSummary,
} from '../lib/api';
import type { Editor } from '@tiptap/react';
import { DocumentEditor, type SaveState } from '../components/DocumentEditor';
import { CommentsPanel } from '../components/CommentsPanel';
import { ReviewPanel } from '../components/ReviewPanel';
import { NavigationPane } from '../components/NavigationPane';
import { ChatPanel } from '../components/ChatPanel';
import { AnalysisPanel } from '../components/AnalysisPanel';
import { AccessRequests } from '../components/AccessRequests';
import { IconLabel } from '../components/IconLabel';
import {
  ArrowLeft,
  Compass,
  FileDown,
  FileText,
  FileType,
  GitCompareArrows,
  History as HistoryIcon,
  Lock as LockIcon,
  MessageCircle,
  MessageSquare,
  PencilLine,
  Settings2,
  Share2,
  Sparkles,
  Unlock as UnlockIcon,
} from 'lucide-react';
import { setTracking } from '../components/trackChanges';
import { joinShared, othersPresent, type Presence, type SharedSession } from '../lib/collab';
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
  offline: 'Offline: your changes are kept and will be sent when the connection returns',
};

export function EditorPage({ documentId, onBack }: EditorPageProps): JSX.Element {
  const { user } = useSession();
  const [document, setDocument] = useState<DocumentDetail | null>(null);
  const [title, setTitle] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [shares, setShares] = useState<ShareEntry[] | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  // Export, history, sharing and locking live behind their own tab, the way
  // Word's own File tab does, rather than lined up next to the title.
  const [ribbonTab, setRibbonTab] = useState<'home' | 'file'>('home');
  const [side, setSide] = useState<'comments' | 'review' | 'chat' | 'analysis' | null>(null);
  const commentsOpen = side === 'comments';
  const setCommentsOpen = (next: boolean | ((open: boolean) => boolean)): void =>
    setSide((current) => {
      const open = typeof next === 'function' ? next(current === 'comments') : next;
      return open ? 'comments' : current === 'comments' ? null : current;
    });
  /** One slot on the right; opening one of these closes whichever else was open. */
  const toggleSide = (name: 'review' | 'chat' | 'analysis'): void =>
    setSide((current) => (current === name ? null : name));
  // Which text is on the page: the document, the file as it was first
  // uploaded, or what has changed between the two.
  const [view, setView] = useState<'document' | 'original' | 'redline'>('document');
  const [shown, setShown] = useState<PMNode | null>(null);
  // Live co-editing. Null while it is being set up, and when it is not on offer
  // or the network will not carry it, in which case saving works as it always did.
  const [session, setSession] = useState<SharedSession | null>(null);
  const [sharedReady, setSharedReady] = useState(false);
  const [sharedFailed, setSharedFailed] = useState(false);
  const [present, setPresent] = useState<Presence[]>([]);
  const [reopen, setReopen] = useState(0);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reminder, setReminder] = useState(() => window.localStorage.getItem('docforge-reminder') !== 'dismissed');
  const [tracking, setTrackingOn] = useState(
    () => window.localStorage.getItem(`docforge-track-${documentId}`) === '1',
  );
  const [openComments, setOpenComments] = useState<number | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [directory, setDirectory] = useState<User[]>([]);
  const revision = useRef(0);
  // One save at a time, with the next one waiting its turn.
  //
  // Without this, the title field losing focus at the same moment the body
  // autosaves sent two writes carrying the same expected revision. The first
  // won, the second was rejected as a conflict, and because the revision was
  // only updated on success the editor then failed every later save while the
  // person carried on typing into text that would never be stored again.
  const liveRef = useRef(false);
  const inFlight = useRef(false);
  const queued = useRef<{ content?: PMNode; title?: string; pageSetup?: PageSetup } | null>(null);
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
  }, [documentId, reopen]);

  const readOnly = document?.access === 'view' || document?.locked === true;
  const epoch = document?.collab?.epoch;
  const userName = user?.name ?? 'Somebody';

  // Join the shared document once it is known which one to join.
  useEffect(() => {
    if (epoch === undefined || typeof WebSocket === 'undefined' || sharedFailed) return undefined;
    setSharedReady(false);
    const joined = joinShared(documentId, epoch, userName, {
      onConnection: (state) =>
        setSaveState((current) =>
          state === 'live' ? (current === 'offline' ? 'saved' : current) : state === 'offline' ? 'offline' : current,
        ),
      // Somebody restored a version, or the text was replaced from outside the
      // editor. This browser's history no longer applies: fetch and join afresh.
      onReplaced: () => setReopen((count) => count + 1),
    });
    const showPresent = (): void => setPresent(othersPresent(joined));
    joined.provider.awareness.on('change', showPresent);
    const synced = (isSynced: boolean): void => {
      if (!isSynced) return;
      setSharedReady(true);
      setSurface((count) => count + 1);
    };
    joined.provider.on('sync', synced);
    // Some networks do not carry WebSockets at all. Rather than leave somebody
    // looking at a spinner, fall back to saving the ordinary way and say so.
    const giveUp = setTimeout(() => {
      if (joined.provider.synced) return;
      joined.close();
      setSession(null);
      setSharedFailed(true);
      setNotice(
        'Live co-editing is not available on this connection, so this document is being saved the ordinary way. If somebody else edits it at the same time, the second save will be refused rather than merged.',
      );
      setSurface((count) => count + 1);
    }, 8000);
    setSession(joined);
    return () => {
      clearTimeout(giveUp);
      joined.provider.awareness.off('change', showPresent);
      joined.close();
      setSession(null);
      setPresent([]);
    };
  }, [documentId, epoch, userName, sharedFailed]);

  const live = session !== null && sharedReady && !sharedFailed;
  liveRef.current = live;

  const persist = useCallback(
    async (payload: { content?: PMNode; title?: string; pageSetup?: PageSetup }) => {
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
              // While the text is shared, the server moves the revision on as
              // people type, so a title saved against the revision this browser
              // last saw would be refused every time.
              ...(liveRef.current ? {} : { expectedRevision: revision.current }),
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
  const download = async (format: ExportFormat, options?: ExportOptions): Promise<void> => {
    try {
      await (options ? downloadExport(documentId, format, options) : downloadExport(documentId, format));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not download this document.');
    }
  };

  /**
   * Change the page setup.
   *
   * Typed into, so it saves on the same path as the text rather than on a
   * button nobody would press: the header is part of the document.
   */
  const changeSetup = (patch: Partial<PageSetup>): void => {
    setDocument((current) => {
      if (!current) return current;
      const pageSetup = { ...(current.pageSetup ?? defaultPageSetup()), ...patch };
      void persist({ pageSetup });
      return { ...current, pageSetup };
    });
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
      // The message belonged to the content that has just been replaced.
      setNotice(null);
      setSurface((count) => count + 1);
      // The shared document was started afresh by the restore, so it has to be
      // joined again. A document one person has to themselves has nothing to
      // rejoin, and fetching it again would race the restored text.
      if (liveRef.current) setReopen((count) => count + 1);
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

  // Tracking is a property of how this person is working on this document, so
  // it is remembered here and handed to the editor whenever there is one.
  useEffect(() => {
    if (!editor || editor.isDestroyed || view !== 'document') return;
    setTracking(editor, tracking && !readOnly, user?.name ?? 'Unknown');
  }, [editor, tracking, readOnly, user?.name, view]);

  const changeTracking = (enabled: boolean): void => {
    setTrackingOn(enabled);
    window.localStorage.setItem(`docforge-track-${documentId}`, enabled ? '1' : '0');
  };

  const show = async (next: 'document' | 'original' | 'redline'): Promise<void> => {
    if (next === 'document') {
      setShown(null);
      setView('document');
      setSurface((count) => count + 1);
      return;
    }
    try {
      const content =
        next === 'original'
          ? (await api.getVersion(documentId, 1)).content
          : (await api.compare(documentId, 1)).content;
      setShown(content);
      setView(next);
      setSurface((count) => count + 1);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load that view.');
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
          <IconLabel icon={ArrowLeft}>Documents</IconLabel>
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
        {present.length > 0 ? (
          <span className="presence" aria-label="Also editing">
            {present.slice(0, 5).map((person) => (
              <span key={person.name} className="presence-chip" style={{ background: person.color }} title={`${person.name} has this document open`}>
                {person.name
                  .split(/\s+/u)
                  .map((word) => word[0] ?? '')
                  .join('')
                  .slice(0, 2)
                  .toUpperCase()}
              </span>
            ))}
            {present.length > 5 ? <span className="muted">+{present.length - 5}</span> : null}
          </span>
        ) : null}
        {document.locked ? (
          <span className="badge" title="Locked by its owner: it can be read and commented on, and not changed">
            Locked: comments only
          </span>
        ) : null}
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
          <button
            type="button"
            title="Find a section by its heading, the way Word's Navigation pane does"
            aria-pressed={navOpen}
            onClick={() => setNavOpen((open) => !open)}
          >
            <IconLabel icon={Compass}>Navigation</IconLabel>
          </button>
          {document.access === 'view' && !document.locked && user?.role !== 'viewer' ? (
            <button
              type="button"
              title="Ask the owner of this document to let you edit it"
              onClick={() => {
                const note = window.prompt('Tell the owner why you need to edit this document (optional)');
                if (note === null) return;
                void api
                  .requestEdit(documentId, note)
                  .then(() => setNotice('Your request has gone to the owner of this document.'))
                  .catch((caught: unknown) =>
                    setError(caught instanceof ApiError ? caught.message : 'Could not send the request.'),
                  );
              }}
            >
              <IconLabel icon={PencilLine}>Ask to edit</IconLabel>
            </button>
          ) : null}
        </div>
      </header>

      {/*
       * File-level actions (export, history, sharing, locking) behind their
       * own tab, the way Word's own File tab holds Save As, Info and Share
       * rather than lining them up next to the formatting controls. Home is
       * the default and shows nothing here: the formatting ribbon a person
       * reaches for while typing is Toolbar.tsx, inside DocumentEditor below,
       * and is not gated by this tab at all.
       */}
      <nav className="ribbon-tabs" aria-label="Ribbon">
        <button
          type="button"
          className={`ribbon-tab${ribbonTab === 'home' ? ' is-active' : ''}`}
          aria-pressed={ribbonTab === 'home'}
          onClick={() => setRibbonTab('home')}
        >
          Home
        </button>
        <button
          type="button"
          className={`ribbon-tab${ribbonTab === 'file' ? ' is-active' : ''}`}
          aria-pressed={ribbonTab === 'file'}
          onClick={() => setRibbonTab('file')}
        >
          File
        </button>
      </nav>
      {ribbonTab === 'file' ? (
        <div className="actions ribbon-file">
          <button type="button" onClick={() => { void download('docx'); }}>
            <IconLabel icon={FileType}>Export .docx</IconLabel>
          </button>
          <button
            type="button"
            title="A paginated PDF with the header, the footer and page numbers"
            onClick={() => { void download('pdf'); }}
          >
            <IconLabel icon={FileDown}>Export .pdf</IconLabel>
          </button>
          <button type="button" onClick={() => { void download('txt'); }}>
            <IconLabel icon={FileText}>Export .txt</IconLabel>
          </button>
          {document.origin === 'import' ? (
            <button
              type="button"
              title="Download the file exactly as it was uploaded"
              onClick={() => { void download('original'); }}
            >
              <IconLabel icon={FileText}>Original</IconLabel>
            </button>
          ) : null}
          <button
            type="button"
            title="Track changes as you type, and accept or reject them"
            aria-pressed={side === 'review'}
            onClick={() => setSide((current) => (current === 'review' ? null : 'review'))}
          >
            <IconLabel icon={GitCompareArrows}>
              Review{tracking ? ' (tracking)' : ''}
            </IconLabel>
          </button>
          <button
            type="button"
            title="Comment on the selected words, reply, and resolve"
            aria-pressed={commentsOpen}
            onClick={() => setCommentsOpen((open) => !open)}
          >
            <IconLabel icon={MessageSquare}>
              Comments{openComments ? ` (${openComments})` : ''}
            </IconLabel>
          </button>
          <button
            type="button"
            title="A preview of a document assistant. Not connected to a model in this build"
            aria-pressed={side === 'chat'}
            onClick={() => toggleSide('chat')}
          >
            <IconLabel icon={MessageCircle}>Chat</IconLabel>
          </button>
          <button
            type="button"
            title="A preview of AI-assisted analysis. Not connected to a model in this build"
            aria-pressed={side === 'analysis'}
            onClick={() => toggleSide('analysis')}
          >
            <IconLabel icon={Sparkles}>Analysis</IconLabel>
          </button>
          <button type="button" onClick={() => setSetupOpen((open) => !open)}>
            <IconLabel icon={Settings2}>Page setup</IconLabel>
          </button>
          <button type="button" onClick={() => void openVersions()}>
            <IconLabel icon={HistoryIcon}>History</IconLabel>
          </button>
          {document.access === 'owner' ? (
            <button
              type="button"
              title={
                document.locked
                  ? 'Release the document so that it can be edited again'
                  : 'Hold the document still while it is approved. Everybody, you included, can read and comment and nobody can change it'
              }
              aria-pressed={document.locked === true}
              onClick={() => {
                void (async () => {
                  try {
                    const { document: next } = await api.setLocked(documentId, !document.locked);
                    setDocument((current) => (current ? { ...current, ...next } : next));
                    // The shared document was started afresh for everybody.
                    if (liveRef.current) setReopen((count) => count + 1);
                    else setSurface((count) => count + 1);
                  } catch (caught) {
                    setError(caught instanceof ApiError ? caught.message : 'Could not change the lock.');
                  }
                })();
              }}
            >
              <IconLabel icon={document.locked ? UnlockIcon : LockIcon}>
                {document.locked ? 'Unlock' : 'Lock'}
              </IconLabel>
            </button>
          ) : null}
          {document.access === 'owner' ? (
            <button type="button" onClick={() => void openSharing()}>
              <IconLabel icon={Share2}>Share</IconLabel>
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      {reminder ? (
        <p className="notice" role="note">
          This is a working copy. The Word file you export is the record: check it before it is approved or issued.
          {document.origin === 'import' ? ' The file as it was uploaded is always available under Original.' : ''}
          <button
            type="button"
            className="link"
            onClick={() => {
              window.localStorage.setItem('docforge-reminder', 'dismissed');
              setReminder(false);
            }}
          >
            Do not show again
          </button>
        </p>
      ) : null}

      {notice ? (
        <p className="notice notice-warning" role="alert">
          {notice}
          <button type="button" className="link" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      ) : null}

      {setupOpen ? (
        <aside className="panel">
          <h2>Page setup</h2>
          <p className="hint">
            The header and footer are printed on every page and are written into the Word file.
          </p>
          <div className="page-setup">
            <label>
              Header
              <input
                value={document.pageSetup?.header ?? ''}
                readOnly={readOnly}
                maxLength={300}
                placeholder="Nothing at the top of the page"
                onChange={(event) => changeSetup({ header: event.target.value })}
              />
            </label>
            <label>
              Footer
              <input
                value={document.pageSetup?.footer ?? ''}
                readOnly={readOnly}
                maxLength={300}
                placeholder="Nothing at the bottom of the page"
                onChange={(event) => changeSetup({ footer: event.target.value })}
              />
            </label>
            <label>
              Orientation
              <select
                value={document.pageSetup?.orientation ?? 'portrait'}
                disabled={readOnly}
                onChange={(event) =>
                  changeSetup({ orientation: event.target.value as PageSetup['orientation'] })
                }
              >
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </label>
          </div>
        </aside>
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
          <AccessRequests documentId={documentId} onChanged={() => void api.listShares(documentId).then(({ shares: updated }) => setShares(updated))} />
          {shares.length === 0 ? <p className="muted">Not shared with anyone yet.</p> : null}
          <ul className="version-list">
            {shares.map((share) => (
              <li key={share.userId}>
                <span>
                  {share.name} can {share.permission}
                </span>
                <button
                  type="button"
                  title="Hand this document over. You keep edit access"
                  onClick={() => {
                    if (!window.confirm(`Make ${share.name} the owner of this document? You will keep edit access.`)) return;
                    void (async () => {
                      try {
                        const { document: handed } = await api.transferOwnership(documentId, share.userId);
                        setDocument((current) => (current ? { ...current, ...handed } : handed));
                        setShares(null);
                      } catch (caught) {
                        setError(caught instanceof ApiError ? caught.message : 'Could not hand the document over.');
                      }
                    })();
                  }}
                >
                  Make owner
                </button>
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

      <div className={`editor-body${navOpen ? ' has-nav' : ''}`}>
        {navOpen ? <NavigationPane editor={view === 'document' ? editor : null} onClose={() => setNavOpen(false)} /> : null}
        <div className="editor-main">
          <nav className="view-tabs" aria-label="What is shown">
            {(
              [
                ['document', 'Document', 'The document as it stands, for editing', FileText],
                ['original', 'Original', 'The document as it was first created or uploaded', HistoryIcon],
                [
                  'redline',
                  'Redline',
                  'Everything that has changed since the original: removed text struck out, new text underlined',
                  GitCompareArrows,
                ],
              ] as const
            ).map(([name, label, hint, Icon]) => (
              <button
                key={name}
                type="button"
                title={hint}
                className={`view-tab${view === name ? ' is-active' : ''}`}
                aria-pressed={view === name}
                onClick={() => void show(name)}
              >
                <IconLabel icon={Icon} size={14}>
                  {label}
                </IconLabel>
              </button>
            ))}
            {view === 'redline' ? (
              <button
                type="button"
                className="link"
                title="Download this comparison as a Word file with revision marks that can be accepted or rejected in Word"
                onClick={() => void download('docx', { compare: '1' })}
              >
                <IconLabel icon={FileDown} size={14}>
                  Export redline to Word
                </IconLabel>
              </button>
            ) : null}
            {view === 'document' ? (
              <button
                type="button"
                className="link"
                title="Download the document with every tracked change accepted"
                onClick={() => void download('docx', { changes: 'accepted' })}
              >
                <IconLabel icon={FileDown} size={14}>
                  Export with changes accepted
                </IconLabel>
              </button>
            ) : null}
          </nav>
          <div className={`editor-with-side${side ? ' has-side' : ''} view-${view}`}>
          {epoch !== undefined && !sharedFailed && !live && view === 'document' ? (
            <p className="muted page-wrap">Joining the document…</p>
          ) : (
          <DocumentEditor
            key={`${surface}-${live && view === 'document' ? 'shared' : 'own'}`}
            shared={live && view === 'document' && session ? session : undefined}
            onReady={setEditor}
            initialContent={view === 'document' || !shown ? document.content : shown}
            header={document.pageSetup?.header ?? ''}
            footer={document.pageSetup?.footer ?? ''}
            styles={document.styles ?? null}
            readOnly={(readOnly ?? false) || view !== 'document'}
            onDirty={() => {
              if (live) {
                // Sent as it is typed and stored by the server. There is no reply
                // to wait for, so "saved" is shown once the line has gone quiet.
                setSaveState((current) => (current === 'offline' ? current : 'saving'));
                if (settle.current) clearTimeout(settle.current);
                settle.current = setTimeout(
                  () => setSaveState((current) => (current === 'saving' ? 'saved' : current)),
                  1200,
                );
                return;
              }
              typedSinceQueued.current = true;
              setSaveState((current) => (current === 'conflict' ? current : 'dirty'));
            }}
            onChange={(content) => void persist({ content })}
            onRepair={(when) => {
              // Set, not appended: the same repair happens on every save, and
              // saying it again after every keystroke made a permanent banner
              // pointing at nothing anybody could act on.
              const message =
                when === 'open'
                  ? 'Part of this document could not be opened and has been left out. Everything else is here, and saving stores what you can see.'
                  : 'Part of what you pasted could not be stored and has been left out.';
              setNotice((current) => (current === message ? current : message));
            }}
          />
          )}
          {side === 'review' ? (
            <ReviewPanel
              editor={editor}
              readOnly={(readOnly ?? false) || view !== 'document'}
              tracking={tracking}
              onTracking={changeTracking}
              onClose={() => setSide(null)}
            />
          ) : null}
          {commentsOpen ? (
            <CommentsPanel
              documentId={documentId}
              editor={editor}
              onClose={() => setCommentsOpen(false)}
              onCount={setOpenComments}
            />
          ) : null}
          {side === 'chat' ? <ChatPanel onClose={() => setSide(null)} /> : null}
          {side === 'analysis' ? <AnalysisPanel onClose={() => setSide(null)} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
