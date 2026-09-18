import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { countActiveAdmins, setPassword } from '../src/services/users.js';
import { resolveSession } from '../src/services/sessions.js';
import {
  authHeader,
  createAndLogin,
  makeApp,
  registerFirstAdmin,
  type TestActor,
} from './helpers.js';

describe('unexpected failures', () => {
  let app: FastifyInstance;
  let admin: TestActor;

  beforeEach(async () => {
    app = await makeApp();
    admin = await registerFirstAdmin(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers a generic message when something breaks inside, and leaks nothing', async () => {
    // Simulate a genuine internal failure by removing a table the request needs.
    app.db.exec('DROP TABLE document_shares');

    const response = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: authHeader(admin),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' },
    });
    // The detail belongs in the server log, never in the answer.
    expect(response.body).not.toMatch(/document_shares|SQLITE|no such table|SELECT/iu);
  });

  it('keeps answering other requests after one has failed', async () => {
    app.db.exec('DROP TABLE document_shares');
    await app.inject({ method: 'GET', url: '/api/documents', headers: authHeader(admin) });

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
  });
});

describe('uploads past the limit', () => {
  let app: FastifyInstance;
  let admin: TestActor;

  beforeEach(async () => {
    app = await buildApp({
      db: openDatabase(':memory:'),
      logger: false,
      config: {
        env: 'test',
        loginRateLimit: 1000,
        bootstrapAdminPassword: '',
        webRoot: '/nonexistent',
        maxUploadBytes: 2048,
      },
    });
    admin = await registerFirstAdmin(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('refuses a file larger than the configured limit', async () => {
    const boundary = '----limit';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.docx"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(20000, 0x41)]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/documents/import',
      headers: {
        ...authHeader(admin),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('still accepts a file inside the limit', async () => {
    const boundary = '----ok';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="small.docx"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/documents/import',
      headers: {
        ...authHeader(admin),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    // Not a readable Word file, but it got past the size check, which is the point.
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).not.toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('re-enabling an account', () => {
  let app: FastifyInstance;
  let admin: TestActor;
  let editor: TestActor;

  beforeEach(async () => {
    app = await makeApp();
    admin = await registerFirstAdmin(app);
    editor = await createAndLogin(app, admin, { email: 'ed@example.com', name: 'Eddie' });
    await app.inject({
      method: 'PATCH',
      url: `/api/users/${editor.id}`,
      headers: authHeader(admin),
      payload: { status: 'disabled' },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('lets the account sign in again', async () => {
    const before = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ed@example.com', password: 'Correct-Horse-9' },
    });
    expect(before.statusCode).toBe(401);

    const enable = await app.inject({
      method: 'PATCH',
      url: `/api/users/${editor.id}`,
      headers: authHeader(admin),
      payload: { status: 'active' },
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json().user.status).toBe('active');

    const after = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ed@example.com', password: 'Correct-Horse-9' },
    });
    expect(after.statusCode).toBe(200);
  });

  it('records the re-enabling distinctly from an ordinary change', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/users/${editor.id}`,
      headers: authHeader(admin),
      payload: { status: 'active' },
    });
    const entries = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: authHeader(admin),
    });
    const actions = (entries.json().entries as { action: string }[]).map((e) => e.action);
    expect(actions).toContain('user.enabled');
    expect(actions).toContain('user.disabled');
  });

  it('records a rename as an ordinary change, not as a status change', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/users/${editor.id}`,
      headers: authHeader(admin),
      payload: { name: 'Edwina' },
    });
    const entries = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: authHeader(admin),
    });
    const latest = (entries.json().entries as { action: string }[])[0];
    expect(latest?.action).toBe('user.updated');
  });

  it('does not bring back the sessions that were revoked when it was disabled', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/users/${editor.id}`,
      headers: authHeader(admin),
      payload: { status: 'active' },
    });
    const oldSession = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: authHeader(editor),
    });
    expect(oldSession.statusCode).toBe(401);
  });
});

describe('service-level edge cases', () => {
  it('refuses to set a password for an account that does not exist', async () => {
    const db = openDatabase(':memory:');
    await expect(setPassword(db, 'no-such-user', 'Correct-Horse-9')).rejects.toThrow(
      /User not found/u,
    );
    db.close();
  });

  it('counts active administrators, with and without an exclusion', async () => {
    const app = await makeApp();
    try {
      const admin = await registerFirstAdmin(app);
      expect(countActiveAdmins(app.db)).toBe(1);
      expect(countActiveAdmins(app.db, admin.id)).toBe(0);

      await createAndLogin(app, admin, {
        email: 'admin2@example.com',
        name: 'Second',
        role: 'admin',
      });
      expect(countActiveAdmins(app.db)).toBe(2);
      expect(countActiveAdmins(app.db, admin.id)).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('does not count a disabled administrator as active', async () => {
    const app = await makeApp();
    try {
      const admin = await registerFirstAdmin(app);
      const second = await createAndLogin(app, admin, {
        email: 'admin2@example.com',
        name: 'Second',
        role: 'admin',
      });
      await app.inject({
        method: 'PATCH',
        url: `/api/users/${second.id}`,
        headers: authHeader(admin),
        payload: { status: 'disabled' },
      });
      expect(countActiveAdmins(app.db)).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('refuses a session whose account has been removed from under it', async () => {
    const app = await makeApp();
    try {
      const admin = await registerFirstAdmin(app);
      expect(resolveSession(app.db, admin.token)).toBeDefined();

      // The cascade removes the session row too, so the token resolves to nothing.
      app.db.prepare('DELETE FROM users WHERE id = ?').run(admin.id);
      expect(resolveSession(app.db, admin.token)).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('refuses a token that was never issued', async () => {
    const app = await makeApp();
    try {
      await registerFirstAdmin(app);
      expect(resolveSession(app.db, 'a-token-nobody-issued')).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
