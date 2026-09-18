import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  importRateLimit: number;
  exportRateLimit: number;
  bootstrapAdminEmail: string;
  bootstrapAdminPassword: string;
}

/**
 * Where the built client is, when nobody has said.
 *
 * The default used to be `../web/dist` from the working directory, which is
 * right from `apps/server` and wrong from everywhere else. The documented way
 * to run the build is `npm start` from the repository root, where that path
 * points outside the repository: the server started, answered its health check
 * and served a 404 for the page. Every deployment set `DOCFORGE_WEB_ROOT`, so
 * only the person following the instructions for the first time ever saw it.
 *
 * So look where a client could actually be, relative to this file as well as to
 * the working directory, and take the first that holds a page:
 *
 *   beside the bundle      /opt/docforge/server.mjs  and  /opt/docforge/web
 *   in the repository      apps/server/dist/server.mjs  and  apps/web/dist
 *   from the source tree   apps/server/src/config.ts    and  apps/web/dist
 */
export function findWebRoot(cwd = process.cwd(), here = dirname(fileURLToPath(import.meta.url))): string {
  const candidates = [
    join(here, 'web'),
    join(here, '../../web/dist'),
    resolve(cwd, 'apps/web/dist'),
    resolve(cwd, '../web/dist'),
    resolve(cwd, 'web'),
  ];
  // Nothing found is not an error: the API is usable without the client, and
  // `app.ts` already copes with a web root that is not there.
  return candidates.find((path) => existsSync(join(path, 'index.html'))) ?? resolve(cwd, '../web/dist');
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = (process.env['NODE_ENV'] as Config['env']) ?? 'development';
  return {
    env,
    // Loopback unless told otherwise. The default was every interface, so a
    // build started on a laptop to try it out was also offered to the whole
    // network it happened to be on. Each deployment shape states its own host:
    // the container and the systemd unit say 0.0.0.0, behind a proxy.
    host: process.env['DOCFORGE_HOST'] ?? '127.0.0.1',
    port: int('DOCFORGE_PORT', 8080),
    databaseFile: process.env['DOCFORGE_DB'] ?? resolve(process.cwd(), 'data/docforge.db'),
    webRoot: process.env['DOCFORGE_WEB_ROOT'] ?? findWebRoot(),
    maxUploadBytes: int('DOCFORGE_MAX_UPLOAD_BYTES', 25 * 1024 * 1024),
    sessionTtlSeconds: int('DOCFORGE_SESSION_TTL', 12 * 60 * 60),
    secureCookies: bool('DOCFORGE_SECURE_COOKIES', env === 'production'),
    loginRateLimit: int('DOCFORGE_LOGIN_RATE_LIMIT', 10),
    // Converting and writing a Word file are both CPU bound and hold the
    // single-threaded server while they run, so both are limited. A bulk
    // migration or a fidelity run needs the limits raised deliberately.
    importRateLimit: int('DOCFORGE_IMPORT_RATE_LIMIT', 20),
    exportRateLimit: int('DOCFORGE_EXPORT_RATE_LIMIT', 30),
    trustProxy: bool('DOCFORGE_TRUST_PROXY', false),
    bootstrapAdminEmail: process.env['DOCFORGE_ADMIN_EMAIL'] ?? 'admin@localhost',
    bootstrapAdminPassword: process.env['DOCFORGE_ADMIN_PASSWORD'] ?? '',
    ...overrides,
  };
}
