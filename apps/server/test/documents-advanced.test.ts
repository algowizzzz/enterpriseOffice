import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MAX_CONTENT_BYTES, sanitizeTitle } from '../src/services/documents.js';
import {
  authHeader,
  createAndLogin,
  makeApp,
  paragraphDoc,
  registerFirstAdmin,
  type TestActor,
} from './helpers.js';

async function newDoc(
  app: FastifyInstance,
  actor: TestActor,
  title = 'Doc',
  content: unknown = paragraphDoc('Body'),
): Promise<{ id: string; revision: number }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/documents',
    headers: authHeader(actor),
    payload: { title, content },
  });
  return response.json().document;
}

describe('title handling', () => {
  it('falls back for an empty or whitespace-only title', () => {
    expect(sanitizeTitle('')).toBe('Untitled document');
    expect(sanitizeTitle('   ')).toBe('Untitled document');
    expect(sanitizeTitle(undefined)).toBe('Untitled document');
    expect(sanitizeTitle(null)).toBe('Untitled document');
  });

  it('flattens line breaks and tabs, which would break the list layout', () => {
    expect(sanitizeTitle('One\nTwo\tThree')).toBe('One Two Three');
  });

  it('shortens a title that is too long to store', () => {
    expect(sanitizeTitle('x'.repeat(500))).toHaveLength(200);
  });

  it('keeps an ordinary title untouched', () => {
    expect(sanitizeTitle('  Quarterly Review  ')).toBe('Quarterly Review');
  });
});

describe('documents, further behaviour', () => {
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

  it('renames a document without touching its content', async () => {
    const created = await newDoc(app, owner, 'Before');
    const renamed = await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}`,
      headers: authHeader(owner),
      payload: { title: 'After' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().document.title).toBe('After');
    expect(JSON.stringify(renamed.json().document.content)).toContain('Body');

    const entries = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: authHeader(admin),
    });
    const actions = (entries.json().entries as { action: string }[]).map((e) => e.action);
    expect(actions).toContain('document.renamed');
  });

  it('refuses an update that changes nothing', async () => {
    const created = await newDoc(app, owner);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}`,
      headers: authHeader(owner),
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/Nothing to update/u);
  });

  it('refuses content larger than the storage limit', async () => {
    const huge = 'y'.repeat(MAX_CONTENT_BYTES + 1000);
    const response = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: authHeader(owner),
      payload: {
        title: 'Oversized',
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: huge }] }] },
      },
    });
    expect([400, 413]).toContain(response.statusCode);
  });

  it('answers not found for a version that does not exist', async () => {
    const created = await newDoc(app, owner);
    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${created.id}/versions/99`,
      headers: authHeader(owner),
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses to restore a version that does not exist', async () => {
    const created = await newDoc(app, owner);
    const response = await app.inject({
      method: 'POST',
      url: `/api/documents/${created.id}/versions/99/restore`,
      headers: authHeader(owner),
    });
    expect(response.statusCode).toBe(404);
  });

  it('serves the content of an earlier version', async () => {
    const created = await newDoc(app, owner);
    await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}`,
      headers: authHeader(owner),
      payload: { content: paragraphDoc('Replaced entirely') },
    });
    const first = await app.inject({
      method: 'GET',
      url: `/api/documents/${created.id}/versions/1`,
      headers: authHeader(owner),
    });
    expect(first.statusCode).toBe(200);
    expect(JSON.stringify(first.json().content)).toContain('Body');
  });

  it('keeps the recent versions of a heavily edited document', async () => {
    const created = await newDoc(app, owner);
    for (let i = 0; i < 55; i += 1) {
      await app.inject({
        method: 'PUT',
        url: `/api/documents/${created.id}`,
        headers: authHeader(owner),
        payload: { content: paragraphDoc(`Edit number ${i}`) },
      });
    }
    const versions = await app.inject({
      method: 'GET',
      url: `/api/documents/${created.id}/versions`,
      headers: authHeader(owner),
    });
    const list = (versions.json().versions as { revision: number }[]).map((v) => v.revision);
    expect(list[0]).toBe(56);
    // Fifty recent, plus this hour's marker and the first revision, so a long
    // session cannot fill the disk.
    expect(list.length).toBeLessThanOrEqual(52);
  });

  it('never discards the revision a document arrived as', async () => {
    // Regression: autosave fires a second or two after somebody stops typing, so
    // a flat count of recent versions wiped the whole history, the as-imported
    // state included, after about a minute of writing.
    const created = await newDoc(app, owner, 'Imported', paragraphDoc('The original wording'));
    for (let i = 0; i < 80; i += 1) {
      await app.inject({
        method: 'PUT',
        url: `/api/documents/${created.id}`,
        headers: authHeader(owner),
        payload: { content: paragraphDoc(`Edit number ${i}`) },
      });
    }

    const versions = await app.inject({
      method: 'GET',
      url: `/api/documents/${created.id}/versions`,
      headers: authHeader(owner),
    });
    const revisions = (versions.json().versions as { revision: number }[]).map((v) => v.revision);
    expect(revisions).toContain(1);

    const original = await app.inject({
      method: 'GET',
      url: `/api/documents/${created.id}/versions/1`,
      headers: authHeader(owner),
    });
    expect(original.statusCode).toBe(200);
    expect(JSON.stringify(original.json().content)).toContain('The original wording');
  });

  it('keeps one version from each recent hour, not only the newest few', async () => {
    const created = await newDoc(app, owner);
    const edit = (text: string) =>
      app.inject({
        method: 'PUT',
        url: `/api/documents/${created.id}`,
        headers: authHeader(owner),
        payload: { content: paragraphDoc(text) },
      });

    // A morning's work, backdated into two hours while those versions still
    // exist, then pushed well outside the recent window by an afternoon of
    // editing.
    for (let i = 0; i < 8; i += 1) await edit(`Morning edit ${i}`);
    app.db
      .prepare(
        `UPDATE document_versions SET created_at = '2026-01-01T09:00:00.000Z'
          WHERE document_id = ? AND revision BETWEEN 2 AND 4`,
      )
      .run(created.id);
    app.db
      .prepare(
        `UPDATE document_versions SET created_at = '2026-01-01T10:00:00.000Z'
          WHERE document_id = ? AND revision BETWEEN 5 AND 7`,
      )
      .run(created.id);

    for (let i = 0; i < 60; i += 1) await edit(`Afternoon edit ${i}`);

    const versions = await app.inject({
      method: 'GET',
      url: `/api/documents/${created.id}/versions`,
      headers: authHeader(owner),
    });
    const revisions = (versions.json().versions as { revision: number }[]).map((v) => v.revision);
    // The last version of each backdated hour survives, although both are far
    // outside the recent window.
    expect(revisions).toContain(4);
    expect(revisions).toContain(7);
    expect(revisions).toContain(1);
  });

  it('refuses to share with an account that does not exist', async () => {
    const created = await newDoc(app, owner);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}/shares`,
      headers: authHeader(owner),
      payload: { userId: '00000000-0000-4000-8000-000000000000', permission: 'view' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses to share with a disabled account', async () => {
    const created = await newDoc(app, owner);
    await app.inject({
      method: 'PATCH',
      url: `/api/users/${other.id}`,
      headers: authHeader(admin),
      payload: { status: 'disabled' },
    });
    const response = await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}/shares`,
      headers: authHeader(owner),
      payload: { userId: other.id, permission: 'view' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/disabled/u);
  });

  it('refuses to share a document with its own owner', async () => {
    const created = await newDoc(app, owner);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}/shares`,
      headers: authHeader(owner),
      payload: { userId: owner.id, permission: 'edit' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/already own/u);
  });

  it('changes an existing share rather than adding a second one', async () => {
    const created = await newDoc(app, owner);
    await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}/shares`,
      headers: authHeader(owner),
      payload: { userId: other.id, permission: 'view' },
    });
    const upgraded = await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}/shares`,
      headers: authHeader(owner),
      payload: { userId: other.id, permission: 'edit' },
    });
    const shares = upgraded.json().shares as { userId: string; permission: string }[];
    expect(shares).toHaveLength(1);
    expect(shares[0]?.permission).toBe('edit');
  });

  it('lists who a document is shared with', async () => {
    const created = await newDoc(app, owner);
    await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}/shares`,
      headers: authHeader(owner),
      payload: { userId: other.id, permission: 'view' },
    });
    const listed = await app.inject({
      method: 'GET',
      url: `/api/documents/${created.id}/shares`,
      headers: authHeader(owner),
    });
    expect(listed.statusCode).toBe(200);
    const shares = listed.json().shares as { name: string; email: string }[];
    expect(shares[0]?.email).toBe('other@example.com');
    expect(shares[0]?.name).toBe('Otto Other');
  });

  it('lets a collaborator see the document in their own list', async () => {
    const created = await newDoc(app, owner, 'Shared with Otto');
    await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}/shares`,
      headers: authHeader(owner),
      payload: { userId: other.id, permission: 'view' },
    });
    const list = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: authHeader(other),
    });
    const documents = list.json().documents as { title: string; access: string; ownerName: string }[];
    expect(documents).toHaveLength(1);
    expect(documents[0]?.title).toBe('Shared with Otto');
    expect(documents[0]?.access).toBe('view');
    expect(documents[0]?.ownerName).toBe('Olive Owner');
  });

  it('removing a share that was never made is not an error', async () => {
    const created = await newDoc(app, owner);
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${created.id}/shares/${other.id}`,
      headers: authHeader(owner),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().shares).toEqual([]);
  });

  it('hides a deleted document from the list as well as from direct access', async () => {
    const created = await newDoc(app, owner, 'Doomed');
    await app.inject({
      method: 'DELETE',
      url: `/api/documents/${created.id}`,
      headers: authHeader(owner),
    });
    const list = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: authHeader(owner),
    });
    expect(list.json().documents).toEqual([]);
  });

  it('refuses every operation on a deleted document', async () => {
    const created = await newDoc(app, owner);
    await app.inject({
      method: 'DELETE',
      url: `/api/documents/${created.id}`,
      headers: authHeader(owner),
    });
    for (const request of [
      { method: 'GET' as const, url: `/api/documents/${created.id}` },
      { method: 'GET' as const, url: `/api/documents/${created.id}/versions` },
      { method: 'GET' as const, url: `/api/documents/${created.id}/export` },
    ]) {
      const response = await app.inject({ ...request, headers: authHeader(owner) });
      expect(response.statusCode, request.url).toBe(404);
    }
  });

  it('stops a viewer account from uploading a file', async () => {
    const viewer = await createAndLogin(app, admin, {
      email: 'viewer@example.com',
      name: 'Vera Viewer',
      role: 'viewer',
    });
    const boundary = '----t';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.docx"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/documents/import',
      headers: {
        ...authHeader(viewer),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(response.statusCode).toBe(400);
  });

  it('asks for a file when an upload arrives without one', async () => {
    const boundary = '----t';
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nno file here\r\n--${boundary}--\r\n`,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/documents/import',
      headers: {
        ...authHeader(owner),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/Attach a \.docx/u);
  });

  it('rejects an empty upload', async () => {
    const boundary = '----t';
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="empty.docx"\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--${boundary}--\r\n`,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/documents/import',
      headers: {
        ...authHeader(owner),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/empty/u);
  });

  it('rejects an export format it does not support', async () => {
    const created = await newDoc(app, owner);
    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${created.id}/export?format=pdf`,
      headers: authHeader(owner),
    });
    expect(response.statusCode).toBe(400);
  });

  it('defaults the export format to a Word file', async () => {
    const created = await newDoc(app, owner);
    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${created.id}/export`,
      headers: authHeader(owner),
    });
    expect(response.headers['content-type']).toContain('wordprocessingml.document');
  });

  it('writes a download name that survives a non-Latin title', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: authHeader(owner),
      payload: { title: 'رپورٹ', content: paragraphDoc('متن') },
    });
    const id = created.json().document.id;
    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${id}/export`,
      headers: authHeader(owner),
    });
    const disposition = response.headers['content-disposition'] as string;
    // An ASCII fallback for old clients, and the real name for everyone else.
    expect(disposition).toMatch(/filename="[^"]*"/u);
    expect(disposition).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(disposition.split("UTF-8''")[1] ?? '')).toBe('رپورٹ.docx');
  });

  it('records an export in the audit trail', async () => {
    const created = await newDoc(app, owner);
    await app.inject({
      method: 'GET',
      url: `/api/documents/${created.id}/export?format=txt`,
      headers: authHeader(owner),
    });
    const entries = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: authHeader(admin),
    });
    const exported = (entries.json().entries as { action: string; detail: unknown }[]).find(
      (entry) => entry.action === 'document.exported',
    );
    expect(exported).toBeDefined();
    expect(exported?.detail).toMatchObject({ format: 'txt' });
  });

  it('pages through the audit trail', async () => {
    const firstPage = await app.inject({
      method: 'GET',
      url: '/api/audit?limit=2&offset=0',
      headers: authHeader(admin),
    });
    expect(firstPage.json().entries).toHaveLength(2);

    const secondPage = await app.inject({
      method: 'GET',
      url: '/api/audit?limit=2&offset=2',
      headers: authHeader(admin),
    });
    expect(secondPage.json().entries.length).toBeGreaterThan(0);
    expect(secondPage.json().entries[0].id).not.toBe(firstPage.json().entries[0].id);
  });

  it('rejects an audit page size outside the allowed range', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/audit?limit=5000',
      headers: authHeader(admin),
    });
    expect(response.statusCode).toBe(400);
  });
});
