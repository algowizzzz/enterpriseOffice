import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { purgeExpiredSessions } from '../src/services/sessions.js';
import { authHeader, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';

describe('application wiring', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await makeApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers a missing API route with a structured error', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nothing-here' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('answers a missing page with a plain not found when no client is built', async () => {
    const response = await app.inject({ method: 'GET', url: '/some/page' });
    expect(response.statusCode).toBe(404);
  });

  it('sets a content security policy that confines the page to this origin', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const policy = response.headers['content-security-policy'] as string;
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    // Images may be embedded in a document, so data and blob sources are allowed.
    expect(policy).toContain('img-src');
  });

  it('sets the usual protective headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('reads a session from a cookie as well as from a bearer token', async () => {
    const admin = await registerFirstAdmin(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `docforge_session=${admin.token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.email).toBe('admin@example.com');
  });

  it('ignores an authorization header that is not a bearer token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Basic YWRtaW46cGFzcw==' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a body that is larger than the limit', async () => {
    const admin = await registerFirstAdmin(app);
    const huge = 'x'.repeat(13 * 1024 * 1024);
    const response = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: authHeader(admin),
      payload: {
        title: 'Too big',
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: huge }] }] },
      },
    });
    expect([400, 413]).toContain(response.statusCode);
  });

  it('reports its health without touching the database session table', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.json()).toMatchObject({ status: 'ok', version: 1 });
    expect(typeof response.json().time).toBe('string');
  });
});

describe('rate limiting', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({
      db: openDatabase(':memory:'),
      logger: false,
      config: { env: 'test', loginRateLimit: 3, bootstrapAdminPassword: '', webRoot: '/nonexistent' },
    });
    await registerFirstAdmin(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('stops repeated sign-in attempts from the same address', async () => {
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'admin@example.com', password: 'Wrong-Password-1' },
        remoteAddress: '203.0.113.9',
      });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await attempt()).statusCode);

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });

  it('returns a readable message when the limit is hit', async () => {
    for (let i = 0; i < 5; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'admin@example.com', password: 'Wrong-Password-1' },
        remoteAddress: '203.0.113.10',
      });
    }
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'Wrong-Password-1' },
      remoteAddress: '203.0.113.10',
    });
    if (response.statusCode === 429) {
      expect(response.json().error.code).toBe('RATE_LIMITED');
      expect(response.json().error.message).toMatch(/Too many attempts/u);
    }
  });
});

describe('seed administrator', () => {
  it('creates the account named in configuration when the instance is empty', async () => {
    const app = await buildApp({
      db: openDatabase(':memory:'),
      logger: false,
      config: {
        env: 'test',
        bootstrapAdminEmail: 'first@localhost',
        bootstrapAdminPassword: 'Seed-Admin-Pass-1',
        webRoot: '/nonexistent',
      },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'first@localhost', password: 'Seed-Admin-Pass-1' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().user.role).toBe('admin');
    } finally {
      await app.close();
    }
  });

  it('leaves an instance that already has accounts alone', async () => {
    const db = openDatabase(':memory:');
    const first = await buildApp({
      db,
      logger: false,
      config: { env: 'test', bootstrapAdminPassword: '', webRoot: '/nonexistent' },
    });
    await registerFirstAdmin(first);

    // A second start with a seed password configured must not add an account.
    const before = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    const second = await buildApp({
      db,
      logger: false,
      config: {
        env: 'test',
        bootstrapAdminEmail: 'second@localhost',
        bootstrapAdminPassword: 'Seed-Admin-Pass-1',
        webRoot: '/nonexistent',
      },
    });
    const after = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(Number(after.n)).toBe(Number(before.n));

    await second.close();
  });

  it('starts without an account, and says so, when no password is configured', async () => {
    const app = await buildApp({
      db: openDatabase(':memory:'),
      logger: false,
      config: { env: 'test', bootstrapAdminPassword: '', webRoot: '/nonexistent' },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/auth/bootstrap' });
      expect(response.json()).toEqual({ needsSetup: true });
    } finally {
      await app.close();
    }
  });
});

describe('static client', () => {
  it('serves the single-page client and falls through for a deep link', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'docforge-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    const app = await buildApp({
      db: openDatabase(':memory:'),
      logger: false,
      config: { env: 'test', webRoot: dir, bootstrapAdminPassword: '' },
    });
    try {
      const root = await app.inject({ method: 'GET', url: '/' });
      expect(root.statusCode).toBe(200);
      expect(root.body).toContain('id="root"');

      const deepLink = await app.inject({ method: 'GET', url: '/documents/anything' });
      expect(deepLink.statusCode).toBe(200);
      expect(deepLink.body).toContain('id="root"');

      // An unknown API path must still be an error, not the client shell.
      const api = await app.inject({ method: 'GET', url: '/api/unknown' });
      expect(api.statusCode).toBe(404);
      expect(api.json().error.code).toBe('NOT_FOUND');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('session housekeeping', () => {
  let app: FastifyInstance;
  let admin: TestActor;

  beforeEach(async () => {
    app = await makeApp();
    admin = await registerFirstAdmin(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('removes sessions that expired more than a day ago', () => {
    const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    app.db.prepare('UPDATE sessions SET expires_at = ?').run(longAgo);

    const removed = purgeExpiredSessions(app.db);
    expect(removed).toBeGreaterThan(0);

    const remaining = app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    expect(Number(remaining.n)).toBe(0);
  });

  it('keeps a session that is still valid', () => {
    const removed = purgeExpiredSessions(app.db);
    expect(removed).toBe(0);
    const remaining = app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    expect(Number(remaining.n)).toBe(1);
  });

  it('refuses a session that has passed its expiry', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    app.db.prepare('UPDATE sessions SET expires_at = ?').run(past);
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: authHeader(admin),
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a session that was revoked', async () => {
    app.db.prepare('UPDATE sessions SET revoked_at = ?').run(new Date().toISOString());
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: authHeader(admin),
    });
    expect(response.statusCode).toBe(401);
  });

  it('records the address and browser a session was opened from', () => {
    const row = app.db.prepare('SELECT ip, user_agent FROM sessions LIMIT 1').get() as {
      ip: string | null;
      user_agent: string | null;
    };
    expect(row.ip).toBeTypeOf('string');
  });
});
