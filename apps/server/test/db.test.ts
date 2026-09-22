import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, migrate, transaction, type Database } from '../src/db.js';

const open = (): Database => openDatabase(':memory:');

describe('database', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('creates every table the application needs', () => {
    const db = open();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    for (const table of [
      'users',
      'sessions',
      'documents',
      'document_versions',
      'document_shares',
      'audit_log',
      'schema_migrations',
    ]) {
      expect(names).toContain(table);
    }
    db.close();
  });

  it('records each migration and applies it only once', () => {
    const db = open();
    const before = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(Number(before.n)).toBeGreaterThan(0);

    // Running again must be a no-op rather than an error, because the server
    // migrates on every start.
    migrate(db);
    migrate(db);
    const after = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(Number(after.n)).toBe(Number(before.n));
    db.close();
  });

  it('carries a pre-existing group’s flat prompts and summary into workflow_group_prompts', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, '0011_workflow_groups');
    db.prepare(
      `INSERT INTO users (id, email, email_lower, name, password_hash, role, created_at, updated_at)
       VALUES ('u1', 'a@example.com', 'a@example.com', 'A', 'x', 'admin', 'created-0', 'updated-0')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_groups
         (id, name, description, doc_type, is_default, prompts, output_summary, created_at, updated_at, created_by)
       VALUES ('g1', 'Legacy group', '', NULL, 0, '["First prompt","Second prompt"]', 'Old summary text', 'created-1', 'updated-1', 'u1')`,
    ).run();
    // A group that never had a summary written gets a placeholder, so it
    // satisfies "exactly one summary row" immediately rather than needing
    // the service layer to special-case a group with zero.
    db.prepare(
      `INSERT INTO workflow_groups
         (id, name, description, doc_type, is_default, prompts, output_summary, created_at, updated_at, created_by)
       VALUES ('g2', 'No summary yet', '', NULL, 0, '[]', '', 'created-2', 'updated-2', 'u1')`,
    ).run();

    migrate(db); // Runs the rest, including the data carry-over and the column drop.

    const g1 = db
      .prepare(
        "SELECT role, position, text FROM workflow_group_prompts WHERE group_id = 'g1' ORDER BY role, position",
      )
      .all();
    expect(g1).toEqual([
      { role: 'analysis', position: 0, text: 'First prompt' },
      { role: 'analysis', position: 1, text: 'Second prompt' },
      { role: 'summary', position: 0, text: 'Old summary text' },
    ]);

    const g2 = db.prepare("SELECT role, text FROM workflow_group_prompts WHERE group_id = 'g2'").all();
    expect(g2).toEqual([{ role: 'summary', text: 'Summarise the findings above for the document owner.' }]);

    const columns = (db.prepare('PRAGMA table_info(workflow_groups)').all() as { name: string }[]).map(
      (column) => column.name,
    );
    expect(columns).not.toContain('prompts');
    expect(columns).not.toContain('output_summary');
    db.close();
  });

  it('enforces foreign keys, so an orphan row cannot be written', () => {
    const db = open();
    expect(() =>
      db
        .prepare(
          `INSERT INTO documents (id, owner_id, title, content, word_count, revision, created_at, updated_at, updated_by)
           VALUES ('d1', 'nobody', 't', '{}', 0, 1, 'now', 'now', 'nobody')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it('enforces the role and status checks written into the schema', () => {
    const db = open();
    const insert = (role: string, status: string) =>
      db
        .prepare(
          `INSERT INTO users (id, email, email_lower, name, password_hash, role, status, created_at, updated_at)
           VALUES (?, ?, ?, 'n', 'h', ?, ?, 'now', 'now')`,
        )
        .run(`id-${role}-${status}`, `${role}@x`, `${role}@x`, role, status);
    expect(() => insert('superuser', 'active')).toThrow();
    expect(() => insert('editor', 'pending')).toThrow();
    expect(() => insert('editor', 'active')).not.toThrow();
    db.close();
  });

  it('rejects a second account with the same normalised email', () => {
    const db = open();
    const insert = (id: string, lower: string) =>
      db
        .prepare(
          `INSERT INTO users (id, email, email_lower, name, password_hash, role, status, created_at, updated_at)
           VALUES (?, ?, ?, 'n', 'h', 'editor', 'active', 'now', 'now')`,
        )
        .run(id, lower, lower);
    insert('a', 'same@example.com');
    expect(() => insert('b', 'same@example.com')).toThrow();
    db.close();
  });

  it('commits the work inside a successful transaction', () => {
    const db = open();
    const result = transaction(db, () => {
      db.prepare(
        `INSERT INTO users (id, email, email_lower, name, password_hash, role, status, created_at, updated_at)
         VALUES ('t1', 'a@b', 'a@b', 'n', 'h', 'editor', 'active', 'now', 'now')`,
      ).run();
      return 'done';
    });
    expect(result).toBe('done');
    const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(Number(row.n)).toBe(1);
    db.close();
  });

  it('rolls the work back when the transaction throws', () => {
    const db = open();
    expect(() =>
      transaction(db, () => {
        db.prepare(
          `INSERT INTO users (id, email, email_lower, name, password_hash, role, status, created_at, updated_at)
           VALUES ('t1', 'a@b', 'a@b', 'n', 'h', 'editor', 'active', 'now', 'now')`,
        ).run();
        throw new Error('something went wrong halfway');
      }),
    ).toThrow('something went wrong halfway');

    const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(Number(row.n)).toBe(0);
    db.close();
  });

  it('creates the directory for a database file that does not exist yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docforge-db-'));
    dirs.push(dir);
    const file = join(dir, 'nested', 'deeper', 'docforge.db');
    const db = openDatabase(file);
    expect(existsSync(file)).toBe(true);
    db.close();
  });

  it('reopens an existing file without losing its rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docforge-db-'));
    dirs.push(dir);
    const file = join(dir, 'docforge.db');

    const first = openDatabase(file);
    first
      .prepare(
        `INSERT INTO users (id, email, email_lower, name, password_hash, role, status, created_at, updated_at)
         VALUES ('keep', 'a@b', 'a@b', 'Kept', 'h', 'admin', 'active', 'now', 'now')`,
      )
      .run();
    first.close();

    const second = openDatabase(file);
    const row = second.prepare('SELECT name FROM users WHERE id = ?').get('keep') as
      | { name: string }
      | undefined;
    expect(row?.name).toBe('Kept');
    second.close();
  });

  it('reports which migration failed rather than a bare error', () => {
    const db = open();
    // Forget that the first migration ran, so it is applied a second time and
    // collides with the tables that already exist.
    db.prepare('DELETE FROM schema_migrations').run();
    expect(() => migrate(db)).toThrow(/Migration 0001_initial failed/u);
    db.close();
  });
});

describe('the clock the records are stamped with', () => {
  it('never hands out the same moment twice', async () => {
    // Regression: two documents created in the same millisecond carried the
    // same time, so the list put them in whichever order the identifiers
    // happened to fall in, and editing one did not reliably move it to the top.
    const { now } = await import('../src/lib/ids.js');
    const stamps = Array.from({ length: 200 }, () => now());
    expect(new Set(stamps).size).toBe(stamps.length);
    expect([...stamps].sort()).toEqual(stamps);
  });
});
