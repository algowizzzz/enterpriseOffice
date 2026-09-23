import { useCallback, useEffect, useState, type JSX } from 'react';
import { SessionProvider, useSession } from './lib/session';
import { SignInPage } from './pages/SignInPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { EditorPage } from './pages/EditorPage';
import { AdminPage } from './pages/AdminPage';
import { getTheme, getUiScale, setTheme, setUiScale, type Theme } from './lib/preferences';
import { ALargeSmall, FileEdit, Moon, Sun } from 'lucide-react';

const TEXT_SIZES = [90, 100, 110, 125, 140] as const;

/** Dark mode and text size: on every page, never only the editor's own zoom. */
function DisplayPreferences(): JSX.Element {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const [scale, setScaleState] = useState<number>(getUiScale);

  // `main.tsx` applies the stored choice before the first render, so the
  // interface never flashes the wrong theme. This is the safety net for
  // anywhere that does not go through that entry point (a test rendering
  // `<App />` directly, primarily), so the attribute on the page always
  // agrees with what this control shows.
  useEffect(() => {
    setTheme(theme);
    setUiScale(scale);
    // Applied once, from whatever was already current on mount. Reacting to
    // `theme`/`scale` here too would just re-run the same idempotent write
    // on every change, which the button and the select already do themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <label className="visually-hidden" htmlFor="ui-text-size">
        Text size
      </label>
      <span className="text-size-control" title="Text size, everywhere but the document itself">
        <ALargeSmall size={15} aria-hidden="true" />
        <select
          id="ui-text-size"
          value={scale}
          onChange={(event) => {
            const next = Number(event.target.value);
            setUiScale(next);
            setScaleState(next);
          }}
        >
          {TEXT_SIZES.map((value) => (
            <option key={value} value={value}>
              {value}%
            </option>
          ))}
        </select>
      </span>
      <button
        type="button"
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        // The name stays constant; aria-pressed says which state it is in
        // now, the way a toggle button should, rather than the name itself
        // changing to describe the current state.
        aria-pressed={theme === 'dark'}
        onClick={() => {
          const next: Theme = theme === 'dark' ? 'light' : 'dark';
          setTheme(next);
          setThemeState(next);
        }}
      >
        {theme === 'dark' ? <Moon size={15} aria-hidden="true" /> : <Sun size={15} aria-hidden="true" />}
        <span className="visually-hidden">Dark mode</span>
      </button>
    </>
  );
}

type View = { name: 'documents' } | { name: 'editor'; id: string } | { name: 'admin' };

/** Read the current view from the URL path, so reload and the back button work. */
function viewFromLocation(): View {
  // Match the shape the server accepts. A looser pattern sent anything
  // thirty-six characters long to the API, which answered with a validation
  // error about a request body the person never sent.
  const match =
    /^\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.exec(
      window.location.pathname,
    );
  if (match?.[1]) return { name: 'editor', id: match[1] };
  if (window.location.pathname === '/admin') return { name: 'admin' };
  return { name: 'documents' };
}

function pathFor(view: View): string {
  if (view.name === 'editor') return `/documents/${view.id}`;
  if (view.name === 'admin') return '/admin';
  return '/';
}

function Shell(): JSX.Element {
  const { user, loading, signOut } = useSession();
  const [view, setView] = useState<View>(viewFromLocation);

  const navigate = useCallback((next: View) => {
    window.history.pushState({}, '', pathFor(next));
    setView(next);
  }, []);

  useEffect(() => {
    const onPop = (): void => setView(viewFromLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (loading) {
    return (
      <div className="centred-panel">
        <p className="muted">Loading DocForge…</p>
      </div>
    );
  }

  if (!user) return <SignInPage />;

  return (
    <div className="app">
      <nav className="app-nav">
        <button type="button" className="brand" onClick={() => navigate({ name: 'documents' })}>
          <span className="brand-mark" aria-hidden="true">
            <FileEdit size={15} />
          </span>
          DocForge
        </button>
        <div className="nav-links">
          <button
            type="button"
            className={view.name === 'documents' || view.name === 'editor' ? 'active' : ''}
            onClick={() => navigate({ name: 'documents' })}
          >
            Documents
          </button>
          {user.role === 'admin' ? (
            <button
              type="button"
              className={view.name === 'admin' ? 'active' : ''}
              onClick={() => navigate({ name: 'admin' })}
            >
              Administration
            </button>
          ) : null}
        </div>
        <div className="nav-user">
          <DisplayPreferences />
          <span title={user.email}>{user.name}</span>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </nav>

      <main>
        {view.name === 'documents' ? (
          <DocumentsPage onOpen={(id) => navigate({ name: 'editor', id })} />
        ) : view.name === 'editor' ? (
          <EditorPage documentId={view.id} onBack={() => navigate({ name: 'documents' })} />
        ) : (
          <AdminPage />
        )}
      </main>
    </div>
  );
}

export function App(): JSX.Element {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}
