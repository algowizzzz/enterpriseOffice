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
  {
    // The running header, the running footer and the orientation of the page.
    // They arrive in an uploaded Word file and have to leave in the exported
    // one, and they are not content, so they sit beside the document.
    id: '0002_page_setup',
    sql: `ALTER TABLE documents ADD COLUMN page_setup TEXT NOT NULL DEFAULT '{}';`,
  },
  {
    // The file a document was uploaded as, byte for byte, and what the reader
    // kept from it: the markup it holds by reference, the styles resolved for
    // drawing, and the page setup as it was read. The export patches this file
    // rather than building a new one, which is what keeps a letterhead, a chart
    // or a corporate style sheet through a round trip. It is also the
    // "original" that can be downloaded again at any time. One row per
    // document and never rewritten, so it sits outside the versions table.
    id: '0003_document_sources',
    sql: `
      CREATE TABLE document_sources (
        document_id   TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        file_name     TEXT NOT NULL,
        media_type    TEXT NOT NULL,
        bytes         BLOB NOT NULL,
        package       BLOB,
        fragments     TEXT NOT NULL DEFAULT '{}',
        styles        TEXT NOT NULL DEFAULT '{}',
        page_setup    TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL
      );
    `,
  },
  {
    // Comments sit beside the document, not in it. See CommentAnchor in the
    // model for why: a comment must not be an edit. A reply names its parent;
    // only the first comment of a thread has an anchor or can be resolved.
    // `author_name` is what the comment is signed with: the account's name, or
    // for a comment that arrived in a Word file, the name Word recorded, which
    // belongs to nobody here.
    id: '0004_comments',
    sql: `
      CREATE TABLE comments (
        id           TEXT PRIMARY KEY,
        document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        parent_id    TEXT REFERENCES comments(id) ON DELETE CASCADE,
        author_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
        author_name  TEXT NOT NULL,
        body         TEXT NOT NULL,
        anchor       TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        resolved_at  TEXT,
        resolved_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
        deleted_at   TEXT
      );
      CREATE INDEX idx_comments_document ON comments(document_id, created_at);
    `,
  },
  {
    // The shared (CRDT) form of a document that people have open together.
    //
    // `state` is the whole shared document, so somebody who was offline can
    // reconnect after a restart and have their changes merged rather than
    // duplicated. It only means anything while the stored content has not been
    // replaced behind its back: `revision` says which revision it matches, and
    // `epoch` is bumped whenever the shared document is started afresh (a
    // version was restored, or content was written by something that is not the
    // editor). A browser still holding an older epoch is told to reload instead
    // of merging its history into a document that no longer shares it.
    id: '0005_document_collab',
    sql: `
      CREATE TABLE document_collab (
        document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        epoch       INTEGER NOT NULL DEFAULT 1,
        revision    INTEGER NOT NULL DEFAULT 0,
        state       BLOB,
        updated_at  TEXT NOT NULL
      );
    `,
  },
  {
    // What kind of controlled document this is: a framework, a policy, a
    // standard, a procedure. Chosen at upload and shown beside the name.
    id: '0006_document_type',
    sql: `ALTER TABLE documents ADD COLUMN doc_type TEXT;`,
  },
  {
    // A locked document can be read and commented on and not changed, by
    // anybody, until its owner unlocks it: what Word calls restricting editing
    // to comments. It is how a document is held still while it is approved.
    id: '0007_document_lock',
    sql: `ALTER TABLE documents ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    // Asking for access, and being answered. With accounts made by hand there is
    // no directory to look somebody up in, so the request has to be able to
    // arrive from somebody with no account at all: `user_id` is null for those,
    // and `document_id` is null for a request for an account rather than for a
    // document. Requests are answered, never deleted, so that who let whom in
    // stays on the record.
    id: '0008_access_requests',
    sql: `
      CREATE TABLE access_requests (
        id           TEXT PRIMARY KEY,
        document_id  TEXT REFERENCES documents(id) ON DELETE CASCADE,
        user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        email        TEXT NOT NULL,
        wanted       TEXT NOT NULL CHECK (wanted IN ('account','view','edit')),
        note         TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
        created_at   TEXT NOT NULL,
        decided_at   TEXT,
        decided_by   TEXT REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_access_requests_open ON access_requests(status, document_id);
    `,
  },
  {
    // Words somebody has told the spell check are right: a surname, a product,
    // a term of art. Theirs, and with them wherever they sign in.
    id: '0009_user_words',
    sql: `
      CREATE TABLE user_words (
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        word       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, word)
      );
    `,
  },
  {
    // Pictures, kept beside the document they belong to rather than inside its
    // text, under a hash of their bytes. A document with forty megabytes of
    // pictures used to be forty megabytes of JSON on every save, and the editor
    // capped what it would show at eight to stay usable. Rows go when the
    // document goes; they are never removed while it exists, because an earlier
    // version may still show the picture.
    id: '0010_document_media',
    sql: `
      CREATE TABLE document_media (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        hash        TEXT NOT NULL,
        media_type  TEXT NOT NULL,
        bytes       BLOB NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (document_id, hash)
      );
      CREATE INDEX idx_document_media_hash ON document_media(hash);
    `,
  },
  {
    // A workflow group names a set of prompts an administrator has written
    // for one kind of document, plus what the group's output is meant to add
    // up to. This is configuration, not a running assistant: nothing here
    // calls a model. It is the shape ready for that to be wired in later,
    // the same way page_setup was carried on documents before there was
    // anything to change it beyond the header and footer. `prompts` is a
    // JSON array of plain strings, the same pattern as `fragments` and
    // `styles` on document_sources: an ordered list that is only ever read
    // and replaced whole, never queried by its contents, so a child table
    // would only add a join nothing here needs.
    id: '0011_workflow_groups',
    sql: `
      CREATE TABLE workflow_groups (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        description    TEXT NOT NULL DEFAULT '',
        doc_type       TEXT,
        is_default     INTEGER NOT NULL DEFAULT 0,
        prompts        TEXT NOT NULL DEFAULT '[]',
        output_summary TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        created_by     TEXT NOT NULL REFERENCES users(id)
      );
      CREATE INDEX idx_workflow_groups_doc_type ON workflow_groups(doc_type);
    `,
  },
  {
    // Where a future AI feature is allowed to send a document or a prompt.
    // Registering a row here is the one thing in this product that turns on
    // an outbound network call; see docs/16-ai-integration.md §7. `url`'s
    // host is checked at the service layer against a private-network address
    // only, never the public internet (decided 2026-09-22, see §12).
    // `auth_secret` is encrypted at rest (lib/crypto.ts) with a key generated
    // once per installation (lib/secretKey.ts) and is never read back out
    // through the API. `auth_header_name` is only meaningful when
    // `auth_scheme` is `header`. `request_format` is a one-value enum today
    // because only an OpenAI-compatible chat/completions body is written;
    // it stays a CHECK constraint, the same shape `doc_type` and `role`
    // already use, so widening it later is one migration, not a rewrite.
    id: '0012_llm_endpoints',
    sql: `
      CREATE TABLE llm_endpoints (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        url              TEXT NOT NULL,
        auth_scheme      TEXT NOT NULL DEFAULT 'none' CHECK (auth_scheme IN ('none','bearer','header')),
        auth_header_name TEXT,
        auth_secret      TEXT,
        request_format   TEXT NOT NULL DEFAULT 'openai-chat' CHECK (request_format IN ('openai-chat')),
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        created_by       TEXT NOT NULL REFERENCES users(id)
      );
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
