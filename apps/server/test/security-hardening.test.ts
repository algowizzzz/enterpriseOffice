import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { authHeader, makeApp, registerFirstAdmin } from './helpers.js';

describe('forwarded addresses', () => {
  it('is not trusted by default', () => {
    expect(loadConfig({ env: 'test' }).trustProxy).toBe(false);
  });

  let app: FastifyInstance;

  beforeEach(async () => {
    app = await makeApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('records the address the request actually came from', async () => {
    const admin = await registerFirstAdmin(app);
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'Wrong-Password-1' },
      remoteAddress: '198.51.100.7',
      headers: { 'x-forwarded-for': '203.0.113.99' },
    });

    const entries = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: authHeader(admin),
    });
    const failure = (entries.json().entries as { action: string; ip: string | null }[]).find(
      (entry) => entry.action === 'user.login_failed',
    );
    // A forged header must not be able to write whatever it likes into the trail.
    expect(failure?.ip).toBe('198.51.100.7');
  });

  it('cannot be used to escape the sign-in rate limit', async () => {
    const limited = await buildApp({
      db: openDatabase(':memory:'),
      logger: false,
      config: { env: 'test', loginRateLimit: 3, bootstrapAdminPassword: '', webRoot: '/nonexistent' },
    });
    try {
      await registerFirstAdmin(limited);
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const response = await limited.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: 'admin@example.com', password: 'Wrong-Password-1' },
          remoteAddress: '198.51.100.7',
          // A different forwarded address each time, which is exactly how an
          // attacker would try to get a fresh bucket for every guess.
          headers: { 'x-forwarded-for': `203.0.113.${attempt}` },
        });
        statuses.push(response.statusCode);
      }
      expect(statuses).toContain(429);
    } finally {
      await limited.close();
    }
  });

  it('believes the header when a proxy is declared', async () => {
    const proxied = await buildApp({
      db: openDatabase(':memory:'),
      logger: false,
      config: {
        env: 'test',
        loginRateLimit: 1000,
        trustProxy: true,
        bootstrapAdminPassword: '',
        webRoot: '/nonexistent',
      },
    });
    try {
      const admin = await registerFirstAdmin(proxied);
      await proxied.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'admin@example.com', password: 'Wrong-Password-1' },
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '203.0.113.42' },
      });
      const entries = await proxied.inject({
        method: 'GET',
        url: '/api/audit',
        headers: authHeader(admin),
      });
      const failure = (entries.json().entries as { action: string; ip: string | null }[]).find(
        (entry) => entry.action === 'user.login_failed',
      );
      expect(failure?.ip).toBe('203.0.113.42');
    } finally {
      await proxied.close();
    }
  });
});
