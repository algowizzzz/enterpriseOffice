import { emptyDoc, validateDoc, wordCount, type PMNode } from '@docforge/model';
import type { Database } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { newId, now } from '../lib/ids.js';
import { transaction } from '../db.js';
import type { Role } from './users.js';

export type Permission = 'view' | 'edit';
export type Access = 'owner' | 'edit' | 'view' | 'none';

export interface DocumentSummary {
  id: string;
  title: string;
  ownerId: string;
  ownerName: string;
  origin: 'blank' | 'import';
  sourceName: string | null;
  wordCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  access: Access;
}

export interface DocumentDetail extends DocumentSummary {
  content: PMNode;
}

interface DocRow extends Record<string, unknown> {
  id: string;
  owner_id: string;
  title: string;
  content: string;
  origin: 'blank' | 'import';
  source_name: string | null;
  word_count: number;
  revision: number;
  created_at: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
}

export const MAX_TITLE_LENGTH = 200;
/** Guards the database and the editor against a single pathological document. */
export const MAX_CONTENT_BYTES = 12 * 1024 * 1024;

export function sanitizeTitle(raw: string | undefined | null): string {
  const title = (raw ?? '').replace(/[\r\n\t]+/gu, ' ').trim();
  if (title.length === 0) return 'Untitled document';
  return title.slice(0, MAX_TITLE_LENGTH);
}

function rowToSummary(row: DocRow, access: Access, ownerName: string): DocumentSummary {
  return {
    id: row.id,
    title: row.title,
    ownerId: row.owner_id,
    ownerName,
    origin: row.origin,
    sourceName: row.source_name,
    wordCount: Number(row.word_count),
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    access,
  };
}

/** Effective access for a user, combining ownership, explicit shares and the admin role. */
export function accessFor(db: Database, documentId: string, user: { id: string; role: Role }): Access {
  const row = db
    .prepare('SELECT owner_id FROM documents WHERE id = ? AND deleted_at IS NULL')
    .get(documentId) as { owner_id: string } | undefined;
  if (!row) return 'none';
  if (row.owner_id === user.id) return 'owner';
  const share = db
    .prepare('SELECT permission FROM document_shares WHERE document_id = ? AND user_id = ?')
    .get(documentId, user.id) as { permission: Permission } | undefined;
  if (share) return share.permission;
  // Administrators can always read, for support and compliance. They do not get
  // silent write access: that would make the audit trail misleading.
  if (user.role === 'admin') return 'view';
  return 'none';
}

const canWrite = (access: Access): boolean => access === 'owner' || access === 'edit';

function requireAccess(
  db: Database,
  documentId: string,
  user: { id: string; role: Role },
  need: 'read' | 'write',
): Access {
  const access = accessFor(db, documentId, user);
  if (access === 'none') throw notFound('Document not found');
  if (need === 'write' && !canWrite(access)) throw forbidden('You have read-only access to this document');
  return access;
}

function ownerName(db: Database, ownerId: string): string {
  const row = db.prepare('SELECT name FROM users WHERE id = ?').get(ownerId) as
    | { name: string }
    | undefined;
  return row?.name ?? 'Unknown';
}

function parseContent(json: string): PMNode {
  return JSON.parse(json) as PMNode;
}

/** Validates and normalises untrusted document content. Throws on malformed input. */
export function assertValidContent(content: unknown): PMNode {
  const serialized = JSON.stringify(content ?? null);
  if (serialized === null || serialized === undefined) throw badRequest('Document content is required');
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONTENT_BYTES) {
    throw badRequest('Document is too large to save');
  }
  const result = validateDoc(content);
  if (!result.ok) throw badRequest('Document content is not valid', result.errors.slice(0, 10));
  return content as PMNode;
}

export interface CreateDocumentInput {
  title?: string;
  content?: unknown;
  origin?: 'blank' | 'import';
  sourceName?: string;
}

export function createDocument(
  db: Database,
  user: { id: string },
  input: CreateDocumentInput,
): DocumentDetail {
  const content = input.content === undefined ? emptyDoc() : assertValidContent(input.content);
  const timestamp = now();
  const row: DocRow = {
    id: newId(),
    owner_id: user.id,
    title: sanitizeTitle(input.title),
    content: JSON.stringify(content),
    origin: input.origin ?? 'blank',
    source_name: input.sourceName ?? null,
    word_count: wordCount(content),
    revision: 1,
    created_at: timestamp,
    updated_at: timestamp,
    updated_by: user.id,
    deleted_at: null,
  };
  transaction(db, () => {
    db.prepare(
      `INSERT INTO documents (id, owner_id, title, content, origin, source_name, word_count, revision, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.owner_id,
      row.title,
      row.content,
      row.origin,
      row.source_name,
      row.word_count,
      row.revision,
      row.created_at,
      row.updated_at,
      row.updated_by,
    );
    insertVersion(db, row.id, 1, row.title, row.content, user.id);
  });
  return { ...rowToSummary(row, 'owner', ownerName(db, user.id)), content };
}

function insertVersion(
  db: Database,
  documentId: string,
  revision: number,
  title: string,
  content: string,
  authorId: string,
): void {
  db.prepare(
    `INSERT INTO document_versions (id, document_id, revision, content, title, author_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId(), documentId, revision, content, title, authorId, now());
}

export function getDocument(
  db: Database,
  user: { id: string; role: Role },
  id: string,
): DocumentDetail {
  const access = requireAccess(db, id, user, 'read');
  const row = db
    .prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL')
    .get(id) as DocRow | undefined;
  if (!row) throw notFound('Document not found');
  return {
    ...rowToSummary(row, access, ownerName(db, row.owner_id)),
    content: parseContent(row.content),
  };
}

export function listDocuments(db: Database, user: { id: string; role: Role }): DocumentSummary[] {
  const rows = db
    .prepare(
      `SELECT d.*, u.name AS owner_name,
              CASE WHEN d.owner_id = ? THEN 'owner' ELSE s.permission END AS access
         FROM documents d
         JOIN users u ON u.id = d.owner_id
         LEFT JOIN document_shares s ON s.document_id = d.id AND s.user_id = ?
        WHERE d.deleted_at IS NULL
          AND (d.owner_id = ? OR s.user_id IS NOT NULL)
        ORDER BY datetime(d.updated_at) DESC`,
    )
    .all(user.id, user.id, user.id) as (DocRow & { owner_name: string; access: Access })[];
  return rows.map((row) => rowToSummary(row, row.access, row.owner_name));
}

export interface UpdateDocumentInput {
  title?: string;
  content?: unknown;
  /** Optimistic concurrency: reject the write when the client is behind. */
  expectedRevision?: number;
}

export function updateDocument(
  db: Database,
  user: { id: string; role: Role },
  id: string,
  input: UpdateDocumentInput,
): DocumentDetail {
  requireAccess(db, id, user, 'write');
  const row = db
    .prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL')
    .get(id) as DocRow | undefined;
  if (!row) throw notFound('Document not found');
  if (input.expectedRevision !== undefined && Number(row.revision) !== input.expectedRevision) {
    throw badRequest(
      `This document was changed by someone else. Reload before saving. Expected revision ${input.expectedRevision}, found ${row.revision}.`,
    );
  }
  const content = input.content === undefined ? parseContent(row.content) : assertValidContent(input.content);
  const title = input.title === undefined ? row.title : sanitizeTitle(input.title);
  const revision = Number(row.revision) + 1;
  const serialized = JSON.stringify(content);
  const timestamp = now();
  transaction(db, () => {
    db.prepare(
      `UPDATE documents
          SET title = ?, content = ?, word_count = ?, revision = ?, updated_at = ?, updated_by = ?
        WHERE id = ?`,
    ).run(title, serialized, wordCount(content), revision, timestamp, user.id, id);
    insertVersion(db, id, revision, title, serialized, user.id);
    pruneVersions(db, id);
  });
  return getDocument(db, user, id);
}

/** Keep the most recent versions only, so a long editing session cannot fill the disk. */
const VERSION_RETENTION = 50;
function pruneVersions(db: Database, documentId: string): void {
  db.prepare(
    `DELETE FROM document_versions
      WHERE document_id = ?
        AND revision NOT IN (
          SELECT revision FROM document_versions
           WHERE document_id = ?
           ORDER BY revision DESC
           LIMIT ?
        )`,
  ).run(documentId, documentId, VERSION_RETENTION);
}

export interface VersionSummary {
  revision: number;
  title: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

export function listVersions(
  db: Database,
  user: { id: string; role: Role },
  id: string,
): VersionSummary[] {
  requireAccess(db, id, user, 'read');
  const rows = db
    .prepare(
      `SELECT v.revision, v.title, v.author_id, v.created_at, u.name AS author_name
         FROM document_versions v
         JOIN users u ON u.id = v.author_id
        WHERE v.document_id = ?
        ORDER BY v.revision DESC`,
    )
    .all(id) as Record<string, unknown>[];
  return rows.map((r) => ({
    revision: Number(r['revision']),
    title: String(r['title']),
    authorId: String(r['author_id']),
    authorName: String(r['author_name']),
    createdAt: String(r['created_at']),
  }));
}

export function getVersionContent(
  db: Database,
  user: { id: string; role: Role },
  id: string,
  revision: number,
): PMNode {
  requireAccess(db, id, user, 'read');
  const row = db
    .prepare('SELECT content FROM document_versions WHERE document_id = ? AND revision = ?')
    .get(id, revision) as { content: string } | undefined;
  if (!row) throw notFound('Version not found');
  return parseContent(row.content);
}

export function restoreVersion(
  db: Database,
  user: { id: string; role: Role },
  id: string,
  revision: number,
): DocumentDetail {
  const content = getVersionContent(db, user, id, revision);
  return updateDocument(db, user, id, { content });
}

export function deleteDocument(db: Database, user: { id: string; role: Role }, id: string): void {
  const access = requireAccess(db, id, user, 'write');
  if (access !== 'owner') throw forbidden('Only the owner can delete a document');
  db.prepare('UPDATE documents SET deleted_at = ?, updated_at = ? WHERE id = ?').run(
    now(),
    now(),
    id,
  );
}

export interface ShareRow {
  userId: string;
  email: string;
  name: string;
  permission: Permission;
  createdAt: string;
}

export function listShares(
  db: Database,
  user: { id: string; role: Role },
  id: string,
): ShareRow[] {
  requireAccess(db, id, user, 'read');
  const rows = db
    .prepare(
      `SELECT s.user_id, s.permission, s.created_at, u.email, u.name
         FROM document_shares s
         JOIN users u ON u.id = s.user_id
        WHERE s.document_id = ?
        ORDER BY u.name ASC`,
    )
    .all(id) as Record<string, unknown>[];
  return rows.map((r) => ({
    userId: String(r['user_id']),
    email: String(r['email']),
    name: String(r['name']),
    permission: r['permission'] as Permission,
    createdAt: String(r['created_at']),
  }));
}

export function shareDocument(
  db: Database,
  user: { id: string; role: Role },
  id: string,
  targetUserId: string,
  permission: Permission,
): void {
  const access = requireAccess(db, id, user, 'write');
  if (access !== 'owner') throw forbidden('Only the owner can change sharing');
  if (targetUserId === user.id) throw badRequest('You already own this document');
  const target = db.prepare('SELECT id, status FROM users WHERE id = ?').get(targetUserId) as
    | { id: string; status: string }
    | undefined;
  if (!target) throw notFound('User not found');
  if (target.status !== 'active') throw badRequest('That account is disabled');
  db.prepare(
    `INSERT INTO document_shares (document_id, user_id, permission, created_at, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (document_id, user_id) DO UPDATE SET permission = excluded.permission`,
  ).run(id, targetUserId, permission, now(), user.id);
}

export function unshareDocument(
  db: Database,
  user: { id: string; role: Role },
  id: string,
  targetUserId: string,
): void {
  const access = requireAccess(db, id, user, 'write');
  if (access !== 'owner') throw forbidden('Only the owner can change sharing');
  db.prepare('DELETE FROM document_shares WHERE document_id = ? AND user_id = ?').run(
    id,
    targetUserId,
  );
}
