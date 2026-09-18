import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, createAndLogin, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';

describe('asking for access', () => {
  let app: FastifyInstance;
  let admin: TestActor;
  let owner: TestActor;
  let reader: TestActor;
  let documentId: string;
  const call = (actor: TestActor | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, ...(actor ? { headers: authHeader(actor) } : {}), ...(payload === undefined ? {} : { payload }) });

  beforeEach(async () => {
    app = await makeApp();
    admin = await registerFirstAdmin(app);
    owner = await createAndLogin(app, admin, { email: 'own@example.com', name: 'Olive Owner' });
    reader = await createAndLogin(app, admin, { email: 'read@example.com', name: 'Rob Reader' });
    documentId = (await call(owner, 'POST', '/api/documents', { title: 'Policy' })).json().document.id;
    await call(owner, 'PUT', `/api/documents/${documentId}/shares`, { userId: reader.id, permission: 'view' });
  });
  afterEach(async () => {
    await app.close();
  });

  it('lets a reader ask to edit, shows the owner the request, and gives edit access when it is approved', async () => {
    expect((await call(reader, 'POST', `/api/documents/${documentId}/access-requests`, { note: 'I own section 4.' })).statusCode).toBe(202);
    const { requests } = (await call(owner, 'GET', '/api/access-requests')).json();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ name: 'Rob Reader', wanted: 'edit', note: 'I own section 4.', documentTitle: 'Policy' });
    expect((await call(owner, 'POST', `/api/access-requests/${requests[0].id}`, { approve: true })).statusCode).toBe(200);
    expect((await call(reader, 'GET', `/api/documents/${documentId}`)).json().document.access).toBe('edit');
    expect((await call(owner, 'GET', '/api/access-requests')).json().requests).toEqual([]);
  });

  it('asking twice is one request, and declining leaves access as it was', async () => {
    await call(reader, 'POST', `/api/documents/${documentId}/access-requests`, {});
    await call(reader, 'POST', `/api/documents/${documentId}/access-requests`, {});
    const { requests } = (await call(owner, 'GET', '/api/access-requests')).json();
    expect(requests).toHaveLength(1);
    await call(owner, 'POST', `/api/access-requests/${requests[0].id}`, { approve: false });
    expect((await call(reader, 'GET', `/api/documents/${documentId}`)).json().document.access).toBe('view');
  });

  it('cannot be answered by anybody but the owner, and says nothing to a stranger about the document', async () => {
    await call(reader, 'POST', `/api/documents/${documentId}/access-requests`, {});
    const id = (await call(owner, 'GET', '/api/access-requests')).json().requests[0].id;
    expect((await call(reader, 'POST', `/api/access-requests/${id}`, { approve: true })).statusCode).toBe(403);
    const stranger = await createAndLogin(app, admin, { email: 'out@example.com', name: 'Sam Stranger' });
    expect((await call(stranger, 'POST', `/api/documents/${documentId}/access-requests`, {})).statusCode).toBe(404);
  });

  it('takes a request for an account from somebody with none, and shows it to administrators only', async () => {
    // The answer is the same whether or not the address is already known, so
    // the form cannot be used to find out who has an account.
    const asked = await call(null, 'POST', '/api/access-requests/account', { name: 'New Person', email: 'new@example.com', note: 'Policy team' });
    expect(asked.statusCode).toBe(202);
    expect((await call(null, 'POST', '/api/access-requests/account', { name: 'Olive', email: 'own@example.com' })).statusCode).toBe(202);
    expect((await call(owner, 'GET', '/api/access-requests')).json().requests).toEqual([]);
    const seen = (await call(admin, 'GET', '/api/access-requests')).json().requests;
    expect(seen.map((entry: { email: string }) => entry.email)).toContain('new@example.com');
    expect((await call(owner, 'POST', `/api/access-requests/${seen[0].id}`, { approve: true })).statusCode).toBe(403);
    expect((await call(admin, 'POST', `/api/access-requests/${seen[0].id}`, { approve: true })).statusCode).toBe(200);
  });

  it('refuses a request for an account with no usable address', async () => {
    expect((await call(null, 'POST', '/api/access-requests/account', { name: 'X', email: 'not-an-address' })).statusCode).toBe(400);
  });
});
