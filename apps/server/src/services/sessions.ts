import type { Database } from '../db.js';
import { newId, newToken, hashToken, now } from '../lib/ids.js';
import type { User } from './users.js';
import { findUserById, toUser } from './users.js';

export interface IssuedSession {
  token: string;
  expiresAt: string;
}

export function createSession(
  db: Database,
  userId: string,
  ttlSeconds: number,
  meta: { userAgent?: string; ip?: string } = {},
): IssuedSession {
  const token = newToken();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId(), userId, hashToken(token), now(), expiresAt, meta.userAgent ?? null, meta.ip ?? null);
  return { token, expiresAt };
}

/** Returns the session's user, or undefined when the token is unknown, revoked or expired. */
export function resolveSession(db: Database, token: string): User | undefined {
  const row = db
    .prepare('SELECT user_id, expires_at, revoked_at FROM sessions WHERE token_hash = ?')
    .get(hashToken(token)) as
    | { user_id: string; expires_at: string; revoked_at: string | null }
    | undefined;
  if (!row || row.revoked_at !== null) return undefined;
  if (Date.parse(row.expires_at) <= Date.now()) return undefined;
  const user = findUserById(db, row.user_id);
  if (!user || user.status !== 'active') return undefined;
  return toUser(user);
}

export function revokeSession(db: Database, token: string): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(
    now(),
    hashToken(token),
  );
}

/** Housekeeping: drop sessions that expired more than a day ago. */
export function purgeExpiredSessions(db: Database): number {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(cutoff);
  return Number(result.changes);
}
