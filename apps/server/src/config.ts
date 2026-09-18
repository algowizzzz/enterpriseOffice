import { resolve } from 'node:path';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export interface Config {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  databaseFile: string;
  /** Directory holding the built web client. Served only when it exists. */
  webRoot: string;
  /** Maximum accepted upload size in bytes. */
  maxUploadBytes: number;
  sessionTtlSeconds: number;
  /** Secure cookie flag. Off by default outside production so plain HTTP works on a laptop. */
  secureCookies: boolean;
  /** Login attempts allowed per IP per minute. */
  loginRateLimit: number;
  /**
   * Whether to believe `X-Forwarded-For`. Off unless a trusted reverse proxy
   * sets it: with nothing in front of the server the header is supplied by
   * whoever is connecting, which would let them pick a new rate-limit bucket
   * for every sign-in attempt and write any address they like into the audit
   * trail.
   */
  trustProxy: boolean;
  /** Seed administrator, created on first start when the user table is empty. */
  bootstrapAdminEmail: string;
  bootstrapAdminPassword: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = (process.env['NODE_ENV'] as Config['env']) ?? 'development';
  return {
    env,
    host: process.env['DOCFORGE_HOST'] ?? '0.0.0.0',
    port: int('DOCFORGE_PORT', 8080),
    databaseFile: process.env['DOCFORGE_DB'] ?? resolve(process.cwd(), 'data/docforge.db'),
    webRoot: process.env['DOCFORGE_WEB_ROOT'] ?? resolve(process.cwd(), '../web/dist'),
    maxUploadBytes: int('DOCFORGE_MAX_UPLOAD_BYTES', 25 * 1024 * 1024),
    sessionTtlSeconds: int('DOCFORGE_SESSION_TTL', 12 * 60 * 60),
    secureCookies: bool('DOCFORGE_SECURE_COOKIES', env === 'production'),
    loginRateLimit: int('DOCFORGE_LOGIN_RATE_LIMIT', 10),
    trustProxy: bool('DOCFORGE_TRUST_PROXY', false),
    bootstrapAdminEmail: process.env['DOCFORGE_ADMIN_EMAIL'] ?? 'admin@localhost',
    bootstrapAdminPassword: process.env['DOCFORGE_ADMIN_PASSWORD'] ?? '',
    ...overrides,
  };
}
