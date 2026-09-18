import {
  defaultPageSetup,
  emptyDoc,
  pageSetupFrom,
  sanitizeDocument,
  validateDoc,
  wordCount,
  type PageSetup,
  type PMNode,
  styleTableFrom,
  type StyleTable,
} from '@docforge/model';
import type { Database } from '../db.js';
import { HttpError, badRequest, forbidden, notFound } from '../errors.js';
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
  /** Framework, policy, standard, procedure, or nothing said. */
  docType: DocumentType | null;
  wordCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  access: Access;
}

export interface DocumentDetail extends DocumentSummary {
  content: PMNode;
  /** The header, the footer and the orientation, which are not body content. */
  pageSetup: PageSetup;
  /** The document's own styles, for drawing it as it looked in Word. */
  styles?: StyleTable | null;
}

/** What is kept of the file a document was uploaded as. */
export interface DocumentSource {
  fileName: string;
  mediaType: string;
  /** The upload itself, untouched: what "export the original" returns. */
  bytes: Buffer;
  /**
   * The Word package the export patches. The upload itself for a Word file; for
   * a PDF, the Word file it was converted into.
   */
  package: Buffer;
  fragments: Record<string, string>;
  styles: StyleTable | null;
  pageSetup: PageSetup;
}

export interface NewSource {
  fileName: string;
  mediaType: string;
  bytes: Buffer;
  package?: Buffer | undefined;
  fragments: Record<string, string>;
  styles: StyleTable | null;
  pageSetup: PageSetup;
}

export function saveSource(db: Database, documentId: string, source: NewSource): void {
  db.prepare(
    `INSERT INTO document_sources (document_id, file_name, media_type, bytes, package, fragments, styles, page_setup, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    documentId,
    source.fileName.slice(0, 255),
    source.mediaType,
    source.bytes,
    source.package ?? null,
    JSON.stringify(source.fragments),
    JSON.stringify(source.styles ?? {}),
    JSON.stringify(source.pageSetup),
    now(),
  );
}

const parseJson = (raw: unknown): unknown => {
  try {
    return JSON.parse(typeof raw === 'string' ? raw : '{}');
  } catch {
    return {};
  }
};

/** The source of a document the caller has already been allowed to read. */
export function getSource(db: Database, documentId: string): DocumentSource | null {
  const row = db
    .prepare(
      'SELECT file_name, media_type, bytes, package, fragments, styles, page_setup FROM document_sources WHERE document_id = ?',
    )
    .get(documentId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const bytes = Buffer.from(row['bytes'] as Uint8Array);
  const fragments = parseJson(row['fragments']);
  return {
    fileName: String(row['file_name']),
    mediaType: String(row['media_type']),
    bytes,
    package: row['package'] ? Buffer.from(row['package'] as Uint8Array) : bytes,
    fragments:
      typeof fragments === 'object' && fragments !== null ? (fragments as Record<string, string>) : {},
    styles: styleTableFrom(parseJson(row['styles'])),
    pageSetup: pageSetupFrom(parseJson(row['page_setup'])),
  };
}

/** Only the styles, which every open of a document needs and the bytes do not. */
export function getSourceStyles(db: Database, documentId: string): StyleTable | null {
  const row = db.prepare('SELECT styles FROM document_sources WHERE document_id = ?').get(documentId) as
    | { styles?: string }
    | undefined;
  return row ? styleTableFrom(parseJson(row.styles)) : null;
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
  page_setup?: string | null;
  doc_type?: string | null;
}

export const DOCUMENT_TYPES = ['Framework', 'Policy', 'Standard', 'Procedure', 'Guideline', 'Other'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
const asDocumentType = (value: unknown): DocumentType | null =>
  (DOCUMENT_TYPES as readonly string[]).includes(value as string) ? (value as DocumentType) : null;

/** How many people a document may be shared with. */
export const MAX_SHARES = 10;

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
    docType: asDocumentType(row.doc_type),
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

export function requireAccess(
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

/** Page setup as stored, falling back to the default for a row written before it existed. */
function parsePageSetup(json: string | null | undefined): PageSetup {
  if (!json) return defaultPageSetup();
  try {
    return pageSetupFrom(JSON.parse(json));
  } catch {
    return defaultPageSetup();
  }
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
  pageSetup?: unknown;
  docType?: unknown;
}

export function createDocument(
  db: Database,
  user: { id: string },
  input: CreateDocumentInput,
): DocumentDetail {
  const content = input.content === undefined ? emptyDoc() : assertValidContent(input.content);
  const pageSetup = pageSetupFrom(input.pageSetup);
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
    page_setup: JSON.stringify(pageSetup),
    doc_type: asDocumentType(input.docType),
  };
  transaction(db, () => {
    db.prepare(
      `INSERT INTO documents (id, owner_id, title, content, origin, source_name, word_count, revision, created_at, updated_at, updated_by, page_setup, doc_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.page_setup ?? '{}',
      row.doc_type ?? null,
    );
    insertVersion(db, row.id, 1, row.title, row.content, user.id);
  });
  return { ...rowToSummary(row, 'owner', ownerName(db, user.id)), content, pageSetup };
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
    pageSetup: parsePageSetup(row.page_setup),
    styles: getSourceStyles(db, id),
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
        ORDER BY d.updated_at DESC, d.id DESC`,
    )
    .all(user.id, user.id, user.id) as (DocRow & { owner_name: string; access: Access })[];
  return rows.map((row) => rowToSummary(row, row.access, row.owner_name));
}

export interface UpdateDocumentInput {
  title?: string;
  content?: unknown;
  pageSetup?: unknown;
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
    // A conflict, not a malformed request. The client needs to tell the two
    // apart to recover: one means reload, the other means the payload is wrong.
    throw new HttpError(
      409,
      'REVISION_CONFLICT',
      'This document was changed by someone else. Reload before saving.',
      { expectedRevision: input.expectedRevision, currentRevision: Number(row.revision) },
    );
  }
  const content = input.content === undefined ? parseContent(row.content) : assertValidContent(input.content);
  const title = input.title === undefined ? row.title : sanitizeTitle(input.title);
  const pageSetup =
    input.pageSetup === undefined ? parsePageSetup(row.page_setup) : pageSetupFrom(input.pageSetup);
  const revision = Number(row.revision) + 1;
  const serialized = JSON.stringify(content);
  const timestamp = now();
  transaction(db, () => {
    db.prepare(
      `UPDATE documents
          SET title = ?, content = ?, word_count = ?, revision = ?, updated_at = ?, updated_by = ?, page_setup = ?
        WHERE id = ?`,
    ).run(
      title,
      serialized,
      wordCount(content),
      revision,
      timestamp,
      user.id,
      JSON.stringify(pageSetup),
      id,
    );
    insertVersion(db, id, revision, title, serialized, user.id);
    pruneVersions(db, id);
  });
  return getDocument(db, user, id);
}

/**
 * Version retention.
 *
 * A version is written on every save and the editor autosaves a second or two
 * after somebody stops typing, so keeping a flat count of the most recent
 * versions meant about a minute of writing wiped the entire history, the
 * as-imported state of an uploaded Word file included. Somebody who imported a
 * document, edited for a few minutes and then wanted the original back could
 * not get it, which is the one thing a history is for.
 *
 * Three things are kept instead:
 *   the first revision, always, because it is what the document arrived as;
 *   the most recent revisions, for undoing the last few minutes of work;
 *   the last revision of each recent hour, so a day of work stays recoverable
 *   without storing every keystroke's worth of autosave.
 */
const RECENT_VERSIONS = 50;
const HOURLY_VERSIONS = 24;

function pruneVersions(db: Database, documentId: string): void {
  db.prepare(
    `DELETE FROM document_versions
      WHERE document_id = ?
        AND revision <> 1
        AND revision NOT IN (
          SELECT revision FROM document_versions
           WHERE document_id = ?
           ORDER BY revision DESC
           LIMIT ?
        )
        AND revision NOT IN (
          SELECT MAX(revision) FROM document_versions
           WHERE document_id = ?
           GROUP BY substr(created_at, 1, 13)
           ORDER BY MAX(revision) DESC
           LIMIT ?
        )`,
  ).run(documentId, documentId, RECENT_VERSIONS, documentId, HOURLY_VERSIONS);
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
  // Repaired on the way back in, because this is the one write path whose
  // content nobody typed: it was stored by an earlier build, under whatever
  // rules applied then. Handing it straight to the checker meant tightening a
  // rule could make an old version impossible to restore, and the version most
  // likely to be affected is the as-imported original, which is the one the
  // history exists for.
  const content = sanitizeDocument(getVersionContent(db, user, id, revision));
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
  const shared = db
    .prepare('SELECT COUNT(*) AS n FROM document_shares WHERE document_id = ? AND user_id <> ?')
    .get(id, targetUserId) as { n: number };
  if (Number(shared.n) >= MAX_SHARES) {
    throw badRequest(`A document can be shared with at most ${MAX_SHARES} people`);
  }
  db.prepare(
    `INSERT INTO document_shares (document_id, user_id, permission, created_at, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (document_id, user_id) DO UPDATE SET permission = excluded.permission`,
  ).run(id, targetUserId, permission, now(), user.id);
}

/**
 * Hand a document to somebody else. Its owner may, and so may an administrator,
 * which is how a document is rescued when its owner has left. The person who
 * owned it keeps edit access, so handing a document over never locks them out
 * of something they were working on a moment ago.
 */
export function transferOwnership(
  db: Database,
  user: { id: string; role: Role },
  id: string,
  targetUserId: string,
): void {
  const row = db.prepare('SELECT owner_id FROM documents WHERE id = ? AND deleted_at IS NULL').get(id) as
    | { owner_id: string }
    | undefined;
  // Somebody with no access at all is told it is not there, as everywhere else.
  if (!row || (user.role !== 'admin' && accessFor(db, id, user) === 'none')) throw notFound('Document not found');
  if (row.owner_id !== user.id && user.role !== 'admin') {
    throw forbidden('Only the owner or an administrator can hand a document over');
  }
  if (targetUserId === row.owner_id) throw badRequest('That person already owns this document');
  const target = db.prepare('SELECT id, status, role FROM users WHERE id = ?').get(targetUserId) as
    | { id: string; status: string; role: Role }
    | undefined;
  if (!target) throw notFound('User not found');
  if (target.status !== 'active') throw badRequest('That account is disabled');
  if (target.role === 'viewer') throw badRequest('A viewer account cannot own a document');
  transaction(db, () => {
    db.prepare('UPDATE documents SET owner_id = ? WHERE id = ?').run(targetUserId, id);
    db.prepare('DELETE FROM document_shares WHERE document_id = ? AND user_id = ?').run(id, targetUserId);
    db.prepare(
      `INSERT INTO document_shares (document_id, user_id, permission, created_at, created_by)
       VALUES (?, ?, 'edit', ?, ?)
       ON CONFLICT (document_id, user_id) DO UPDATE SET permission = 'edit'`,
    ).run(id, row.owner_id, now(), user.id);
  });
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
