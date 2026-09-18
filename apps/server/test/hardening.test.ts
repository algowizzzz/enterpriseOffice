import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createFirstAdmin, listUsers } from '../src/services/users.js';
import { authHeader, makeApp, registerFirstAdmin } from './helpers.js';

describe('the first account', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({
      db: openDatabase(':memory:'),
      logger: false,
      config: { env: 'test', loginRateLimit: 1000, bootstrapAdminPassword: '', webRoot: '/nonexistent' },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('is created when the instance is empty', async () => {
    const user = await createFirstAdmin(app.db, {
      email: 'first@localhost',
      name: 'First',
      password: 'Correct-Horse-9',
      role: 'admin',
    });
    expect(user?.role).toBe('admin');
  });

  it('is refused once an account exists', async () => {
    await createFirstAdmin(app.db, {
      email: 'first@localhost',
      name: 'First',
      password: 'Correct-Horse-9',
      role: 'admin',
    });
    const second = await createFirstAdmin(app.db, {
      email: 'second@localhost',
      name: 'Second',
      password: 'Correct-Horse-9',
      role: 'admin',
    });
    expect(second).toBeNull();
    expect(listUsers(app.db)).toHaveLength(1);
  });

  it('cannot be created twice by two requests arriving together', async () => {
    // Regression: hashing a password takes long enough that both requests saw an
    // empty instance, and an installation ended up with two administrators
    // neither of whom expected the other.
    const responses = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: {
            email: `racer${n}@localhost`,
            name: `Racer ${n}`,
            password: 'Correct-Horse-9',
          },
        }),
      ),
    );

    const created = responses.filter((response) => response.statusCode === 201);
    expect(created).toHaveLength(1);
    expect(listUsers(app.db)).toHaveLength(1);
    for (const response of responses.filter((r) => r.statusCode !== 201)) {
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toMatch(/Registration is closed/u);
    }
  });
});

describe('changing your own password', () => {
  it('is rate limited, because it is a guessing target too', async () => {
    const app = await buildApp({
      db: openDatabase(':memory:'),
      logger: false,
      config: { env: 'test', loginRateLimit: 3, bootstrapAdminPassword: '', webRoot: '/nonexistent' },
    });
    try {
      const admin = await registerFirstAdmin(app);
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/password',
          headers: authHeader(admin),
          payload: { currentPassword: 'Wrong-Guess-1', newPassword: 'Another-Horse-42' },
          remoteAddress: '198.51.100.9',
        });
        statuses.push(response.statusCode);
      }
      expect(statuses).toContain(429);
    } finally {
      await app.close();
    }
  });
});

describe('uploading is limited even for a signed-in person', () => {
  it('refuses a burst of conversions', async () => {
    const app = await makeApp();
    try {
      const admin = await registerFirstAdmin(app);
      const boundary = '----burst';
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.docx"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const statuses: number[] = [];
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/documents/import',
          headers: { ...authHeader(admin), 'content-type': `multipart/form-data; boundary=${boundary}` },
          payload,
          remoteAddress: '198.51.100.11',
        });
        statuses.push(response.statusCode);
      }
      // Converting a Word file holds the single-threaded server while it runs.
      expect(statuses).toContain(429);
    } finally {
      await app.close();
    }
  });
});
