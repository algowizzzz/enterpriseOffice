import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { htmlToDocument } from '../src/docx/import.js';
import { toPlainText } from '@docforge/model';
import { authHeader, makeApp, registerFirstAdmin } from './helpers.js';

const text = (html: string): string => toPlainText(htmlToDocument(html).content);

describe('entity decoding', () => {
  it('decodes each entity exactly once', () => {
    // Regression: the decoder ran its replacements in sequence, so mammoth's
    // escaping of a literal "&lt;" was undone twice and the text somebody wrote
    // was replaced by the character it names.
    expect(text('<p>&amp;lt;</p>')).toBe('&lt;');
    expect(text('<p>&amp;gt;</p>')).toBe('&gt;');
    expect(text('<p>&amp;amp;</p>')).toBe('&amp;');
    expect(text('<p>&amp;#65;</p>')).toBe('&#65;');
    expect(text('<p>&amp;nbsp;</p>')).toBe('&nbsp;');
  });

  it('still decodes an ordinary entity', () => {
    expect(text('<p>a &amp; b</p>')).toBe('a & b');
    expect(text('<p>&lt;tag&gt;</p>')).toBe('<tag>');
    expect(text('<p>&quot;quoted&quot;</p>')).toBe('"quoted"');
    expect(text('<p>&apos;</p>')).toBe("'");
    expect(text('<p>a&nbsp;b</p>')).toBe('a b');
    expect(text('<p>&#65;&#x42;</p>')).toBe('AB');
  });

  it('survives a code point outside the Unicode range', () => {
    // This used to throw out of the importer and surface as an opaque server
    // error for a file the person could do nothing about.
    expect(() => text('<p>&#99999999;</p>')).not.toThrow();
    expect(() => text('<p>&#xFFFFFFF;</p>')).not.toThrow();
    expect(text('<p>ok&#99999999;here</p>')).toBe('okhere');
  });

  it('drops a lone surrogate rather than storing a broken character', () => {
    expect(text('<p>a&#55296;b</p>')).toBe('ab');
    expect(text('<p>a&#xD800;b</p>')).toBe('ab');
  });

  it('keeps an entity it does not know', () => {
    expect(text('<p>&copy; 2026</p>')).toBe('&copy; 2026');
  });

  it('decodes a character outside the basic plane', () => {
    expect(text('<p>&#128640;</p>')).toBe('\u{1F680}');
  });
});

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
