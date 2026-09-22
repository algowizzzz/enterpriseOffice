import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import type { User } from '../src/lib/api';
import { ApiError } from '../src/lib/api';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    api: {
      me: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      register: vi.fn(),
      bootstrapStatus: vi.fn(),
      listDocuments: vi.fn().mockResolvedValue({ documents: [] }),
      listUsers: vi.fn().mockResolvedValue({ users: [] }),
      listAudit: vi.fn().mockResolvedValue({ entries: [] }),
      listWorkflowGroups: vi.fn().mockResolvedValue({ groups: [] }),
      createDocument: vi.fn(),
      getDocument: vi.fn(),
      exportUrl: actual.api.exportUrl,
    },
    downloadExport: vi.fn(),
  };
});

const { api } = await import('../src/lib/api');
const { SessionProvider, useSession } = await import('../src/lib/session');
const { App } = await import('../src/App');

// Naming the keys keeps indexing type-safe under noUncheckedIndexedAccess.
type MockedApi = { [K in keyof typeof api]: ReturnType<typeof vi.fn> };
const mocked = api as unknown as MockedApi;

const ADMIN: User = { id: 'u-admin', email: 'admin@localhost', name: 'Ada Admin', role: 'admin' };
const EDITOR: User = { id: 'u-ed', email: 'ed@localhost', name: 'Eddie Editor', role: 'editor' };

function Probe(): JSX.Element {
  const { user, loading, needsSetup, signIn, signOut } = useSession();
  return (
    <div>
      <span data-testid="state">
        {loading ? 'loading' : user ? `signed-in:${user.email}` : needsSetup ? 'needs-setup' : 'signed-out'}
      </span>
      <button type="button" onClick={() => void signIn('ed@localhost', 'pw')}>
        do sign in
      </button>
      <button type="button" onClick={() => void signOut()}>
        do sign out
      </button>
    </div>
  );
}

beforeEach(() => {
  for (const fn of Object.values(mocked)) {
    if (typeof fn?.mockReset === 'function') fn.mockReset();
  }
  mocked['listDocuments'].mockResolvedValue({ documents: [] });
  mocked['listUsers'].mockResolvedValue({ users: [] });
  mocked['listAudit'].mockResolvedValue({ entries: [] });
  window.history.pushState({}, '', '/');
});

describe('session provider', () => {
  it('asks the server who is signed in as soon as it mounts', async () => {
    mocked['me'].mockResolvedValue({ user: EDITOR });
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('signed-in:ed@localhost'),
    );
  });

  it('reports a signed-out visitor on an instance that already has accounts', async () => {
    mocked['me'].mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no'));
    mocked['bootstrapStatus'].mockResolvedValue({ needsSetup: false });
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-out'));
  });

  it('reports that a brand-new instance needs setting up', async () => {
    mocked['me'].mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no'));
    mocked['bootstrapStatus'].mockResolvedValue({ needsSetup: true });
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('needs-setup'));
  });

  it('does not ask about setup when the failure was not an authentication one', async () => {
    mocked['me'].mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'boom'));
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-out'));
    expect(mocked['bootstrapStatus']).not.toHaveBeenCalled();
  });

  it('survives the setup check itself failing', async () => {
    mocked['me'].mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no'));
    mocked['bootstrapStatus'].mockRejectedValue(new ApiError(0, 'NETWORK', 'offline'));
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-out'));
  });

  it('records the person after a successful sign in', async () => {
    mocked['me'].mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no'));
    mocked['bootstrapStatus'].mockResolvedValue({ needsSetup: false });
    mocked['login'].mockResolvedValue({ user: EDITOR });
    const user = userEvent.setup();

    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-out'));
    await user.click(screen.getByRole('button', { name: 'do sign in' }));
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('signed-in:ed@localhost'),
    );
  });

  it('forgets the person after signing out', async () => {
    mocked['me'].mockResolvedValueOnce({ user: EDITOR });
    mocked['logout'].mockResolvedValue({ ok: true });
    mocked['bootstrapStatus'].mockResolvedValue({ needsSetup: false });
    const user = userEvent.setup();

    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('signed-in:ed@localhost'),
    );

    mocked['me'].mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no'));
    await user.click(screen.getByRole('button', { name: 'do sign out' }));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-out'));
  });

  it('forgets the person even if the sign-out request fails', async () => {
    // Otherwise a network blip would leave the page looking signed in.
    mocked['me'].mockResolvedValueOnce({ user: EDITOR });
    mocked['logout'].mockRejectedValue(new ApiError(0, 'NETWORK', 'offline'));
    mocked['bootstrapStatus'].mockResolvedValue({ needsSetup: false });
    const user = userEvent.setup();

    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('signed-in:ed@localhost'),
    );

    mocked['me'].mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no'));
    await user.click(screen.getByRole('button', { name: 'do sign out' }));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-out'));
  });

  it('never lets a failed sign out escape as an unhandled rejection', async () => {
    // The sign-out button discards the promise, so anything thrown here would
    // surface as an unhandled rejection rather than as a message to the user.
    mocked['me'].mockResolvedValueOnce({ user: EDITOR });
    mocked['logout'].mockRejectedValue(new ApiError(0, 'NETWORK', 'offline'));
    mocked['bootstrapStatus'].mockResolvedValue({ needsSetup: false });

    let captured: unknown;
    function Catcher(): JSX.Element {
      const { signOut } = useSession();
      return (
        <button type="button" onClick={() => { captured = signOut(); }}>
          try sign out
        </button>
      );
    }

    const user = userEvent.setup();
    render(
      <SessionProvider>
        <Catcher />
      </SessionProvider>,
    );
    mocked['me'].mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no'));
    await user.click(screen.getByRole('button', { name: 'try sign out' }));
    await expect(captured).resolves.toBeUndefined();
  });

  it('refuses to be used outside a provider, rather than failing later', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/must be used inside a SessionProvider/u);
    quiet.mockRestore();
  });
});

describe('application shell', () => {
  it('shows the sign-in page when nobody is signed in', async () => {
    mocked['me'].mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no'));
    mocked['bootstrapStatus'].mockResolvedValue({ needsSetup: false });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows the documents page to a signed-in person', async () => {
    mocked['me'].mockResolvedValue({ user: EDITOR });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Documents' })).toBeInTheDocument();
    expect(screen.getByText('Eddie Editor')).toBeInTheDocument();
  });

  it('offers administration only to an administrator', async () => {
    mocked['me'].mockResolvedValue({ user: EDITOR });
    const { unmount } = render(<App />);
    await screen.findByRole('heading', { name: 'Documents' });
    expect(screen.queryByRole('button', { name: 'Administration' })).not.toBeInTheDocument();
    unmount();

    mocked['me'].mockResolvedValue({ user: ADMIN });
    render(<App />);
    await screen.findByRole('heading', { name: 'Documents' });
    expect(screen.getByRole('button', { name: 'Administration' })).toBeInTheDocument();
  });

  it('moves to administration and puts it in the address bar', async () => {
    mocked['me'].mockResolvedValue({ user: ADMIN });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Documents' });

    await user.click(screen.getByRole('button', { name: 'Administration' }));
    expect(await screen.findByRole('heading', { name: 'Administration' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/admin');
  });

  it('opens a document from the list and puts it in the address bar', async () => {
    mocked['me'].mockResolvedValue({ user: EDITOR });
    mocked['createDocument'].mockResolvedValue({
      document: { id: '11111111-1111-4111-8111-111111111111' },
    });
    mocked['getDocument'].mockResolvedValue({
      document: {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Fresh',
        ownerId: 'u-ed',
        ownerName: 'Eddie Editor',
        origin: 'blank',
        sourceName: null,
        wordCount: 0,
        revision: 1,
        createdAt: 'x',
        updatedAt: 'x',
        access: 'owner',
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Documents' });

    await user.click(screen.getByRole('button', { name: 'New blank document' }));
    await waitFor(() => expect(screen.getByLabelText('Document title')).toHaveValue('Fresh'));
    expect(window.location.pathname).toBe('/documents/11111111-1111-4111-8111-111111111111');
  });

  it('opens the editor directly when the address names a document', async () => {
    window.history.pushState({}, '', '/documents/22222222-2222-4222-8222-222222222222');
    mocked['me'].mockResolvedValue({ user: EDITOR });
    mocked['getDocument'].mockResolvedValue({
      document: {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Deep linked',
        ownerId: 'u-ed',
        ownerName: 'Eddie Editor',
        origin: 'blank',
        sourceName: null,
        wordCount: 0,
        revision: 1,
        createdAt: 'x',
        updatedAt: 'x',
        access: 'owner',
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
      },
    });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('Document title')).toHaveValue('Deep linked'));
  });

  it('treats an address it does not recognise as the document list', async () => {
    window.history.pushState({}, '', '/something/else');
    mocked['me'].mockResolvedValue({ user: EDITOR });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Documents' })).toBeInTheDocument();
  });

  it('follows the browser back button', async () => {
    mocked['me'].mockResolvedValue({ user: ADMIN });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Documents' });

    await user.click(screen.getByRole('button', { name: 'Administration' }));
    await screen.findByRole('heading', { name: 'Administration' });

    window.history.back();
    // jsdom fires popstate asynchronously.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Documents' })).toBeInTheDocument());
  });

  it('signs out from the navigation bar', async () => {
    mocked['me'].mockResolvedValueOnce({ user: EDITOR });
    mocked['logout'].mockResolvedValue({ ok: true });
    mocked['bootstrapStatus'].mockResolvedValue({ needsSetup: false });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Documents' });

    mocked['me'].mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no'));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('returns to the document list from the brand', async () => {
    mocked['me'].mockResolvedValue({ user: ADMIN });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Documents' });
    await user.click(screen.getByRole('button', { name: 'Administration' }));
    await screen.findByRole('heading', { name: 'Administration' });

    await user.click(screen.getByRole('button', { name: 'DocForge' }));
    expect(await screen.findByRole('heading', { name: 'Documents' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });
});
