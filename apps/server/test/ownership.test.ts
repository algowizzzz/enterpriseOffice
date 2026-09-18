import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, createAndLogin, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';
import { exportDocx } from '../src/docx/export.js';

describe('owning, handing over and sharing a document', () => {
  let app: FastifyInstance;
  let admin: TestActor;
  let owner: TestActor;
  let colleague: TestActor;
  let documentId: string;

  const call = (actor: TestActor, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: authHeader(actor), ...(payload === undefined ? {} : { payload }) });

  beforeEach(async () => {
    app = await makeApp();
    admin = await registerFirstAdmin(app);
    owner = await createAndLogin(app, admin, { email: 'own@example.com', name: 'Olive Owner' });
    colleague = await createAndLogin(app, admin, { email: 'col@example.com', name: 'Cal Colleague' });
    documentId = (await call(owner, 'POST', '/api/documents', { title: 'Policy' })).json().document.id;
  });
  afterEach(async () => {
    await app.close();
  });

  it('hands a document over, and leaves the person who had it able to edit it', async () => {
    // Handing over a document somebody was working on a moment ago must not
    // lock them out of it.
    const moved = await call(owner, 'PUT', `/api/documents/${documentId}/owner`, { userId: colleague.id });
    expect(moved.statusCode).toBe(200);
    expect((await call(colleague, 'GET', `/api/documents/${documentId}`)).json().document.access).toBe('owner');
    expect((await call(owner, 'GET', `/api/documents/${documentId}`)).json().document.access).toBe('edit');
  });

  it('lets an administrator rescue a document whose owner has gone', async () => {
    const moved = await call(admin, 'PUT', `/api/documents/${documentId}/owner`, { userId: colleague.id });
    expect(moved.statusCode).toBe(200);
    expect((await call(colleague, 'GET', `/api/documents/${documentId}`)).json().document.ownerName).toBe('Cal Colleague');
  });

  it('does not let somebody it is merely shared with take it, or a stranger learn it exists', async () => {
    await call(owner, 'PUT', `/api/documents/${documentId}/shares`, { userId: colleague.id, permission: 'edit' });
    expect((await call(colleague, 'PUT', `/api/documents/${documentId}/owner`, { userId: colleague.id })).statusCode).toBe(403);
    const stranger = await createAndLogin(app, admin, { email: 'out@example.com', name: 'Sam Stranger' });
    expect((await call(stranger, 'PUT', `/api/documents/${documentId}/owner`, { userId: stranger.id })).statusCode).toBe(404);
  });

  it('will not make a viewer account the owner of something it could not edit', async () => {
    const viewer = await createAndLogin(app, admin, { email: 'v@example.com', name: 'Vic Viewer', role: 'viewer' });
    expect((await call(owner, 'PUT', `/api/documents/${documentId}/owner`, { userId: viewer.id })).statusCode).toBe(400);
  });

  it('records the handover in the audit trail', async () => {
    await call(owner, 'PUT', `/api/documents/${documentId}/owner`, { userId: colleague.id });
    const { entries } = (await call(admin, 'GET', '/api/audit')).json();
    expect(entries.some((entry: { action: string }) => entry.action === 'document.transferred')).toBe(true);
  });

  it('shares with ten people and refuses the eleventh, while still letting the ten be changed', async () => {
    const people: TestActor[] = [];
    for (let index = 0; index < 11; index += 1) {
      people.push(await createAndLogin(app, admin, { email: `p${index}@example.com`, name: `Person ${index}` }));
    }
    for (const person of people.slice(0, 10)) {
      expect((await call(owner, 'PUT', `/api/documents/${documentId}/shares`, { userId: person.id, permission: 'view' })).statusCode).toBe(200);
    }
    expect((await call(owner, 'PUT', `/api/documents/${documentId}/shares`, { userId: people[10]!.id, permission: 'view' })).statusCode).toBe(400);
    expect((await call(owner, 'PUT', `/api/documents/${documentId}/shares`, { userId: people[0]!.id, permission: 'edit' })).statusCode).toBe(200);
  });
});

describe('choices made at upload', () => {
  let app: FastifyInstance;
  let owner: TestActor;
  beforeEach(async () => {
    app = await makeApp();
    owner = await registerFirstAdmin(app);
  });
  afterEach(async () => {
    await app.close();
  });

  const upload = async (fields: Record<string, string>) => {
    const boundary = '----docforge-test';
    // A real file with a real header and footer part, referred to from its section.
    const file = await exportDocx(
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body text.' }] }] },
      { title: 'Policy', pageSetup: { header: 'Old letterhead', footer: 'Old footer', orientation: 'portrait' } },
    );
    const parts: Buffer[] = [];
    for (const [name, value] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="policy.docx"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );
    return app.inject({
      method: 'POST',
      url: '/api/documents/import',
      headers: { ...authHeader(owner), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat(parts),
    });
  };

  it('records what kind of document it is, and shows it in the list', async () => {
    const created = await upload({ docType: 'Standard' });
    expect(created.json().document.docType).toBe('Standard');
    const list = await app.inject({ method: 'GET', url: '/api/documents', headers: authHeader(owner) });
    expect(list.json().documents[0].docType).toBe('Standard');
  });

  it('ignores a kind it has not heard of rather than storing it', async () => {
    expect((await upload({ docType: '<script>' })).json().document.docType).toBeNull();
  });

  it('keeps the letterhead unless asked to take it off, and takes it off the exported file too', async () => {
    expect((await upload({})).json().document.pageSetup.header).toBe('Old letterhead');
    const stripped = (await upload({ stripRunning: '1' })).json().document;
    expect(stripped.pageSetup).toMatchObject({ header: '', footer: '' });
    const exported = await app.inject({ method: 'GET', url: `/api/documents/${stripped.id}/export?format=docx`, headers: authHeader(owner) });
    const { strFromU8, unzipSync } = await import('fflate');
    const xml = strFromU8(unzipSync(new Uint8Array(exported.rawPayload))['word/document.xml']!);
    expect(xml).not.toContain('headerReference');
    expect(xml).not.toContain('footerReference');
  });
});

describe('locking a document while it is approved', () => {
  let app: FastifyInstance;
  let owner: TestActor;
  let editor: TestActor;
  let documentId: string;
  const call = (actor: TestActor, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: authHeader(actor), ...(payload === undefined ? {} : { payload }) });
  const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Changed.' }] }] };

  beforeEach(async () => {
    app = await makeApp();
    owner = await registerFirstAdmin(app);
    editor = await createAndLogin(app, owner, { email: 'ed@example.com', name: 'Edie Editor' });
    documentId = (await call(owner, 'POST', '/api/documents', { title: 'Policy' })).json().document.id;
    await call(owner, 'PUT', `/api/documents/${documentId}/shares`, { userId: editor.id, permission: 'edit' });
  });
  afterEach(async () => {
    await app.close();
  });

  it('stops everybody changing it, its owner included, and still takes comments', async () => {
    expect((await call(owner, 'PUT', `/api/documents/${documentId}/lock`, { locked: true })).json().document.locked).toBe(true);
    expect((await call(editor, 'PUT', `/api/documents/${documentId}`, { content: body })).statusCode).toBe(403);
    // A lock its owner can type through holds nothing still.
    expect((await call(owner, 'PUT', `/api/documents/${documentId}`, { content: body })).statusCode).toBe(403);
    expect((await call(editor, 'GET', `/api/documents/${documentId}`)).json().document.access).toBe('view');
    expect((await call(editor, 'POST', `/api/documents/${documentId}/comments`, { body: 'Looks right.' })).statusCode).toBe(201);
  });

  it('gives everybody their access back when it is unlocked', async () => {
    await call(owner, 'PUT', `/api/documents/${documentId}/lock`, { locked: true });
    await call(owner, 'PUT', `/api/documents/${documentId}/lock`, { locked: false });
    expect((await call(editor, 'GET', `/api/documents/${documentId}`)).json().document.access).toBe('edit');
    expect((await call(editor, 'PUT', `/api/documents/${documentId}`, { content: body })).statusCode).toBe(200);
  });

  it('can only be locked or unlocked by its owner', async () => {
    expect((await call(editor, 'PUT', `/api/documents/${documentId}/lock`, { locked: true })).statusCode).toBe(403);
  });
});
