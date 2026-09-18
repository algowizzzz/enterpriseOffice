import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const KEYS = [
  'NODE_ENV',
  'DOCFORGE_HOST',
  'DOCFORGE_PORT',
  'DOCFORGE_DB',
  'DOCFORGE_WEB_ROOT',
  'DOCFORGE_MAX_UPLOAD_BYTES',
  'DOCFORGE_SESSION_TTL',
  'DOCFORGE_SECURE_COOKIES',
  'DOCFORGE_LOGIN_RATE_LIMIT',
  'DOCFORGE_ADMIN_EMAIL',
  'DOCFORGE_ADMIN_PASSWORD',
] as const;

describe('configuration', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('uses safe defaults when nothing is set', () => {
    const config = loadConfig();
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.sessionTtlSeconds).toBe(12 * 60 * 60);
    expect(config.maxUploadBytes).toBe(25 * 1024 * 1024);
    expect(config.loginRateLimit).toBe(10);
    expect(config.bootstrapAdminEmail).toBe('admin@localhost');
  });

  it('never invents a seed administrator password', () => {
    // An installation with a guessable default credential would be worse than
    // one that refuses to create an account at all.
    expect(loadConfig().bootstrapAdminPassword).toBe('');
  });

  it('reads numeric settings from the environment', () => {
    process.env['DOCFORGE_PORT'] = '9999';
    process.env['DOCFORGE_SESSION_TTL'] = '60';
    process.env['DOCFORGE_MAX_UPLOAD_BYTES'] = '1024';
    const config = loadConfig();
    expect(config.port).toBe(9999);
    expect(config.sessionTtlSeconds).toBe(60);
    expect(config.maxUploadBytes).toBe(1024);
  });

  it('refuses a numeric setting that is not a number', () => {
    process.env['DOCFORGE_PORT'] = 'eight thousand';
    expect(() => loadConfig()).toThrow(/DOCFORGE_PORT must be an integer/u);
  });

  it('treats an empty value as unset rather than as zero', () => {
    process.env['DOCFORGE_PORT'] = '';
    expect(loadConfig().port).toBe(8080);
  });

  it('reads boolean settings in the forms people actually write', () => {
    for (const truthy of ['1', 'true', 'TRUE', 'True']) {
      process.env['DOCFORGE_SECURE_COOKIES'] = truthy;
      expect(loadConfig().secureCookies, truthy).toBe(true);
    }
    for (const falsy of ['0', 'false', 'no', 'anything else']) {
      process.env['DOCFORGE_SECURE_COOKIES'] = falsy;
      expect(loadConfig().secureCookies, falsy).toBe(false);
    }
  });

  it('marks cookies secure by default in production only', () => {
    process.env['NODE_ENV'] = 'production';
    expect(loadConfig().secureCookies).toBe(true);
    process.env['NODE_ENV'] = 'development';
    expect(loadConfig().secureCookies).toBe(false);
  });

  it('lets an explicit setting override the production default', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DOCFORGE_SECURE_COOKIES'] = '0';
    expect(loadConfig().secureCookies).toBe(false);
  });

  it('resolves the database path to an absolute location', () => {
    expect(loadConfig().databaseFile.startsWith('/')).toBe(true);
  });

  it('lets a caller override any field, which is how the tests run', () => {
    const config = loadConfig({ port: 1234, env: 'test', bootstrapAdminEmail: 'a@b' });
    expect(config.port).toBe(1234);
    expect(config.env).toBe('test');
    expect(config.bootstrapAdminEmail).toBe('a@b');
  });
});
