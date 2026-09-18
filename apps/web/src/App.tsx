import { useCallback, useEffect, useState, type JSX } from 'react';
import { SessionProvider, useSession } from './lib/session';
import { SignInPage } from './pages/SignInPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { EditorPage } from './pages/EditorPage';
import { AdminPage } from './pages/AdminPage';

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
