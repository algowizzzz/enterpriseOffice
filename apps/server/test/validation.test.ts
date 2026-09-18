import { describe, expect, it } from 'vitest';
import { isValidEmail } from '../src/lib/validation.js';
import { makeApp } from './helpers.js';

describe('email validation', () => {
  it('accepts a single-label domain, as used on an air-gapped network', () => {
    // Regression: the built-in Zod email rule rejects these, which locked
    // every installation out of its own seed administrator account.
    expect(isValidEmail('admin@localhost')).toBe(true);
    expect(isValidEmail('someone@intranet')).toBe(true);
    expect(isValidEmail('ops@dc01')).toBe(true);
    // Short but structurally identical to the addresses above, so it is accepted.
    expect(isValidEmail('a@b')).toBe(true);
  });

  it('accepts ordinary internet addresses', () => {
    expect(isValidEmail('ada@example.com')).toBe(true);
    expect(isValidEmail('ada.lovelace+docs@mail.example.co.uk')).toBe(true);
    expect(isValidEmail('  spaced@example.com  ')).toBe(true);
  });

  it('rejects addresses that are malformed', () => {
    for (const value of [
      'no-at-sign',
      '@example.com',
      'user@',
      'user@@example.com',
      'user name@example.com',
      'user@exam ple.com',
      'user@-example.com',
      'user@example-.com',
      'user@.example.com',
      '',
    ]) {
      expect(isValidEmail(value), `${value} should be rejected`).toBe(false);
    }
  });

  it('rejects an address longer than the limit in the mail standard', () => {
    expect(isValidEmail(`${'a'.repeat(250)}@example.com`)).toBe(false);
  });
});

describe('seed administrator', () => {
  it('can sign in with the default single-label address', async () => {
    const app = await makeApp();
    await app.close();

    const seeded = await makeApp();
    try {
      // Rebuild with a bootstrap password so the seed account is created.
      await seeded.close();
    } catch {
      // Ignore: the instance above is only used to prove close works.
    }

    const { buildApp } = await import('../src/app.js');
    const { openDatabase } = await import('../src/db.js');
    const instance = await buildApp({
      db: openDatabase(':memory:'),
      logger: false,
      config: {
        env: 'test',
        loginRateLimit: 1000,
        bootstrapAdminEmail: 'admin@localhost',
        bootstrapAdminPassword: 'Seed-Admin-Pass-1',
        webRoot: '/nonexistent-web-root',
      },
    });
    try {
      const response = await instance.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'admin@localhost', password: 'Seed-Admin-Pass-1' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().user.role).toBe('admin');
    } finally {
      await instance.close();
    }
  });

  it('refuses to start with a bootstrap email that is not valid', async () => {
    const { buildApp } = await import('../src/app.js');
    const { openDatabase } = await import('../src/db.js');
    await expect(
      buildApp({
        db: openDatabase(':memory:'),
        logger: false,
        config: {
          env: 'test',
          bootstrapAdminEmail: 'not an email',
          bootstrapAdminPassword: 'Seed-Admin-Pass-1',
          webRoot: '/nonexistent-web-root',
        },
      }),
    ).rejects.toThrow(/DOCFORGE_ADMIN_EMAIL/u);
  });
});
