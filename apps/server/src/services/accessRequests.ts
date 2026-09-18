import type { Database } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { newId, now } from '../lib/ids.js';
import { accessFor, shareDocument } from './documents.js';
import type { Role } from './users.js';

export interface AccessRequest {
  id: string;
  documentId: string | null;
  documentTitle: string | null;
  userId: string | null;
  name: string;
  email: string;
  wanted: 'account' | 'view' | 'edit';
  note: string;
  status: 'pending' | 'approved' | 'declined';
  createdAt: string;
}

type Actor = { id: string; role: Role; name: string; email: string };
const MAX_OPEN = 200;

const clean = (raw: unknown, limit: number): string =>
  (typeof raw === 'string' ? raw : '').replace(/[\r\n\t]+/gu, ' ').trim().slice(0, limit);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const toRequest = (row: Record<string, unknown>): AccessRequest => ({
  id: String(row['id']),
  documentId: (row['document_id'] as string | null) ?? null,
  documentTitle: (row['title'] as string | null) ?? null,
  userId: (row['user_id'] as string | null) ?? null,
  name: String(row['name']),
  email: String(row['email']),
  wanted: row['wanted'] as AccessRequest['wanted'],
  note: text(row['note']),
  status: row['status'] as AccessRequest['status'],
  createdAt: String(row['created_at']),
});

/**
 * Somebody with no account asks for one. Nothing is created and nothing is
 * confirmed or denied about who already has an account: an administrator reads
 * the request and makes the account by hand, as they make every account.
 */
export function requestAccount(db: Database, input: { name: unknown; email: unknown; note: unknown }): void {
  const name = clean(input.name, 120);
  const email = clean(input.email, 254).toLowerCase();
  if (name.length === 0 || !/^[^@\s]+@[^@\s]+$/u.test(email)) throw badRequest('Give your name and a valid email address');
  const open = db.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE status = 'pending' AND wanted = 'account'").get() as { n: number };
  // A form anybody can reach must not be a way to fill the database.
  if (Number(open.n) >= MAX_OPEN) return;
  const already = db
    .prepare("SELECT id FROM access_requests WHERE status = 'pending' AND wanted = 'account' AND email = ?")
    .get(email);
  if (already) return;
  db.prepare(
    `INSERT INTO access_requests (id, document_id, user_id, name, email, wanted, note, status, created_at)
     VALUES (?, NULL, NULL, ?, ?, 'account', ?, 'pending', ?)`,
  ).run(newId(), name, email, clean(input.note, 500), now());
}

/** Somebody who can read a document asks its owner to be allowed to edit it. */
export function requestDocumentAccess(db: Database, actor: Actor, documentId: string, note: unknown): void {
  const access = accessFor(db, documentId, actor);
  if (access === 'none') throw notFound('Document not found');
  if (access === 'owner' || access === 'edit') throw badRequest('You can already edit this document');
  const already = db
    .prepare("SELECT id FROM access_requests WHERE status = 'pending' AND document_id = ? AND user_id = ?")
    .get(documentId, actor.id);
  if (already) return;
  db.prepare(
    `INSERT INTO access_requests (id, document_id, user_id, name, email, wanted, note, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'edit', ?, 'pending', ?)`,
  ).run(newId(), documentId, actor.id, actor.name, actor.email, clean(note, 500), now());
}

/** Open requests this person can answer: for their documents, and for accounts if they are an administrator. */
export function listOpenRequests(db: Database, actor: Actor): AccessRequest[] {
  const rows = db
    .prepare(
      `SELECT r.*, d.title FROM access_requests r LEFT JOIN documents d ON d.id = r.document_id
        WHERE r.status = 'pending' AND ((r.document_id IS NOT NULL AND d.owner_id = ? AND d.deleted_at IS NULL) OR (r.document_id IS NULL AND ? = 'admin'))
        ORDER BY r.created_at LIMIT 500`,
    )
    .all(actor.id, actor.role) as Record<string, unknown>[];
  return rows.map(toRequest);
}

/**
 * Answer a request. Approving one for a document shares it; approving one for
 * an account only marks it answered, because the administrator makes the
 * account on the page they always make accounts on, with a password they hand over.
 */
export function decideRequest(db: Database, actor: Actor, requestId: string, approve: boolean): AccessRequest {
  const row = db
    .prepare('SELECT r.*, d.title, d.owner_id FROM access_requests r LEFT JOIN documents d ON d.id = r.document_id WHERE r.id = ?')
    .get(requestId) as (Record<string, unknown> & { owner_id?: string }) | undefined;
  if (!row || row['status'] !== 'pending') throw notFound('That request is no longer open');
  const mine = row['document_id'] ? row.owner_id === actor.id : actor.role === 'admin';
  if (!mine) throw forbidden('Only the owner of the document, or an administrator for accounts, can answer this');
  if (approve && row['document_id'] && row['user_id']) {
    shareDocument(db, actor, text(row['document_id']), text(row['user_id']), 'edit');
  }
  db.prepare('UPDATE access_requests SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?').run(
    approve ? 'approved' : 'declined', now(), actor.id, requestId,
  );
  return toRequest({ ...row, status: approve ? 'approved' : 'declined' });
}
