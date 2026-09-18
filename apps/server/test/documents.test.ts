import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  authHeader,
  createAndLogin,
  makeApp,
  paragraphDoc,
  registerFirstAdmin,
  type TestActor,
} from './helpers.js';

async function createDoc(
  app: FastifyInstance,
  actor: TestActor,
  title = 'Test document',
  content: unknown = paragraphDoc('Hello world'),
): Promise<{ id: string; revision: number; title: string; wordCount: number }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/documents',
    headers: authHeader(actor),
    payload: { title, content },
  });
  expect(response.statusCode).toBe(201);
  return response.json().document;
}

describe('documents', () => {
  let app: FastifyInstance;
  let admin: TestActor;
  let owner: TestActor;
  let other: TestActor;

  beforeEach(async () => {
    app = await makeApp();
    admin = await registerFirstAdmin(app);
    owner = await createAndLogin(app, admin, { email: 'owner@example.com', name: 'Olive Owner' });
    other = await createAndLogin(app, admin, { email: 'other@example.com', name: 'Otto Other' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates a blank document when no content is supplied', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: authHeader(owner),
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    const document = response.json().document;
    expect(document.title).toBe('Untitled document');
    expect(document.content).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(document.revision).toBe(1);
    expect(document.access).toBe('owner');
  });

  it('counts words on save', async () => {
    const document = await createDoc(app, owner, 'Counted', paragraphDoc('one two three', 'four'));
    expect(document.wordCount).toBe(4);
  });

  it('trims a title and falls back when it is blank', async () => {
    const document = await createDoc(app, owner, '   ', paragraphDoc('x'));
    expect(document.title).toBe('Untitled document');
  });

  it('rejects content that is not a valid document', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: authHeader(owner),
      payload: { title: 'Bad', content: { type: 'doc', content: [{ type: 'script' }] } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/not valid/u);
  });

  it('rejects a text node carrying an unknown mark', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: authHeader(owner),
      payload: {
        title: 'Bad marks',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'x', marks: [{ type: 'onmouseover' }] }],
            },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('saves an edit and increments the revision', async () => {
    const created = await createDoc(app, owner);
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}`,
      headers: authHeader(owner),
      payload: { content: paragraphDoc('Changed text'), expectedRevision: created.revision },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().document.revision).toBe(2);
    expect(updated.json().document.wordCount).toBe(2);
  });

  it('rejects a save when the client revision is stale', async () => {
    const created = await createDoc(app, owner);
    await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}`,
      headers: authHeader(owner),
      payload: { content: paragraphDoc('First writer') },
    });
    const stale = await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}`,
      headers: authHeader(owner),
      payload: { content: paragraphDoc('Second writer'), expectedRevision: 1 },
    });
    expect(stale.statusCode).toBe(400);
    expect(stale.json().error.message).toMatch(/changed by someone else/u);
  });

  it('hides another user documents from the list', async () => {
    await createDoc(app, owner, 'Private');
    const response = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: authHeader(other),
    });
    expect(response.json().documents).toEqual([]);
  });

  it('answers not found rather than forbidden for a document you cannot see', async () => {
    const created = await createDoc(app, owner, 'Private');
    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${created.id}`,
      headers: authHeader(other),
    });
    expect(response.statusCode).toBe(404);
  });

  it('grants read access through a view share but refuses writes', async () => {
    const created = await createDoc(app, owner, 'Shared');
    const share = await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}/shares`,
      headers: authHeader(owner),
      payload: { userId: other.id, permission: 'view' },
    });
    expect(share.statusCode).toBe(200);

    const read = await app.inject({
      method: 'GET',
      url: `/api/documents/${created.id}`,
      headers: authHeader(other),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().document.access).toBe('view');

    const write = await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}`,
      headers: authHeader(other),
      payload: { content: paragraphDoc('Sneaky edit') },
    });
    expect(write.statusCode).toBe(403);
  });

  it('allows writes through an edit share', async () => {
    const created = await createDoc(app, owner, 'Shared for editing');
    await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}/shares`,
      headers: authHeader(owner),
      payload: { userId: other.id, permission: 'edit' },
    });
    const write = await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}`,
      headers: authHeader(other),
      payload: { content: paragraphDoc('Collaborator edit') },
    });
    expect(write.statusCode).toBe(200);
    expect(write.json().document.revision).toBe(2);
  });

  it('lets only the owner change sharing', async () => {
    const created = await createDoc(app, owner, 'Shared for editing');
    await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}/shares`,
      headers: authHeader(owner),
      payload: { userId: other.id, permission: 'edit' },
    });
    const response = await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}/shares`,
      headers: authHeader(other),
      payload: { userId: admin.id, permission: 'edit' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('revokes access when a share is removed', async () => {
    const created = await createDoc(app, owner, 'Shared then revoked');
    await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}/shares`,
      headers: authHeader(owner),
      payload: { userId: other.id, permission: 'edit' },
    });
    await app.inject({
      method: 'DELETE',
      url: `/api/documents/${created.id}/shares/${other.id}`,
      headers: authHeader(owner),
    });
    const read = await app.inject({
      method: 'GET',
      url: `/api/documents/${created.id}`,
      headers: authHeader(other),
    });
    expect(read.statusCode).toBe(404);
  });

  it('gives an administrator read access but not silent write access', async () => {
    const created = await createDoc(app, owner, 'Owned by someone else');
    const read = await app.inject({
      method: 'GET',
      url: `/api/documents/${created.id}`,
      headers: authHeader(admin),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().document.access).toBe('view');

    const write = await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}`,
      headers: authHeader(admin),
      payload: { content: paragraphDoc('Administrative edit') },
    });
    expect(write.statusCode).toBe(403);
  });

  it('lets only the owner delete, and hides the document afterwards', async () => {
    const created = await createDoc(app, owner, 'To delete');
    await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}/shares`,
      headers: authHeader(owner),
      payload: { userId: other.id, permission: 'edit' },
    });

    const byCollaborator = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${created.id}`,
      headers: authHeader(other),
    });
    expect(byCollaborator.statusCode).toBe(403);

    const byOwner = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${created.id}`,
      headers: authHeader(owner),
    });
    expect(byOwner.statusCode).toBe(200);

    const afterwards = await app.inject({
      method: 'GET',
      url: `/api/documents/${created.id}`,
      headers: authHeader(owner),
    });
    expect(afterwards.statusCode).toBe(404);
  });

  it('keeps a version for every save and restores an earlier one', async () => {
    const created = await createDoc(app, owner, 'Versioned', paragraphDoc('Revision one'));
    await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}`,
      headers: authHeader(owner),
      payload: { content: paragraphDoc('Revision two') },
    });

    const versions = await app.inject({
      method: 'GET',
      url: `/api/documents/${created.id}/versions`,
      headers: authHeader(owner),
    });
    expect(versions.json().versions).toHaveLength(2);

    const restored = await app.inject({
      method: 'POST',
      url: `/api/documents/${created.id}/versions/1/restore`,
      headers: authHeader(owner),
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().document.revision).toBe(3);

    const current = await app.inject({
      method: 'GET',
      url: `/api/documents/${created.id}`,
      headers: authHeader(owner),
    });
    expect(JSON.stringify(current.json().document.content)).toContain('Revision one');
  });

  it('stops a viewer account from creating documents', async () => {
    const viewer = await createAndLogin(app, admin, {
      email: 'viewer@example.com',
      name: 'Vera Viewer',
      role: 'viewer',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: authHeader(viewer),
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a malformed document id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/documents/not-a-uuid',
      headers: authHeader(owner),
    });
    expect(response.statusCode).toBe(400);
  });

  it('orders the document list by most recently updated', async () => {
    const first = await createDoc(app, owner, 'Older');
    await createDoc(app, owner, 'Newer');
    await app.inject({
      method: 'PUT',
      url: `/api/documents/${first.id}`,
      headers: authHeader(owner),
      payload: { content: paragraphDoc('Touched again') },
    });
    const list = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: authHeader(owner),
    });
    expect((list.json().documents as { title: string }[])[0]?.title).toBe('Older');
  });
});
