import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  authHeader,
  createAndLogin,
  login,
  makeApp,
  registerFirstAdmin,
  type TestActor,
} from './helpers.js';

describe('user management', () => {
  let app: FastifyInstance;
  let admin: TestActor;

  beforeEach(async () => {
    app = await makeApp();
    admin = await registerFirstAdmin(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('lets an administrator create an account', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: authHeader(admin),
      payload: {
        email: 'editor@example.com',
        name: 'Eddie Editor',
        password: 'Correct-Horse-9',
        role: 'editor',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().user.role).toBe('editor');
    expect(response.json().user).not.toHaveProperty('password_hash');
  });

  it('refuses a duplicate email address', async () => {
    await createAndLogin(app, admin, { email: 'dup@example.com', name: 'First' });
    const second = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: authHeader(admin),
      payload: {
        email: 'DUP@example.com',
        name: 'Second',
        password: 'Correct-Horse-9',
        role: 'editor',
      },
    });
    expect(second.statusCode).toBe(409);
  });

  it('stops a non-administrator from creating accounts', async () => {
    const editor = await createAndLogin(app, admin, {
      email: 'editor@example.com',
      name: 'Eddie',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: authHeader(editor),
      payload: {
        email: 'sneaky@example.com',
        name: 'Sneaky',
        password: 'Correct-Horse-9',
        role: 'admin',
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it('hides roles and status from non-administrators', async () => {
    const editor = await createAndLogin(app, admin, {
      email: 'editor@example.com',
      name: 'Eddie',
    });
    const asEditor = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: authHeader(editor),
    });
    expect(asEditor.statusCode).toBe(200);
    expect(asEditor.json().users[0]).not.toHaveProperty('role');

    const asAdmin = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: authHeader(admin),
    });
    expect(asAdmin.json().users[0]).toHaveProperty('role');
  });

  it('disables an account and blocks its sessions immediately', async () => {
    const editor = await createAndLogin(app, admin, {
      email: 'editor@example.com',
      name: 'Eddie',
    });
    const stillWorks = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: authHeader(editor),
    });
    expect(stillWorks.statusCode).toBe(200);

    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/users/${editor.id}`,
      headers: authHeader(admin),
      payload: { status: 'disabled' },
    });
    expect(disable.statusCode).toBe(200);

    const revoked = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: authHeader(editor),
    });
    expect(revoked.statusCode).toBe(401);

    const loginAttempt = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'editor@example.com', password: 'Correct-Horse-9' },
    });
    expect(loginAttempt.statusCode).toBe(401);
  });

  it('refuses to remove the last active administrator', async () => {
    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/users/${admin.id}`,
      headers: authHeader(admin),
      payload: { role: 'editor' },
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.message).toMatch(/last active administrator/u);
  });

  it('allows demotion once a second administrator exists', async () => {
    await createAndLogin(app, admin, {
      email: 'admin2@example.com',
      name: 'Second Admin',
      role: 'admin',
    });
    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/users/${admin.id}`,
      headers: authHeader(admin),
      payload: { role: 'editor' },
    });
    expect(demote.statusCode).toBe(200);
    expect(demote.json().user.role).toBe('editor');
  });

  it('stops an administrator from disabling their own account', async () => {
    await createAndLogin(app, admin, {
      email: 'admin2@example.com',
      name: 'Second Admin',
      role: 'admin',
    });
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/users/${admin.id}`,
      headers: authHeader(admin),
      payload: { status: 'disabled' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('resets a password as an administrator and revokes that user sessions', async () => {
    const editor = await createAndLogin(app, admin, {
      email: 'editor@example.com',
      name: 'Eddie',
    });
    const reset = await app.inject({
      method: 'POST',
      url: `/api/users/${editor.id}/password`,
      headers: authHeader(admin),
      payload: { password: 'Brand-New-Pass-7' },
    });
    expect(reset.statusCode).toBe(200);

    const oldSession = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: authHeader(editor),
    });
    expect(oldSession.statusCode).toBe(401);

    const refreshed = await login(app, 'editor@example.com', 'Brand-New-Pass-7');
    expect(refreshed.email).toBe('editor@example.com');
  });

  it('records an audit trail that only administrators can read', async () => {
    const editor = await createAndLogin(app, admin, {
      email: 'editor@example.com',
      name: 'Eddie',
    });

    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: authHeader(editor),
    });
    expect(forbidden.statusCode).toBe(403);

    const entries = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: authHeader(admin),
    });
    expect(entries.statusCode).toBe(200);
    const actions = (entries.json().entries as { action: string }[]).map((e) => e.action);
    expect(actions).toContain('user.created');
    expect(actions).toContain('user.login');
  });

  it('records failed sign-in attempts in the audit trail', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'Wrong-Password-1' },
    });
    const entries = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: authHeader(admin),
    });
    const actions = (entries.json().entries as { action: string }[]).map((e) => e.action);
    expect(actions).toContain('user.login_failed');
  });

  it('never returns a password hash in the audit detail', async () => {
    const entries = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: authHeader(admin),
    });
    expect(entries.body).not.toMatch(/scrypt\$/u);
  });

  it('resolves the actor’s name and the document’s title, not just their raw ids', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: authHeader(admin),
      payload: { title: 'Quarterly Report' },
    });
    const documentId = created.json().document.id as string;

    const entries = (
      await app.inject({ method: 'GET', url: '/api/audit', headers: authHeader(admin) })
    ).json().entries as {
      action: string;
      actorName: string | null;
      targetTitle: string | null;
      targetDeleted: boolean;
    }[];
    const entry = entries.find((e) => e.action === 'document.created' && e.targetTitle === 'Quarterly Report');
    expect(entry).toBeDefined();
    expect(entry?.actorName).toBe('Ada Admin');
    expect(entry?.targetDeleted).toBe(false);

    // A soft-deleted document still names itself in the trail -- the row is never actually gone.
    await app.inject({ method: 'DELETE', url: `/api/documents/${documentId}`, headers: authHeader(admin) });
    const afterDelete = (
      await app.inject({ method: 'GET', url: '/api/audit', headers: authHeader(admin) })
    ).json().entries as { action: string; targetTitle: string | null; targetDeleted: boolean }[];
    const stillNamed = afterDelete.find((e) => e.action === 'document.created' && e.targetTitle === 'Quarterly Report');
    expect(stillNamed?.targetDeleted).toBe(true);
  });
});
