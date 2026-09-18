import type { Database } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { transaction } from '../db.js';
import { hashToken, newId, now } from '../lib/ids.js';
import { hashPassword } from '../lib/password.js';

export type Role = 'admin' | 'editor' | 'viewer';
export type UserStatus = 'active' | 'disabled';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

interface UserRow extends Record<string, unknown> {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  status: UserStatus;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastLoginAt: row.last_login_at,
});

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export function findUserByEmail(db: Database, email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email_lower = ?').get(normalizeEmail(email)) as
    | UserRow
    | undefined;
}

export function findUserById(db: Database, id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function getUser(db: Database, id: string): User {
  const row = findUserById(db, id);
  if (!row) throw notFound('User not found');
  return toUser(row);
}

export function countUsers(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  return Number(row.n);
}

export interface CreateUserInput {
  email: string;
  name: string;
  password: string;
  role: Role;
}

/**
 * Create the very first account, and only if there is still none.
 *
 * The password hash is computed before the transaction, because hashing takes
 * about a tenth of a second and the check and the insert must not be separated
 * by anything that yields. Registering twice at the same moment used to let
 * both requests see an empty user table and both become administrators.
 */
export async function createFirstAdmin(db: Database, input: CreateUserInput): Promise<User | null> {
  const hash = await hashPassword(input.password);
  return transaction(db, () => {
    if (countUsers(db) > 0) return null;
    return insertUser(db, input, hash);
  });
}

export async function createUser(db: Database, input: CreateUserInput): Promise<User> {
  // Hash before the transaction, then check and insert together. Hashing yields
  // for about a tenth of a second, and two administrators adding the same
  // address inside that window both passed the check; the second insert then
  // broke the unique constraint and surfaced as an opaque server error instead
  // of saying the account already exists.
  const hash = await hashPassword(input.password);
  return transaction(db, () => insertUser(db, input, hash));
}

function insertUser(db: Database, input: CreateUserInput, hash: string): User {
  const email = input.email.trim();
  const lower = normalizeEmail(email);
  if (findUserByEmail(db, lower)) throw conflict('An account with that email already exists');
  const timestamp = now();
  const user: UserRow = {
    id: newId(),
    email,
    name: input.name.trim(),
    password_hash: hash,
    role: input.role,
    status: 'active',
    created_at: timestamp,
    updated_at: timestamp,
    last_login_at: null,
  };
  db.prepare(
    `INSERT INTO users (id, email, email_lower, name, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    user.id,
    user.email,
    lower,
    user.name,
    user.password_hash,
    user.role,
    user.status,
    user.created_at,
    user.updated_at,
  );
  return toUser(user);
}

export function listUsers(db: Database): User[] {
  const rows = db
    .prepare('SELECT * FROM users ORDER BY created_at ASC, id ASC')
    .all() as UserRow[];
  return rows.map(toUser);
}

export interface UpdateUserInput {
  name?: string;
  role?: Role;
  status?: UserStatus;
}

export function updateUser(db: Database, id: string, patch: UpdateUserInput): User {
  const existing = findUserById(db, id);
  if (!existing) throw notFound('User not found');
  const next = {
    name: patch.name?.trim() ?? existing.name,
    role: patch.role ?? existing.role,
    status: patch.status ?? existing.status,
  };
  db.prepare('UPDATE users SET name = ?, role = ?, status = ?, updated_at = ? WHERE id = ?').run(
    next.name,
    next.role,
    next.status,
    now(),
    id,
  );
  if (next.status === 'disabled') revokeAllSessions(db, id);
  return getUser(db, id);
}

export async function setPassword(db: Database, id: string, password: string): Promise<void> {
  const existing = findUserById(db, id);
  if (!existing) throw notFound('User not found');
  const hash = await hashPassword(password);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    hash,
    now(),
    id,
  );
}

export function markLogin(db: Database, id: string): void {
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), id);
}

export function revokeAllSessions(db: Database, userId: string): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
    now(),
    userId,
  );
}

/**
 * End every session for an account except the one asking.
 *
 * Changing your own password should sign out your other devices, not you. The
 * blanket version revoked the caller's session too, so the page it was typed
 * into was signed out on its next request.
 */
export function revokeOtherSessions(db: Database, userId: string, keepToken: string): void {
  db.prepare(
    `UPDATE sessions SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL AND token_hash != ?`,
  ).run(now(), userId, hashToken(keepToken));
}

/** Admins are the only role that can manage users, so never allow the last one to be lost. */
export function countActiveAdmins(db: Database, excludeId?: string): number {
  const row = excludeId
    ? (db
        .prepare(
          "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id != ?",
        )
        .get(excludeId) as { n: number })
    : (db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'")
        .get() as { n: number });
  return Number(row.n);
}

export { toUser };
