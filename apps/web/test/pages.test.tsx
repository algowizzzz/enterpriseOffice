import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DocumentDetail, DocumentSummary, User } from '../src/lib/api';
import { ApiError } from '../src/lib/api';

// Every page talks to the server only through this module, so replacing it
// exercises the pages without a network and without a live server.
vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    api: {
      health: vi.fn(),
      bootstrapStatus: vi.fn(),
      register: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      me: vi.fn(),
      changePassword: vi.fn(),
      listUsers: vi.fn(),
      createUser: vi.fn(),
      updateUser: vi.fn(),
      resetUserPassword: vi.fn(),
      listAudit: vi.fn(),
      listWorkflowGroups: vi.fn(),
      createWorkflowGroup: vi.fn(),
      updateWorkflowGroup: vi.fn(),
      deleteWorkflowGroup: vi.fn(),
      addWorkflowGroupPrompt: vi.fn(),
      updateWorkflowGroupPrompt: vi.fn(),
      deleteWorkflowGroupPrompt: vi.fn(),
      reorderWorkflowGroupPrompts: vi.fn(),
      listWorkflowGroupsForDocument: vi.fn(),
      listLlmEndpoints: vi.fn(),
      createLlmEndpoint: vi.fn(),
      updateLlmEndpoint: vi.fn(),
      deleteLlmEndpoint: vi.fn(),
      testLlmEndpoint: vi.fn(),
      getChatSettings: vi.fn(),
      setChatSettings: vi.fn(),
      sendChatMessage: vi.fn(),
      runAnalysis: vi.fn(),
      getExportTemplate: vi.fn(),
      updateExportTemplate: vi.fn(),
      listDocuments: vi.fn(),
      createDocument: vi.fn(),
      getDocument: vi.fn(),
      saveDocument: vi.fn(),
      deleteDocument: vi.fn(),
      importDocx: vi.fn(),
      listVersions: vi.fn(),
      restoreVersion: vi.fn(),
      listShares: vi.fn(),
      share: vi.fn(),
      unshare: vi.fn(),
      transferOwnership: vi.fn(),
      exportUrl: actual.api.exportUrl,
    },
    downloadExport: vi.fn(),
  };
});

const { api, downloadExport } = await import('../src/lib/api');
const { SignInPage } = await import('../src/pages/SignInPage');
const { DocumentsPage } = await import('../src/pages/DocumentsPage');
const { EditorPage } = await import('../src/pages/EditorPage');
const { AdminPage } = await import('../src/pages/AdminPage');
const { SessionProvider } = await import('../src/lib/session');

// Naming the keys keeps indexing type-safe under noUncheckedIndexedAccess.
type MockedApi = { [K in keyof typeof api]: ReturnType<typeof vi.fn> };
const mocked = api as unknown as MockedApi;

const ADMIN: User = { id: 'u-admin', email: 'admin@localhost', name: 'Ada Admin', role: 'admin' };
const EDITOR: User = { id: 'u-ed', email: 'ed@localhost', name: 'Eddie Editor', role: 'editor' };
const VIEWER: User = { id: 'u-vw', email: 'vw@localhost', name: 'Vera Viewer', role: 'viewer' };

const exportTemplateFixture = () => {
  const side = (content = '') => ({ content, fontFamily: 'Carlito', fontSize: 10, color: '#000000', bold: false, italic: false });
  const heading = (fontSize: number) => ({
    fontFamily: 'Carlito',
    fontSize,
    color: '#4472C4',
    bold: true,
    italic: false,
    spacingBeforePt: 12,
    spacingAfterPt: 6,
  });
  return {
    header: { left: side(), right: side() },
    footer: { left: side(), right: side('{{page}} of {{pageCount}}') },
    headings: [heading(20), heading(16), heading(14), heading(12), heading(11), heading(11)],
    body: { fontFamily: 'Carlito', fontSize: 11, color: '#000000' },
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: null,
  };
};

const summary = (over: Partial<DocumentSummary> = {}): DocumentSummary => ({
  id: 'doc-1',
  title: 'Quarterly Report',
  ownerId: 'u-ed',
  ownerName: 'Eddie Editor',
  origin: 'blank',
  sourceName: null,
  wordCount: 42,
  revision: 3,
  createdAt: '2026-01-01T09:00:00.000Z',
  updatedAt: '2026-01-02T10:30:00.000Z',
  access: 'owner',
  ...over,
});

const detail = (over: Partial<DocumentDetail> = {}): DocumentDetail => ({
  ...summary(),
  content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] },
  pageSetup: { header: '', footer: '', orientation: 'portrait' },
  ...over,
});

/** Every per-document action on the list lives behind its own "⋯" menu. */
async function openRowMenu(user: ReturnType<typeof userEvent.setup>, title: string): Promise<void> {
  await user.click(await screen.findByRole('button', { name: `Actions for ${title}` }));
}

/** The restore control belonging to one revision in the history list. */
async function restoreButtonFor(revision: number): Promise<HTMLElement> {
  const label = await screen.findByText(new RegExp(`Revision ${revision} by`, 'u'));
  const row = label.closest('li');
  if (!row) throw new Error(`No history row for revision ${revision}`);
  return within(row).getByRole('button', { name: 'Restore' });
}

/** Render a page inside a session that is already signed in as `user`. */
async function renderSignedIn(ui: React.ReactElement, user: User = EDITOR) {
  mocked['me'].mockResolvedValue({ user });
  const result = render(<SessionProvider>{ui}</SessionProvider>);
  await waitFor(() => expect(mocked['me']).toHaveBeenCalled());
  return result;
}

beforeEach(() => {
  for (const fn of Object.values(mocked)) {
    if (typeof fn?.mockReset === 'function') fn.mockReset();
  }
  (downloadExport as unknown as ReturnType<typeof vi.fn>).mockReset();
  mocked['listUsers'].mockResolvedValue({ users: [] });
  mocked['listAudit'].mockResolvedValue({ entries: [] });
  mocked['listWorkflowGroups'].mockResolvedValue({ groups: [] });
  mocked['listLlmEndpoints'].mockResolvedValue({ endpoints: [] });
  mocked['getChatSettings'].mockResolvedValue({ endpointId: null });
  mocked['listWorkflowGroupsForDocument'].mockResolvedValue({ groups: [] });
  mocked['listDocuments'].mockResolvedValue({ documents: [] });
  mocked['getExportTemplate'].mockResolvedValue({ template: exportTemplateFixture() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sign in page', () => {
  it('asks for an email and a password', async () => {
    mocked['me'].mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no'));
    mocked['bootstrapStatus'].mockResolvedValue({ needsSetup: false });
    render(
      <SessionProvider>
        <SignInPage />
      </SessionProvider>,
    );
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();
  });

  it('signs in with what was typed', async () => {
    mocked['me'].mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no'));
    mocked['bootstrapStatus'].mockResolvedValue({ needsSetup: false });
    mocked['login'].mockResolvedValue({ user: EDITOR });
    const user = userEvent.setup();

    render(
      <SessionProvider>
        <SignInPage />
      </SessionProvider>,
    );
    await user.type(await screen.findByLabelText('Email'), 'ed@localhost');
    await user.type(screen.getByLabelText('Password'), 'Correct-Horse-9');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(mocked['login']).toHaveBeenCalledWith({
        email: 'ed@localhost',
        password: 'Correct-Horse-9',
      }),
    );
  });

  it('shows the reason a sign in failed', async () => {
    mocked['me'].mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no'));
    mocked['bootstrapStatus'].mockResolvedValue({ needsSetup: false });
    mocked['login'].mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'Email or password is incorrect'));
    const user = userEvent.setup();

    render(
      <SessionProvider>
        <SignInPage />
      </SessionProvider>,
    );
    await user.type(await screen.findByLabelText('Email'), 'ed@localhost');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect');
  });

  it('asks for a name and the password rules on a fresh instance', async () => {
    mocked['me'].mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no'));
    mocked['bootstrapStatus'].mockResolvedValue({ needsSetup: true });
    render(
      <SessionProvider>
        <SignInPage />
      </SessionProvider>,
    );
    expect(await screen.findByLabelText('Full name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create administrator' })).toBeInTheDocument();
    expect(screen.getByText(/At least 12 characters/u)).toBeInTheDocument();
  });

  it('creates the first administrator', async () => {
    mocked['me'].mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no'));
    mocked['bootstrapStatus'].mockResolvedValue({ needsSetup: true });
    mocked['register'].mockResolvedValue({ user: ADMIN });
    const user = userEvent.setup();

    render(
      <SessionProvider>
        <SignInPage />
      </SessionProvider>,
    );
    await user.type(await screen.findByLabelText('Full name'), 'Ada Admin');
    await user.type(screen.getByLabelText('Email'), 'admin@localhost');
    await user.type(screen.getByLabelText('Password'), 'Correct-Horse-9');
    await user.click(screen.getByRole('button', { name: 'Create administrator' }));

    await waitFor(() =>
      expect(mocked['register']).toHaveBeenCalledWith({
        email: 'admin@localhost',
        name: 'Ada Admin',
        password: 'Correct-Horse-9',
      }),
    );
  });
});

describe('documents page', () => {
  it('says so when there is nothing yet', async () => {
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);
    expect(await screen.findByText('You have no documents yet.')).toBeInTheDocument();
  });

  it('lists a document with its details', async () => {
    mocked['listDocuments'].mockResolvedValue({ documents: [summary()] });
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);

    const row = (await screen.findByRole('button', { name: 'Quarterly Report' })).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('42')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('You')).toBeInTheDocument();
  });

  it('names the owner when the document belongs to somebody else', async () => {
    mocked['listDocuments'].mockResolvedValue({
      documents: [summary({ ownerId: 'someone-else', ownerName: 'Olive Owner', access: 'view' })],
    });
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);
    expect(await screen.findByText('Olive Owner')).toBeInTheDocument();
  });

  it('marks an uploaded document as imported', async () => {
    mocked['listDocuments'].mockResolvedValue({
      documents: [summary({ origin: 'import', sourceName: 'Report.docx' })],
    });
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);
    expect(await screen.findByText('imported')).toBeInTheDocument();
  });

  it('opens a document when its title is clicked', async () => {
    mocked['listDocuments'].mockResolvedValue({ documents: [summary()] });
    const onOpen = vi.fn();
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={onOpen} />);
    await user.click(await screen.findByRole('button', { name: 'Quarterly Report' }));
    expect(onOpen).toHaveBeenCalledWith('doc-1');
  });

  it('creates a blank document and opens it', async () => {
    mocked['createDocument'].mockResolvedValue({ document: detail({ id: 'doc-new' }) });
    const onOpen = vi.fn();
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={onOpen} />);
    await user.click(await screen.findByRole('button', { name: 'New blank document' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('doc-new'));
  });

  it('reports why a document could not be created', async () => {
    mocked['createDocument'].mockRejectedValue(new ApiError(400, 'BAD_REQUEST', 'Your account cannot create documents'));
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'New blank document' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your account cannot create documents');
  });

  it('uploads a chosen file and opens the result', async () => {
    mocked['importDocx'].mockResolvedValue({ document: detail({ id: 'doc-up' }), messages: [] });
    const onOpen = vi.fn();
    const user = userEvent.setup();
    const { container } = await renderSignedIn(<DocumentsPage onOpen={onOpen} />);
    await screen.findByRole('button', { name: 'Upload Word or PDF' });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['bytes'], 'Report.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    await user.upload(input, file);

    await waitFor(() => expect(mocked['importDocx']).toHaveBeenCalledWith(file));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('doc-up'));
  });

  it('reports why an upload was refused', async () => {
    mocked['importDocx'].mockRejectedValue(
      new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only .docx files can be uploaded.'),
    );
    const user = userEvent.setup();
    const { container } = await renderSignedIn(<DocumentsPage onOpen={() => {}} />);
    await screen.findByRole('button', { name: 'Upload Word or PDF' });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(
      input,
      new File(['x'], 'notes.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Only .docx files can be uploaded.');
  });

  it('passes on what the converter warned about', async () => {
    mocked['importDocx'].mockResolvedValue({
      document: detail(),
      messages: ['An image larger than 2 MB was removed.'],
    });
    const user = userEvent.setup();
    const { container } = await renderSignedIn(<DocumentsPage onOpen={() => {}} />);
    await screen.findByRole('button', { name: 'Upload Word or PDF' });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'r.docx'));
    expect(await screen.findByText(/larger than 2 MB/u)).toBeInTheDocument();
  });

  it('downloads a document from the list', async () => {
    mocked['listDocuments'].mockResolvedValue({ documents: [summary()] });
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);
    await openRowMenu(user, 'Quarterly Report');
    await user.click(await screen.findByRole('menuitem', { name: 'Export .docx' }));
    expect(downloadExport).toHaveBeenCalledWith('doc-1', 'docx');
  });

  it('offers every export format, and the original when the document was imported', async () => {
    mocked['listDocuments'].mockResolvedValue({ documents: [summary({ origin: 'import', sourceName: 'Report.docx' })] });
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);
    await openRowMenu(user, 'Quarterly Report');
    await user.click(await screen.findByRole('menuitem', { name: 'Export .pdf' }));
    expect(downloadExport).toHaveBeenCalledWith('doc-1', 'pdf');

    await openRowMenu(user, 'Quarterly Report');
    await user.click(await screen.findByRole('menuitem', { name: 'Export .txt' }));
    expect(downloadExport).toHaveBeenCalledWith('doc-1', 'txt');

    await openRowMenu(user, 'Quarterly Report');
    await user.click(await screen.findByRole('menuitem', { name: 'Original' }));
    expect(downloadExport).toHaveBeenCalledWith('doc-1', 'original');
  });

  it('opens a document from its menu, the same as clicking the title', async () => {
    mocked['listDocuments'].mockResolvedValue({ documents: [summary()] });
    const onOpen = vi.fn();
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={onOpen} />);
    await openRowMenu(user, 'Quarterly Report');
    await user.click(await screen.findByRole('menuitem', { name: 'Open' }));
    expect(onOpen).toHaveBeenCalledWith('doc-1');
  });

  it('asks before deleting, and reloads afterwards', async () => {
    mocked['listDocuments'].mockResolvedValue({ documents: [summary()] });
    mocked['deleteDocument'].mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();

    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);
    await openRowMenu(user, 'Quarterly Report');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Quarterly Report'));
    await waitFor(() => expect(mocked['deleteDocument']).toHaveBeenCalledWith('doc-1'));
    expect(mocked['listDocuments']).toHaveBeenCalledTimes(2);
  });

  it('does not delete when the question is dismissed', async () => {
    mocked['listDocuments'].mockResolvedValue({ documents: [summary()] });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);
    await openRowMenu(user, 'Quarterly Report');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(mocked['deleteDocument']).not.toHaveBeenCalled();
  });

  it('offers no delete, manage access or transfer for a document somebody else owns', async () => {
    mocked['listDocuments'].mockResolvedValue({ documents: [summary({ access: 'edit' })] });
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);
    await openRowMenu(user, 'Quarterly Report');
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Manage access' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Transfer ownership' })).not.toBeInTheDocument();
  });

  it('tells a viewer that they cannot create documents, and disables the buttons', async () => {
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />, VIEWER);
    expect(await screen.findByText(/but not create them/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New blank document' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Upload Word or PDF' })).toBeDisabled();
  });

  it('reports a failure to load the list', async () => {
    mocked['listDocuments'].mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong.'));
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
  });

  it('manages access from the list, without opening the document', async () => {
    mocked['listDocuments'].mockResolvedValue({ documents: [summary()] });
    mocked['listShares'].mockResolvedValue({
      shares: [{ userId: 'u-other', email: 'other@localhost', name: 'Otto Other', permission: 'view' }],
    });
    mocked['listUsers'].mockResolvedValue({ users: [ADMIN] });
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);

    await openRowMenu(user, 'Quarterly Report');
    await user.click(await screen.findByRole('menuitem', { name: 'Manage access' }));
    expect(await screen.findByText('Sharing: Quarterly Report')).toBeInTheDocument();
    expect(screen.getByText(/Otto Other can view/u)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('Sharing: Quarterly Report')).not.toBeInTheDocument());
  });

  it('shares with the chosen person at the chosen permission, from the list', async () => {
    mocked['listDocuments'].mockResolvedValue({ documents: [summary()] });
    mocked['listShares'].mockResolvedValue({ shares: [] });
    mocked['listUsers'].mockResolvedValue({ users: [ADMIN] });
    mocked['share'].mockResolvedValue({
      shares: [{ userId: 'u-admin', email: 'admin@localhost', name: 'Ada Admin', permission: 'edit' }],
    });
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);

    await openRowMenu(user, 'Quarterly Report');
    await user.click(await screen.findByRole('menuitem', { name: 'Manage access' }));
    await user.selectOptions(await screen.findByLabelText('Person'), 'u-admin');
    await user.selectOptions(screen.getByLabelText('Permission'), 'edit');
    await user.click(screen.getByRole('button', { name: 'Share' }));

    await waitFor(() => expect(mocked['share']).toHaveBeenCalledWith('doc-1', 'u-admin', 'edit'));
  });

  it('removes a share from the list', async () => {
    mocked['listDocuments'].mockResolvedValue({ documents: [summary()] });
    mocked['listShares'].mockResolvedValue({
      shares: [{ userId: 'u-other', email: 'other@localhost', name: 'Otto Other', permission: 'view' }],
    });
    mocked['listUsers'].mockResolvedValue({ users: [] });
    mocked['unshare'].mockResolvedValue({ shares: [] });
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);

    await openRowMenu(user, 'Quarterly Report');
    await user.click(await screen.findByRole('menuitem', { name: 'Manage access' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mocked['unshare']).toHaveBeenCalledWith('doc-1', 'u-other'));
  });

  it('hands a document over from the sharing panel, once the question is confirmed', async () => {
    mocked['listDocuments'].mockResolvedValue({ documents: [summary()] });
    mocked['listShares'].mockResolvedValue({
      shares: [{ userId: 'u-other', email: 'other@localhost', name: 'Otto Other', permission: 'edit' }],
    });
    mocked['listUsers'].mockResolvedValue({ users: [] });
    mocked['transferOwnership'].mockResolvedValue({ document: detail({ ownerId: 'u-other' }) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);

    await openRowMenu(user, 'Quarterly Report');
    await user.click(await screen.findByRole('menuitem', { name: 'Manage access' }));
    await user.click(await screen.findByRole('button', { name: 'Make owner' }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Otto Other'));
    await waitFor(() => expect(mocked['transferOwnership']).toHaveBeenCalledWith('doc-1', 'u-other'));
    // Handing it over closes the panel and refreshes the list, the owner column included.
    await waitFor(() => expect(screen.queryByText('Sharing: Quarterly Report')).not.toBeInTheDocument());
  });

  it('transfers ownership directly, without opening the sharing panel', async () => {
    mocked['listDocuments'].mockResolvedValue({ documents: [summary()] });
    mocked['listUsers'].mockResolvedValue({ users: [ADMIN] });
    mocked['transferOwnership'].mockResolvedValue({ document: detail({ ownerId: 'u-admin' }) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);

    await openRowMenu(user, 'Quarterly Report');
    await user.click(await screen.findByRole('menuitem', { name: 'Transfer ownership' }));
    expect(await screen.findByText('Transfer ownership: Quarterly Report')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('New owner'), 'u-admin');
    await user.click(screen.getByRole('button', { name: 'Make owner' }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Ada Admin'));
    await waitFor(() => expect(mocked['transferOwnership']).toHaveBeenCalledWith('doc-1', 'u-admin'));
  });

  it('opens analysis from the list, offering the workflow groups set up for that document', async () => {
    mocked['listDocuments'].mockResolvedValue({ documents: [summary()] });
    mocked['listWorkflowGroupsForDocument'].mockResolvedValue({
      groups: [{ id: 'g1', name: 'Policy prompts', description: '' }],
    });
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);

    await openRowMenu(user, 'Quarterly Report');
    await user.click(await screen.findByRole('menuitem', { name: 'Run analysis' }));
    expect(await screen.findByText('Document analysis')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run analysis' })).toBeEnabled();
    expect(mocked['listWorkflowGroupsForDocument']).toHaveBeenCalledWith('doc-1');
  });

  it('says so when no workflow group applies to a document opened from the list', async () => {
    mocked['listDocuments'].mockResolvedValue({ documents: [summary()] });
    mocked['listWorkflowGroupsForDocument'].mockResolvedValue({ groups: [] });
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);

    await openRowMenu(user, 'Quarterly Report');
    await user.click(await screen.findByRole('menuitem', { name: 'Run analysis' }));
    expect(await screen.findByText(/no workflow group is set up/i)).toBeInTheDocument();
  });

  it('opens a chat preview from the list, the same as the editor offers', async () => {
    mocked['listDocuments'].mockResolvedValue({ documents: [summary()] });
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);

    await openRowMenu(user, 'Quarterly Report');
    await user.click(await screen.findByRole('menuitem', { name: 'Chat' }));
    expect(await screen.findByText('Ask a question about this document.')).toBeInTheDocument();
  });

  it('searches the list by title', async () => {
    mocked['listDocuments'].mockResolvedValue({
      documents: [summary(), summary({ id: 'doc-2', title: 'Vendor Contract' })],
    });
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);
    await screen.findByText('Vendor Contract');

    await user.type(screen.getByLabelText('Search documents'), 'quarter');
    expect(screen.getByText('Quarterly Report')).toBeInTheDocument();
    expect(screen.queryByText('Vendor Contract')).not.toBeInTheDocument();
  });

  it('says so, and offers to clear it, when a search matches nothing', async () => {
    mocked['listDocuments'].mockResolvedValue({ documents: [summary()] });
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);
    await screen.findByText('Quarterly Report');

    await user.type(screen.getByLabelText('Search documents'), 'nothing matches this');
    expect(await screen.findByText('No documents match that search.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear the search' }));
    expect(await screen.findByText('Quarterly Report')).toBeInTheDocument();
  });

  it('filters the list by access from the tabs', async () => {
    mocked['listDocuments'].mockResolvedValue({
      documents: [summary(), summary({ id: 'doc-2', title: 'Shared With Me', access: 'view' })],
    });
    const user = userEvent.setup();
    await renderSignedIn(<DocumentsPage onOpen={() => {}} />);
    await screen.findByText('Shared With Me');

    await user.click(screen.getByRole('button', { name: 'Owned by me' }));
    expect(screen.getByText('Quarterly Report')).toBeInTheDocument();
    expect(screen.queryByText('Shared With Me')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Can view' }));
    expect(await screen.findByText('Shared With Me')).toBeInTheDocument();
    expect(screen.queryByText('Quarterly Report')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(await screen.findByText('Quarterly Report')).toBeInTheDocument();
    expect(screen.getByText('Shared With Me')).toBeInTheDocument();
  });
});

describe('administration page', () => {
  it('lists accounts with their role and last sign-in', async () => {
    mocked['listUsers'].mockResolvedValue({
      users: [
        { ...ADMIN, status: 'active', lastLoginAt: '2026-01-02T08:00:00.000Z' },
        { ...EDITOR, status: 'disabled', lastLoginAt: null },
      ],
    });
    await renderSignedIn(<AdminPage />, ADMIN);

    expect(await screen.findByText('admin@localhost')).toBeInTheDocument();
    expect(screen.getByText('Never signed in')).toBeInTheDocument();
    expect(screen.getByLabelText('Role for ed@localhost')).toHaveValue('editor');
  });

  it('creates an account from the form', async () => {
    mocked['createUser'].mockResolvedValue({ user: EDITOR });
    const user = userEvent.setup();
    await renderSignedIn(<AdminPage />, ADMIN);

    await user.type(await screen.findByLabelText('Name'), 'New Person');
    await user.type(screen.getByLabelText('Email'), 'new@localhost');
    await user.type(screen.getByLabelText('Password'), 'Correct-Horse-9');
    await user.selectOptions(screen.getByLabelText('Role'), 'viewer');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(mocked['createUser']).toHaveBeenCalledWith({
        name: 'New Person',
        email: 'new@localhost',
        password: 'Correct-Horse-9',
        role: 'viewer',
      }),
    );
    expect(await screen.findByText('Account created.')).toBeInTheDocument();
  });

  it('reports why an account could not be created', async () => {
    mocked['createUser'].mockRejectedValue(
      new ApiError(409, 'CONFLICT', 'An account with that email already exists'),
    );
    const user = userEvent.setup();
    await renderSignedIn(<AdminPage />, ADMIN);
    await user.type(await screen.findByLabelText('Name'), 'Dup');
    await user.type(screen.getByLabelText('Email'), 'dup@localhost');
    await user.type(screen.getByLabelText('Password'), 'Correct-Horse-9');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
  });

  it('changes a role', async () => {
    mocked['listUsers'].mockResolvedValue({ users: [{ ...EDITOR, status: 'active' }] });
    mocked['updateUser'].mockResolvedValue({ user: { ...EDITOR, role: 'admin' } });
    const user = userEvent.setup();
    await renderSignedIn(<AdminPage />, ADMIN);
    await user.selectOptions(await screen.findByLabelText('Role for ed@localhost'), 'admin');
    await waitFor(() => expect(mocked['updateUser']).toHaveBeenCalledWith('u-ed', { role: 'admin' }));
  });

  it('refuses to remove the last administrator, and says why', async () => {
    mocked['listUsers'].mockResolvedValue({ users: [{ ...ADMIN, status: 'active' }] });
    mocked['updateUser'].mockRejectedValue(
      new ApiError(409, 'CONFLICT', 'This is the last active administrator. Promote someone else first.'),
    );
    const user = userEvent.setup();
    await renderSignedIn(<AdminPage />, ADMIN);
    await user.selectOptions(await screen.findByLabelText('Role for admin@localhost'), 'editor');
    expect(await screen.findByRole('alert')).toHaveTextContent('last active administrator');
  });

  it('disables and re-enables an account', async () => {
    mocked['listUsers']
      .mockResolvedValueOnce({ users: [{ ...EDITOR, status: 'active' }] })
      .mockResolvedValue({ users: [{ ...EDITOR, status: 'disabled' }] });
    mocked['updateUser'].mockResolvedValue({ user: { ...EDITOR, status: 'disabled' } });
    const user = userEvent.setup();
    await renderSignedIn(<AdminPage />, ADMIN);
    await user.click(await screen.findByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(mocked['updateUser']).toHaveBeenCalledWith('u-ed', { status: 'disabled' }));

    const enable = await screen.findByRole('button', { name: 'Enable' });
    await user.click(enable);
    await waitFor(() => expect(mocked['updateUser']).toHaveBeenCalledWith('u-ed', { status: 'active' }));
  });

  it('offers no way to disable your own account', async () => {
    mocked['listUsers'].mockResolvedValue({ users: [{ ...ADMIN, status: 'active' }] });
    await renderSignedIn(<AdminPage />, ADMIN);
    await screen.findByText('admin@localhost');
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
  });

  it('resets a password and says the other sessions were ended', async () => {
    mocked['listUsers'].mockResolvedValue({ users: [{ ...EDITOR, status: 'active' }] });
    mocked['resetUserPassword'].mockResolvedValue({ ok: true });
    vi.spyOn(window, 'prompt').mockReturnValue('Brand-New-Pass-7');
    const user = userEvent.setup();
    await renderSignedIn(<AdminPage />, ADMIN);
    await user.click(await screen.findByRole('button', { name: 'Reset password' }));
    await waitFor(() =>
      expect(mocked['resetUserPassword']).toHaveBeenCalledWith('u-ed', 'Brand-New-Pass-7'),
    );
    expect(await screen.findByText(/signed out/u)).toBeInTheDocument();
  });

  it('does nothing when the password prompt is dismissed', async () => {
    mocked['listUsers'].mockResolvedValue({ users: [{ ...EDITOR, status: 'active' }] });
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    const user = userEvent.setup();
    await renderSignedIn(<AdminPage />, ADMIN);
    await user.click(await screen.findByRole('button', { name: 'Reset password' }));
    expect(mocked['resetUserPassword']).not.toHaveBeenCalled();
  });

  it('shows the audit trail', async () => {
    mocked['listAudit'].mockResolvedValue({
      entries: [
        {
          id: 'a1',
          createdAt: '2026-01-02T10:00:00.000Z',
          actorEmail: 'admin@localhost',
          action: 'document.created',
          targetType: 'document',
          targetId: 'doc-1',
          detail: null,
        },
      ],
    });
    await renderSignedIn(<AdminPage />, ADMIN);
    expect(await screen.findByText('document.created')).toBeInTheDocument();
    expect(screen.getByText('doc-1')).toBeInTheDocument();
  });

  it('labels an entry with no signed-in actor', async () => {
    mocked['listAudit'].mockResolvedValue({
      entries: [
        {
          id: 'a1',
          createdAt: '2026-01-02T10:00:00.000Z',
          actorEmail: null,
          action: 'user.login_failed',
          targetType: null,
          targetId: null,
          detail: null,
        },
      ],
    });
    await renderSignedIn(<AdminPage />, ADMIN);
    expect(await screen.findByText('anonymous')).toBeInTheDocument();
  });

  it('says so when there are no workflow groups yet', async () => {
    await renderSignedIn(<AdminPage />, ADMIN);
    expect(await screen.findByText('No workflow groups yet.')).toBeInTheDocument();
  });

  const policyGroup = {
    id: 'g1',
    name: 'Policy prompts',
    description: 'Checked against the template.',
    docType: 'Policy',
    isDefault: true,
    endpointId: null,
    prompts: [
      { id: 'p-summary', role: 'summary', position: 0, text: 'Summarise the findings above.' },
      { id: 'p1', role: 'analysis', position: 0, text: 'Does it name an owner?' },
      { id: 'p2', role: 'analysis', position: 1, text: 'Is the review date within a year?' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'u-admin',
  };

  it('lists a workflow group with its document type, default badge and prompt count', async () => {
    mocked['listWorkflowGroups'].mockResolvedValue({ groups: [policyGroup] });
    await renderSignedIn(<AdminPage />, ADMIN);
    expect(await screen.findByText('Policy prompts')).toBeInTheDocument();
    expect(screen.getByText('Checked against the template.')).toBeInTheDocument();
    // "Policy" also names an option in the document-type select above the
    // table, so the row itself is what everything else here is checked against.
    const row = screen.getByText('Policy prompts').closest('tr');
    expect(row).not.toBeNull();
    const withinRow = within(row as HTMLElement);
    expect(withinRow.getByText('Policy')).toBeInTheDocument();
    expect(withinRow.getByText('Yes')).toBeInTheDocument();
    // Two analysis prompts, shown as a count; the summary prompt is not counted here.
    expect(withinRow.getByRole('cell', { name: '2' })).toBeInTheDocument();
  });

  it('shows a group’s prompts, summary pinned first, once "Manage prompts" is opened', async () => {
    mocked['listWorkflowGroups'].mockResolvedValue({ groups: [policyGroup] });
    const user = userEvent.setup();
    await renderSignedIn(<AdminPage />, ADMIN);
    await user.click(await screen.findByRole('button', { name: 'Manage prompts' }));
    expect(screen.getByText('Summarise the findings above.')).toBeInTheDocument();
    expect(screen.getByText('Does it name an owner?')).toBeInTheDocument();
    expect(screen.getByText('Is the review date within a year?')).toBeInTheDocument();
  });

  it('creates a workflow group from one analysis prompt per line and a summary prompt', async () => {
    mocked['createWorkflowGroup'].mockResolvedValue({
      group: {
        ...policyGroup,
        id: 'g2',
        name: 'Standard prompts',
        description: '',
        docType: 'Standard',
        isDefault: false,
      },
    });
    const user = userEvent.setup();
    await renderSignedIn(<AdminPage />, ADMIN);

    await user.type(await screen.findByLabelText('Group name'), 'Standard prompts');
    await user.selectOptions(screen.getByLabelText('Document type'), 'Standard');
    await user.type(screen.getByLabelText('Analysis prompts, one per line'), 'First prompt.\nSecond prompt.');
    await user.type(screen.getByLabelText('Summary prompt'), 'A short list of gaps.');
    await user.click(screen.getByRole('button', { name: 'Add group' }));

    await waitFor(() =>
      expect(mocked['createWorkflowGroup']).toHaveBeenCalledWith({
        name: 'Standard prompts',
        description: '',
        docType: 'Standard',
        isDefault: false,
        endpointId: null,
        analysisPrompts: ['First prompt.', 'Second prompt.'],
        summaryPrompt: 'A short list of gaps.',
      }),
    );
  });

  it('adds, edits and deletes an analysis prompt on an existing group', async () => {
    mocked['listWorkflowGroups'].mockResolvedValue({ groups: [policyGroup] });
    mocked['addWorkflowGroupPrompt'].mockResolvedValue({ group: policyGroup });
    mocked['updateWorkflowGroupPrompt'].mockResolvedValue({ group: policyGroup });
    mocked['deleteWorkflowGroupPrompt'].mockResolvedValue({ group: policyGroup });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    await renderSignedIn(<AdminPage />, ADMIN);
    await user.click(await screen.findByRole('button', { name: 'Manage prompts' }));

    await user.type(screen.getByLabelText('New analysis prompt'), 'A third prompt.');
    await user.click(screen.getByRole('button', { name: 'Add prompt' }));
    await waitFor(() =>
      expect(mocked['addWorkflowGroupPrompt']).toHaveBeenCalledWith('g1', {
        role: 'analysis',
        text: 'A third prompt.',
      }),
    );

    const firstPromptRow = screen.getByText('Does it name an owner?').closest('li') as HTMLElement;
    await user.click(within(firstPromptRow).getByRole('button', { name: 'Edit' }));
    const textarea = within(firstPromptRow).getByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'Edited prompt text.');
    await user.click(within(firstPromptRow).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocked['updateWorkflowGroupPrompt']).toHaveBeenCalledWith('g1', 'p1', 'Edited prompt text.'),
    );

    const secondPromptRow = screen.getByText('Is the review date within a year?').closest('li') as HTMLElement;
    await user.click(within(secondPromptRow).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocked['deleteWorkflowGroupPrompt']).toHaveBeenCalledWith('g1', 'p2'));
  });

  it('deletes a workflow group once the question is confirmed', async () => {
    mocked['listWorkflowGroups'].mockResolvedValue({
      groups: [{ ...policyGroup, id: 'g1', name: 'Draft group', isDefault: false, prompts: [] }],
    });
    mocked['deleteWorkflowGroup'].mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    await renderSignedIn(<AdminPage />, ADMIN);

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocked['deleteWorkflowGroup']).toHaveBeenCalledWith('g1'));
  });

  it('says so when there are no LLM endpoints yet', async () => {
    await renderSignedIn(<AdminPage />, ADMIN);
    expect(await screen.findByText('No endpoints registered yet.')).toBeInTheDocument();
  });

  it('lists a registered endpoint with its authentication and whether a secret is stored', async () => {
    mocked['listLlmEndpoints'].mockResolvedValue({
      endpoints: [
        {
          id: 'e1',
          name: 'Internal GPU box',
          url: 'http://10.0.0.5:8000/v1/chat/completions',
          authScheme: 'bearer',
          authHeaderName: null,
          hasSecret: true,
          requestFormat: 'openai-chat',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          createdBy: 'u-admin',
        },
      ],
    });
    await renderSignedIn(<AdminPage />, ADMIN);
    // "Internal GPU box" also names an option in the Chat-settings select
    // below, so the row itself is found by its table cell, not just its text.
    const row = (await screen.findByRole('cell', { name: 'Internal GPU box' })).closest('tr');
    expect(row).not.toBeNull();
    const withinRow = within(row as HTMLElement);
    expect(withinRow.getByText('http://10.0.0.5:8000/v1/chat/completions')).toBeInTheDocument();
    expect(withinRow.getByText('bearer')).toBeInTheDocument();
    expect(withinRow.getByText('Set')).toBeInTheDocument();
  });

  it('registers an endpoint, sending the header name only when the scheme needs one', async () => {
    mocked['createLlmEndpoint'].mockResolvedValue({
      endpoint: {
        id: 'e2',
        name: 'Internal GPU box',
        url: 'http://10.0.0.5:8000/v1/chat/completions',
        authScheme: 'bearer',
        authHeaderName: null,
        hasSecret: true,
        requestFormat: 'openai-chat',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        createdBy: 'u-admin',
      },
    });
    const user = userEvent.setup();
    await renderSignedIn(<AdminPage />, ADMIN);

    await user.type(await screen.findByLabelText('Endpoint name'), 'Internal GPU box');
    await user.type(screen.getByLabelText('URL'), 'http://10.0.0.5:8000/v1/chat/completions');
    await user.selectOptions(screen.getByLabelText('Authentication'), 'bearer');
    await user.type(screen.getByLabelText('Header name'), 'Should be ignored for bearer');
    await user.type(screen.getByLabelText('Secret'), 'sk-my-secret');
    await user.click(screen.getByRole('button', { name: 'Register' }));

    await waitFor(() =>
      expect(mocked['createLlmEndpoint']).toHaveBeenCalledWith({
        name: 'Internal GPU box',
        url: 'http://10.0.0.5:8000/v1/chat/completions',
        authScheme: 'bearer',
        authHeaderName: null,
        authSecret: 'sk-my-secret',
        isDefault: false,
      }),
    );
  });

  it('shows what a connection test reports', async () => {
    mocked['listLlmEndpoints'].mockResolvedValue({
      endpoints: [
        {
          id: 'e1',
          name: 'Internal GPU box',
          url: 'http://10.0.0.5:8000/v1/chat/completions',
          authScheme: 'none',
          authHeaderName: null,
          hasSecret: false,
          requestFormat: 'openai-chat',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          createdBy: 'u-admin',
        },
      ],
    });
    mocked['testLlmEndpoint'].mockResolvedValue({ ok: true, status: 200, message: 'Connected.' });
    const user = userEvent.setup();
    await renderSignedIn(<AdminPage />, ADMIN);

    await user.click(await screen.findByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connected.')).toBeInTheDocument();
    expect(mocked['testLlmEndpoint']).toHaveBeenCalledWith('e1');
  });

  it('deletes an endpoint once the question is confirmed', async () => {
    mocked['listLlmEndpoints'].mockResolvedValue({
      endpoints: [
        {
          id: 'e1',
          name: 'Draft endpoint',
          url: 'http://10.0.0.5',
          authScheme: 'none',
          authHeaderName: null,
          hasSecret: false,
          requestFormat: 'openai-chat',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          createdBy: 'u-admin',
        },
      ],
    });
    mocked['deleteLlmEndpoint'].mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    await renderSignedIn(<AdminPage />, ADMIN);

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocked['deleteLlmEndpoint']).toHaveBeenCalledWith('e1'));
  });

  it('loads the export template with its default values', async () => {
    await renderSignedIn(<AdminPage />, ADMIN);
    expect(await screen.findByRole('heading', { name: 'Body text' })).toBeInTheDocument();
    expect(screen.getByLabelText('Body font')).toHaveValue('Carlito');
    expect(screen.getByLabelText('Body size')).toHaveValue(11);
    expect(screen.getByLabelText('Heading 1 font')).toHaveValue('Carlito');
  });

  it('edits a heading and the body style, then saves the whole template in one call', async () => {
    const saved = exportTemplateFixture();
    mocked['updateExportTemplate'].mockResolvedValue({ template: saved });
    const user = userEvent.setup();
    await renderSignedIn(<AdminPage />, ADMIN);
    await screen.findByRole('heading', { name: 'Body text' });

    const bodyFont = screen.getByLabelText('Body font');
    await user.clear(bodyFont);
    await user.type(bodyFont, 'Georgia');
    const heading1Size = screen.getByLabelText('Heading 1 size');
    await user.clear(heading1Size);
    await user.type(heading1Size, '22');

    await user.click(screen.getByRole('button', { name: 'Save export template' }));

    await waitFor(() => expect(mocked['updateExportTemplate']).toHaveBeenCalled());
    const call = mocked['updateExportTemplate'].mock.calls[0]![0];
    expect(call.body.fontFamily).toBe('Georgia');
    expect(call.headings[0].fontSize).toBe(22);
    // Untouched fields travel unchanged, since the save writes every section at once.
    expect(call.footer.right.content).toBe('{{page}} of {{pageCount}}');
  });

  it('refuses an unknown token, surfacing the server’s message', async () => {
    mocked['updateExportTemplate'].mockRejectedValue(new ApiError(400, 'BAD_REQUEST', 'Unknown token {{document.owner}}.'));
    const user = userEvent.setup();
    await renderSignedIn(<AdminPage />, ADMIN);
    await screen.findByRole('heading', { name: 'Body text' });

    await user.click(screen.getByRole('button', { name: 'Save export template' }));
    expect(await screen.findByText('Unknown token {{document.owner}}.')).toBeInTheDocument();
  });
});

describe('editor page', () => {
  it('opens a document and shows its title', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Document title')).toHaveValue('Quarterly Report'));
    expect(await screen.findByText('All changes saved')).toBeInTheDocument();
  });

  it('reports a document that cannot be opened, and offers a way back', async () => {
    mocked['getDocument'].mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Document not found'));
    const onBack = vi.fn();
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={onBack} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Document not found');
    await user.click(screen.getByRole('button', { name: 'Back to documents' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('saves a renamed title when the field loses focus', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['saveDocument'].mockResolvedValue({ document: detail({ title: 'Renamed', revision: 4 }) });
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    const title = await screen.findByLabelText('Document title');
    await user.clear(title);
    await user.type(title, 'Renamed');
    await user.tab();

    await waitFor(() =>
      expect(mocked['saveDocument']).toHaveBeenCalledWith('doc-1', {
        title: 'Renamed',
        expectedRevision: 3,
      }),
    );
  });

  it('does not save a title that did not change', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);
    const title = await screen.findByLabelText('Document title');
    await user.click(title);
    await user.tab();
    expect(mocked['saveDocument']).not.toHaveBeenCalled();
  });

  it('reports a save that was refused because the document moved on', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['saveDocument'].mockRejectedValue(
      new ApiError(400, 'BAD_REQUEST', 'This document was changed by someone else. Reload before saving.'),
    );
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);
    const title = await screen.findByLabelText('Document title');
    await user.clear(title);
    await user.type(title, 'Renamed');
    await user.tab();

    expect(await screen.findByRole('alert')).toHaveTextContent('changed by someone else');
    expect(await screen.findByText('Save failed')).toBeInTheDocument();
  });

  it('never sends two saves at once, so your own edits cannot conflict', async () => {
    // Regression: the title field losing focus while the body autosaved sent two
    // writes carrying the same expected revision. The second was rejected, and
    // because the revision only advanced on success every later save failed too.
    mocked['getDocument'].mockResolvedValue({ document: detail() });

    let inFlight = 0;
    let maxInFlight = 0;
    const revisions: (number | undefined)[] = [];
    let revision = 3;
    mocked['saveDocument'].mockImplementation(async (_id: string, payload: { expectedRevision?: number }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      revisions.push(payload.expectedRevision);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      inFlight -= 1;
      if (payload.expectedRevision !== revision) {
        throw new ApiError(409, 'REVISION_CONFLICT', 'This document was changed by someone else.');
      }
      revision += 1;
      return { document: detail({ revision }) };
    });

    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    const title = await screen.findByLabelText('Document title');
    await user.clear(title);
    await user.type(title, 'First rename');
    await user.tab();
    await user.click(title);
    await user.clear(title);
    await user.type(title, 'Second rename');
    await user.tab();

    await waitFor(() => expect(screen.getByText('All changes saved')).toBeInTheDocument());
    expect(maxInFlight).toBe(1);
    // Each save carried the revision the one before it produced.
    expect(revisions).toEqual([3, 4]);
  });

  it('stops saving and offers a reload when somebody else got there first', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['saveDocument'].mockRejectedValue(
      new ApiError(409, 'REVISION_CONFLICT', 'This document was changed by someone else. Reload before saving.'),
    );
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    const title = await screen.findByLabelText('Document title');
    await user.clear(title);
    await user.type(title, 'Renamed');
    await user.tab();

    expect(await screen.findByText('Someone else saved first')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Reload before saving');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();

    // It must not keep retrying against a revision that will never match.
    const attempts = mocked['saveDocument'].mock.calls.length;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(mocked['saveDocument'].mock.calls.length).toBe(attempts);
  });

  it('does not claim everything is saved while keystrokes are still pending', async () => {
    // Regression: the editor waits a moment after typing stops before handing
    // content over, so "nothing queued" is not "nothing unsaved". Treating them
    // as the same showed "All changes saved" while recent keystrokes sat in that
    // gap, and the warning shown when closing the tab is keyed on the same
    // state, so a tab closed then lost them without a word.
    mocked['getDocument'].mockResolvedValue({ document: detail() });

    let release: () => void = () => {};
    mocked['saveDocument'].mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { document: detail({ revision: 4 }) };
    });

    const user = userEvent.setup();
    const { container } = await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    // Start a save by renaming, then type into the body while it is in flight.
    const title = await screen.findByLabelText('Document title');
    await user.clear(title);
    await user.type(title, 'Renamed');
    await user.tab();
    await screen.findByText('Saving…');

    const body = container.querySelector('[aria-label="Document body"]') as HTMLElement;
    await user.click(body);
    await user.keyboard('more words');

    release();

    // The save finishes, but what was typed after it started is not in it.
    await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeInTheDocument());
    expect(screen.queryByText('All changes saved')).not.toBeInTheDocument();
  });

  it('ignores the answer to a save that a restore has already replaced', async () => {
    // A save in flight across the restore would otherwise put the revision and
    // the document back to where they were, while the editor showed the
    // restored text, and the next save would fail against a revision that no
    // longer matched.
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['listVersions'].mockResolvedValue({
      versions: [
        { revision: 3, title: 'Q', authorName: 'E', createdAt: '2026-01-02T10:30:00.000Z' },
        { revision: 1, title: 'Q', authorName: 'E', createdAt: '2026-01-02T09:30:00.000Z' },
      ],
    });

    let release: () => void = () => {};
    mocked['saveDocument'].mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { document: detail({ revision: 4, title: 'From the stale save' }) };
    });
    mocked['restoreVersion'].mockResolvedValue({
      document: detail({
        revision: 9,
        title: 'Restored',
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The older wording' }] }],
        },
      }),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    const title = await screen.findByLabelText('Document title');
    await user.clear(title);
    await user.type(title, 'Renamed');
    await user.tab();
    await screen.findByText('Saving…');

    await user.click(await screen.findByRole('button', { name: 'History' }));
    await user.click(await restoreButtonFor(1));
    await waitFor(() => expect(screen.getByLabelText('Document title')).toHaveValue('Restored'));

    // The stale save answers only now.
    release();

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Document body' })).toHaveTextContent(
        'The older wording',
      ),
    );
    expect(screen.getByLabelText('Document title')).toHaveValue('Restored');
  });

  it('sends an edit made after a restore, rather than stranding it', async () => {
    // Regression: the stale save's answer arrived after the restore, the loop
    // returned on the generation mismatch, and anything queued in between was
    // left sitting there with the badge claiming everything was saved.
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['listVersions'].mockResolvedValue({
      versions: [
        { revision: 3, title: 'Q', authorName: 'E', createdAt: '2026-01-02T10:30:00.000Z' },
        { revision: 1, title: 'Q', authorName: 'E', createdAt: '2026-01-02T09:30:00.000Z' },
      ],
    });
    mocked['restoreVersion'].mockResolvedValue({ document: detail({ revision: 9, title: 'Restored' }) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const titles: (string | undefined)[] = [];
    let release: () => void = () => {};
    let first = true;
    mocked['saveDocument'].mockImplementation(async (_id: string, payload: { title?: string }) => {
      titles.push(payload.title);
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { document: detail({ revision: 10, title: payload.title ?? 'Restored' }) };
    });

    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    const title = await screen.findByLabelText('Document title');
    await user.clear(title);
    await user.type(title, 'Before restore');
    await user.tab();
    await screen.findByText('Saving…');

    await user.click(await screen.findByRole('button', { name: 'History' }));
    await user.click(await restoreButtonFor(1));
    await waitFor(() => expect(screen.getByLabelText('Document title')).toHaveValue('Restored'));

    // An edit made after the restore, while the first save is still out there.
    const restored = screen.getByLabelText('Document title');
    await user.clear(restored);
    await user.type(restored, 'After restore');
    await user.tab();

    release();

    await waitFor(() => expect(titles).toContain('After restore'));
    await waitFor(() => expect(screen.getByText('All changes saved')).toBeInTheDocument());
  });

  it('keeps a save failure on screen while a download succeeds', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['saveDocument'].mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong.'));
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    const title = await screen.findByLabelText('Document title');
    await user.clear(title);
    await user.type(title, 'Renamed');
    await user.tab();
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');

    await user.click(screen.getByRole('button', { name: 'Export .docx' }));
    // The save still failed; downloading says nothing about that.
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong.');
  });

  it('reports a download that failed rather than saying nothing', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    (downloadExport as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(404, 'EXPORT_FAILED', 'The export failed.'),
    );
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Export .docx' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The export failed.');
  });

  it('offers no reload button while saving is healthy', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);
    await screen.findByText('All changes saved');
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
  });

  it('exports in either format', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Export .docx' }));
    expect(downloadExport).toHaveBeenCalledWith('doc-1', 'docx');
    await user.click(screen.getByRole('button', { name: 'Export .txt' }));
    expect(downloadExport).toHaveBeenCalledWith('doc-1', 'txt');
  });

  it('opens and closes the version history', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['listVersions'].mockResolvedValue({
      versions: [
        { revision: 3, title: 'Quarterly Report', authorName: 'Eddie Editor', createdAt: '2026-01-02T10:30:00.000Z' },
        { revision: 2, title: 'Quarterly Report', authorName: 'Eddie Editor', createdAt: '2026-01-02T09:30:00.000Z' },
      ],
    });
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'History' }));
    expect(await screen.findByText('Version history')).toBeInTheDocument();
    expect(screen.getByText(/Revision 2 by Eddie Editor/u)).toBeInTheDocument();
    // The version already open offers no restore.
    expect(screen.getAllByRole('button', { name: 'Restore' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'History' }));
    await waitFor(() => expect(screen.queryByText('Version history')).not.toBeInTheDocument());
  });

  it('restores an earlier version and shows its text without reloading the page', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['listVersions'].mockResolvedValue({
      versions: [
        { revision: 2, title: 'Quarterly Report', authorName: 'Eddie Editor', createdAt: '2026-01-02T10:30:00.000Z' },
        { revision: 1, title: 'Quarterly Report', authorName: 'Eddie Editor', createdAt: '2026-01-02T09:30:00.000Z' },
      ],
    });
    mocked['restoreVersion'].mockResolvedValue({
      document: detail({
        revision: 4,
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The older wording' }] }],
        },
      }),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'History' }));
    await user.click(await restoreButtonFor(1));

    await waitFor(() => expect(mocked['restoreVersion']).toHaveBeenCalledWith('doc-1', 1));
    // The editing surface is remounted with the restored text, rather than the
    // whole page being reloaded.
    // The title field is also a textbox, so name the editing surface itself.
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Document body' })).toHaveTextContent(
        'The older wording',
      ),
    );
    expect(screen.queryByText('Version history')).not.toBeInTheDocument();
  });

  it('does not restore when the question is dismissed', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['listVersions'].mockResolvedValue({
      versions: [
        { revision: 2, title: 'Q', authorName: 'E', createdAt: '2026-01-02T10:30:00.000Z' },
        { revision: 1, title: 'Q', authorName: 'E', createdAt: '2026-01-02T09:30:00.000Z' },
      ],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'History' }));
    await user.click(await restoreButtonFor(1));
    expect(mocked['restoreVersion']).not.toHaveBeenCalled();
  });

  it('reports a restore that failed', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['listVersions'].mockResolvedValue({
      versions: [
        { revision: 2, title: 'Q', authorName: 'E', createdAt: '2026-01-02T10:30:00.000Z' },
        { revision: 1, title: 'Q', authorName: 'E', createdAt: '2026-01-02T09:30:00.000Z' },
      ],
    });
    mocked['restoreVersion'].mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Version not found'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'History' }));
    await user.click(await restoreButtonFor(1));
    expect(await screen.findByRole('alert')).toHaveTextContent('Version not found');
  });

  it('reports a version history that could not be loaded', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['listVersions'].mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong.'));
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'History' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
  });

  it('reports a sharing list that could not be loaded', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['listShares'].mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong.'));
    mocked['listUsers'].mockResolvedValue({ users: [] });
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Share' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
  });

  it('closes the sharing panel when the button is pressed again', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['listShares'].mockResolvedValue({ shares: [] });
    mocked['listUsers'].mockResolvedValue({ users: [] });
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Share' }));
    expect(await screen.findByText('Not shared with anyone yet.')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Share' })[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByText('Sharing')).not.toBeInTheDocument());
  });

  it('ignores a share submitted with nobody chosen', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['listShares'].mockResolvedValue({ shares: [] });
    mocked['listUsers'].mockResolvedValue({ users: [ADMIN] });
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Share' }));
    const form = document.querySelector('form.share-form') as HTMLFormElement;
    form.requestSubmit();
    await waitFor(() => expect(mocked['share']).not.toHaveBeenCalled());
  });

  it('offers sharing to the owner and lists who has access', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['listShares'].mockResolvedValue({
      shares: [{ userId: 'u-other', email: 'other@localhost', name: 'Otto Other', permission: 'view' }],
    });
    mocked['listUsers'].mockResolvedValue({ users: [EDITOR, { ...ADMIN }] });
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Share' }));
    expect(await screen.findByText('Sharing')).toBeInTheDocument();
    expect(screen.getByText(/Otto Other can view/u)).toBeInTheDocument();
  });

  it('shares with the chosen person at the chosen permission', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['listShares'].mockResolvedValue({ shares: [] });
    mocked['listUsers'].mockResolvedValue({ users: [ADMIN] });
    mocked['share'].mockResolvedValue({
      shares: [{ userId: 'u-admin', email: 'admin@localhost', name: 'Ada Admin', permission: 'edit' }],
    });
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Share' }));
    await user.selectOptions(await screen.findByLabelText('Person'), 'u-admin');
    await user.selectOptions(screen.getByLabelText('Permission'), 'edit');
    const form = document.querySelector('form.share-form') as HTMLElement;
    await user.click(within(form).getByRole('button', { name: 'Share' }));

    await waitFor(() => expect(mocked['share']).toHaveBeenCalledWith('doc-1', 'u-admin', 'edit'));
  });

  it('removes a share', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['listShares'].mockResolvedValue({
      shares: [{ userId: 'u-other', email: 'other@localhost', name: 'Otto Other', permission: 'view' }],
    });
    mocked['listUsers'].mockResolvedValue({ users: [] });
    mocked['unshare'].mockResolvedValue({ shares: [] });
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Share' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mocked['unshare']).toHaveBeenCalledWith('doc-1', 'u-other'));
  });

  it('hides sharing from someone who is not the owner', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail({ access: 'edit' }) });
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);
    await screen.findByRole('button', { name: 'History' });
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
  });

  it('makes the title read only when access is view', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail({ access: 'view' }) });
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);
    expect(await screen.findByLabelText('Document title')).toHaveAttribute('readonly');
    expect(await screen.findByText('Read only')).toBeInTheDocument();
  });

  it('goes back to the list', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    const onBack = vi.fn();
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={onBack} />);
    // A real arrow icon replaced the literal arrow character in the label.
    await user.click(await screen.findByRole('button', { name: 'Documents' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('opens Chat, sends a message and shows the reply, carrying the document as context', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['sendChatMessage'].mockResolvedValue({ ok: true, reply: 'It is about the quarter.', truncated: false });
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    // Chat is the AI panel's default sub-tab.
    await user.click(await screen.findByRole('button', { name: 'AI' }));
    expect(await screen.findByText('Ask a question about this document.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Message'), 'What is this about?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('It is about the quarter.')).toBeInTheDocument();
    expect(mocked['sendChatMessage']).toHaveBeenCalledWith('doc-1', 'What is this about?', []);
  });

  it('says so when Chat has no AI endpoint configured', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['sendChatMessage'].mockResolvedValue({ ok: false, message: 'No AI endpoint is configured.' });
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'AI' }));
    await user.type(screen.getByLabelText('Message'), 'Hello?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('No AI endpoint is configured.')).toBeInTheDocument();
  });

  it('opens Analysis, runs the workflow group set up for this document, and shows both outputs and the summary', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    mocked['listWorkflowGroupsForDocument'].mockResolvedValue({
      groups: [{ id: 'g1', name: 'Policy prompts', description: '' }],
    });
    mocked['runAnalysis'].mockResolvedValue({
      ok: true,
      message: 'Complete.',
      groupId: 'g1',
      groupName: 'Policy prompts',
      analysis: [{ promptId: 'p1', text: 'Does it name an owner?', output: 'Yes, Jane Doe.' }],
      summary: 'The document names an owner.',
    });
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'AI' }));
    await user.click(await screen.findByRole('tab', { name: 'Analysis' }));
    await screen.findByRole('option', { name: 'Policy prompts' });
    await user.click(screen.getByRole('button', { name: 'Run analysis' }));

    expect(await screen.findByText('Does it name an owner?')).toBeInTheDocument();
    expect(screen.getByText('Yes, Jane Doe.')).toBeInTheDocument();
    expect(screen.getByText('The document names an owner.')).toBeInTheDocument();
    expect(mocked['runAnalysis']).toHaveBeenCalledWith('doc-1', 'g1');
  });

  it('says so when no workflow group is set up for this kind of document', async () => {
    mocked['getDocument'].mockResolvedValue({ document: detail() });
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'AI' }));
    await user.click(await screen.findByRole('tab', { name: 'Analysis' }));
    expect(await screen.findByText(/no workflow group is set up/i)).toBeInTheDocument();
  });
});

describe('page setup', () => {
  it('shows the header and footer on the page, and saves a change to them', async () => {
    // Without them on the page, a document carrying a header looked as though
    // it did not, and the only way to find out was to open a panel.
    mocked['getDocument'].mockResolvedValue({
      document: detail({
        pageSetup: { header: 'Company handbook', footer: 'Confidential', orientation: 'portrait' },
      }),
    });
    mocked['saveDocument'].mockResolvedValue({ document: detail() });
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);

    await waitFor(() =>
      expect(screen.getByLabelText('Page header')).toHaveTextContent('Company handbook'),
    );
    expect(screen.getByLabelText('Page footer')).toHaveTextContent('Confidential');

    await user.click(screen.getByRole('button', { name: 'Page setup' }));
    const header = screen.getByLabelText('Header');
    expect(header).toHaveValue('Company handbook');
    await user.clear(header);

    await waitFor(() => expect(mocked['saveDocument']).toHaveBeenCalled());
    const payload = mocked['saveDocument'].mock.calls.at(-1)?.[1] as {
      pageSetup?: { header: string };
    };
    expect(payload.pageSetup?.header).toBe('');
  });

  it('offers the orientation the file was written with', async () => {
    mocked['getDocument'].mockResolvedValue({
      document: detail({
        pageSetup: { header: '', footer: '', orientation: 'landscape' },
      }),
    });
    const user = userEvent.setup();
    await renderSignedIn(<EditorPage documentId="doc-1" onBack={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Page setup' }));
    expect(screen.getByLabelText('Orientation')).toHaveValue('landscape');
  });
});
