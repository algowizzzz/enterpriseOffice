import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, downloadExport, fileNameFromDisposition } from '../src/lib/api';

interface Call {
  url: string;
  init: RequestInit;
}

let calls: Call[] = [];

function respondWith(
  body: unknown,
  init: { status?: number; contentType?: string; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  const contentType = init.contentType ?? 'application/json';
  const headers = new Headers({ 'content-type': contentType, ...(init.headers ?? {}) });
  const text = contentType.includes('application/json') ? JSON.stringify(body) : String(body);
  return new Response(status === 204 ? null : text, { status, headers });
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
}

describe('api client', () => {
  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefixes every request with the api path', async () => {
    mockFetch(() => respondWith({ documents: [] }));
    await api.listDocuments();
    expect(calls[0]?.url).toBe('/api/documents');
  });

  it('sends cookies with every request', async () => {
    mockFetch(() => respondWith({ status: 'ok' }));
    await api.health();
    expect(calls[0]?.init.credentials).toBe('same-origin');
  });

  it('declares a JSON body only when it is sending one', async () => {
    mockFetch(() => respondWith({ ok: true }));

    await api.logout();
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();

    await api.login({ email: 'a@b', password: 'x' });
    const withBody = (calls[1]?.init.headers ?? {}) as Record<string, string>;
    expect(withBody['content-type']).toBe('application/json');
  });

  it('lets the browser set the boundary for a file upload', async () => {
    mockFetch(() => respondWith({ document: {}, messages: [] }));
    const file = new File(['content'], 'report.docx');
    await api.importDocx(file);
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(calls[0]?.init.body).toBeInstanceOf(FormData);
  });

  it('sends the uploaded file under its own name', async () => {
    mockFetch(() => respondWith({ document: {}, messages: [] }));
    await api.importDocx(new File(['content'], 'Quarterly Review.docx'));
    const form = calls[0]?.init.body as FormData;
    const sent = form.get('file') as File;
    expect(sent.name).toBe('Quarterly Review.docx');
  });

  it('turns a structured server error into an ApiError', async () => {
    mockFetch(() =>
      respondWith(
        { error: { code: 'FORBIDDEN', message: 'You have read-only access', details: ['a'] } },
        { status: 403 },
      ),
    );
    await expect(api.listDocuments()).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'FORBIDDEN',
      message: 'You have read-only access',
      details: ['a'],
    });
  });

  it('still reports an error when the body is not JSON', async () => {
    mockFetch(() => respondWith('<html>Gateway timeout</html>', { status: 504, contentType: 'text/html' }));
    await expect(api.listDocuments()).rejects.toMatchObject({ status: 504, code: 'ERROR' });
  });

  it('falls back to a readable message when the error body has no message', async () => {
    mockFetch(() => respondWith({}, { status: 500 }));
    await expect(api.listDocuments()).rejects.toMatchObject({
      code: 'ERROR',
      message: 'The request failed.',
    });
  });

  it('reports a network failure as something the reader can act on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const error = await api.listDocuments().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('NETWORK');
    expect((error as ApiError).message).toMatch(/Cannot reach the server/u);
  });

  it('handles a response with no content', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(api.deleteDocument('id')).resolves.toBeUndefined();
  });

  it('returns text when the server did not send JSON', async () => {
    mockFetch(() => respondWith('plain words', { contentType: 'text/plain' }));
    await expect(api.health()).resolves.toBe('plain words');
  });

  it('uses the right method and path for each operation', async () => {
    mockFetch(() => respondWith({}));
    await api.createDocument({ title: 'T' });
    await api.saveDocument('doc-1', { title: 'New' });
    await api.deleteDocument('doc-1');
    await api.updateUser('user-1', { role: 'admin' });
    await api.restoreVersion('doc-1', 4);
    await api.unshare('doc-1', 'user-1');
    await api.share('doc-1', 'user-1', 'edit');
    await api.resetUserPassword('user-1', 'secret');
    await api.listVersions('doc-1');
    await api.listShares('doc-1');
    await api.listAudit();
    await api.bootstrapStatus();
    await api.me();
    await api.changePassword({ currentPassword: 'a', newPassword: 'b' });
    await api.createUser({ email: 'a@b', name: 'N', password: 'p', role: 'editor' });
    await api.register({ email: 'a@b', name: 'N', password: 'p' });
    await api.getDocument('doc-1');
    await api.listUsers();

    const seen = calls.map((call) => `${call.init.method ?? 'GET'} ${call.url}`);
    expect(seen).toEqual([
      'POST /api/documents',
      'PUT /api/documents/doc-1',
      'DELETE /api/documents/doc-1',
      'PATCH /api/users/user-1',
      'POST /api/documents/doc-1/versions/4/restore',
      'DELETE /api/documents/doc-1/shares/user-1',
      'PUT /api/documents/doc-1/shares',
      'POST /api/users/user-1/password',
      'GET /api/documents/doc-1/versions',
      'GET /api/documents/doc-1/shares',
      'GET /api/audit?limit=200',
      'GET /api/auth/bootstrap',
      'GET /api/auth/me',
      'POST /api/auth/password',
      'POST /api/users',
      'POST /api/auth/register',
      'GET /api/documents/doc-1',
      'GET /api/users',
    ]);
  });

  it('serialises the body it was given', async () => {
    mockFetch(() => respondWith({}));
    await api.share('doc-1', 'user-1', 'edit');
    expect(calls[0]?.init.body).toBe(JSON.stringify({ userId: 'user-1', permission: 'edit' }));
  });

  it('builds the export address for each format', () => {
    expect(api.exportUrl('doc-1', 'docx')).toBe('/api/documents/doc-1/export?format=docx');
    expect(api.exportUrl('doc-1', 'txt')).toBe('/api/documents/doc-1/export?format=txt');
  });
});

describe('download', () => {
  const clicks: string[] = [];

  beforeEach(() => {
    calls = [];
    clicks.length = 0;
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:fake'),
      revokeObjectURL: vi.fn(),
    });
    // jsdom does not navigate, so record the download instead of performing it.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function mockClick(
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.download);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('saves the file under the name the server chose', async () => {
    mockFetch(() =>
      respondWith('file bytes', {
        contentType: 'application/octet-stream',
        headers: { 'content-disposition': 'attachment; filename="Quarterly Review.docx"' },
      }),
    );
    await downloadExport('doc-1', 'docx');
    expect(clicks).toEqual(['Quarterly Review.docx']);
  });

  it('prefers the encoded name for a non-Latin title', async () => {
    mockFetch(() =>
      respondWith('file bytes', {
        contentType: 'application/octet-stream',
        headers: {
          'content-disposition': `attachment; filename="______.docx"; filename*=UTF-8''${encodeURIComponent('رپورٹ.docx')}`,
        },
      }),
    );
    await downloadExport('doc-1', 'docx');
    expect(clicks).toEqual(['رپورٹ.docx']);
  });

  it('falls back to a generic name when the server sent none', async () => {
    mockFetch(() => respondWith('file bytes', { contentType: 'application/octet-stream' }));
    await downloadExport('doc-1', 'txt');
    expect(clicks).toEqual(['document.txt']);
  });

  it('reports a failed export rather than saving an error page', async () => {
    mockFetch(() => respondWith({ error: { message: 'no' } }, { status: 404 }));
    await expect(downloadExport('doc-1', 'docx')).rejects.toMatchObject({ code: 'EXPORT_FAILED' });
    expect(clicks).toEqual([]);
  });

  it('removes the temporary element and releases the object url', async () => {
    mockFetch(() => respondWith('bytes', { contentType: 'application/octet-stream' }));
    await downloadExport('doc-1', 'docx');
    expect(document.querySelectorAll('a')).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });
});

describe('content disposition parsing', () => {
  it('ignores an encoded name that cannot be decoded', () => {
    expect(fileNameFromDisposition(`attachment; filename="ok.docx"; filename*=UTF-8''%E0%A4%A`)).toBe(
      'ok.docx',
    );
  });

  it('returns null when there is no name at all', () => {
    expect(fileNameFromDisposition('')).toBeNull();
    expect(fileNameFromDisposition('inline')).toBeNull();
  });
});
