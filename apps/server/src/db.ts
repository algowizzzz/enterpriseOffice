import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Database = DatabaseSync;

/**
 * Schema migrations, applied in order and recorded in `schema_migrations`.
 * Never edit a migration that has shipped. Append a new one instead.
 */
const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '0001_initial',
    sql: `
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL,
        email_lower   TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
        status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE sessions (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash   TEXT NOT NULL UNIQUE,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        revoked_at   TEXT,
        user_agent   TEXT,
        ip           TEXT
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);

      CREATE TABLE documents (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        content     TEXT NOT NULL,
        origin      TEXT NOT NULL DEFAULT 'blank' CHECK (origin IN ('blank','import')),
        source_name TEXT,
        word_count  INTEGER NOT NULL DEFAULT 0,
        revision    INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        updated_by  TEXT NOT NULL REFERENCES users(id),
        deleted_at  TEXT
      );
      CREATE INDEX idx_documents_owner ON documents(owner_id, deleted_at);
      CREATE INDEX idx_documents_updated ON documents(updated_at DESC);

      CREATE TABLE document_versions (
        id          TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        revision    INTEGER NOT NULL,
        content     TEXT NOT NULL,
        title       TEXT NOT NULL,
        author_id   TEXT NOT NULL REFERENCES users(id),
        created_at  TEXT NOT NULL,
        UNIQUE (document_id, revision)
      );
      CREATE INDEX idx_versions_document ON document_versions(document_id, revision DESC);

      CREATE TABLE document_shares (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission  TEXT NOT NULL CHECK (permission IN ('view','edit')),
        created_at  TEXT NOT NULL,
        created_by  TEXT NOT NULL REFERENCES users(id),
        PRIMARY KEY (document_id, user_id)
      );
      CREATE INDEX idx_shares_user ON document_shares(user_id);

      CREATE TABLE audit_log (
        id          TEXT PRIMARY KEY,
        created_at  TEXT NOT NULL,
        actor_id    TEXT,
        action      TEXT NOT NULL,
        target_type TEXT,
        target_id   TEXT,
        detail      TEXT,
        ip          TEXT
      );
      CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
      CREATE INDEX idx_audit_actor ON audit_log(actor_id, created_at DESC);
    `,
  },
];

export function openDatabase(file: string): Database {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((r) => r.id),
  );
  const record = db.prepare('INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)');
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      record.run(migration.id, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${migration.id} failed: ${(error as Error).message}`);
    }
  }
}

/** Run `fn` inside a transaction, rolling back if it throws. */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
