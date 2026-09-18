import { anchorFrom, type CommentAnchor } from '@docforge/model';
import type { Database } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { newId, now } from '../lib/ids.js';
import { requireAccess } from './documents.js';
import type { Role } from './users.js';

export const MAX_COMMENT_LENGTH = 10000;
/** Enough for any review; a bound so one document cannot fill the database. */
const MAX_COMMENTS_PER_DOCUMENT = 5000;

export interface Comment {
  id: string;
  parentId: string | null;
  authorId: string | null;
  authorName: string;
  body: string;
  anchor: CommentAnchor | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  /** Whether the person asking may change or remove it. */
  mine: boolean;
}

export interface Thread extends Comment {
  replies: Comment[];
}

interface Row extends Record<string, unknown> {
  id: string;
  document_id: string;
  parent_id: string | null;
  author_id: string | null;
  author_name: string;
  body: string;
  anchor: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

type Actor = { id: string; role: Role; name?: string };

function toComment(row: Row, actor: Actor): Comment {
  let anchor: CommentAnchor | null = null;
  if (row.anchor) {
    try {
      anchor = anchorFrom(JSON.parse(row.anchor));
    } catch {
      anchor = null;
    }
  }
  return {
    id: row.id,
    parentId: row.parent_id,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    anchor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    mine: row.author_id === actor.id || actor.role === 'admin',
  };
}

/** Every thread on a document, oldest first, for anybody who can read it. */
export function listThreads(db: Database, actor: Actor, documentId: string): Thread[] {
  requireAccess(db, documentId, actor, 'read');
  const rows = db
    .prepare(
      'SELECT * FROM comments WHERE document_id = ? AND deleted_at IS NULL ORDER BY created_at, id',
    )
    .all(documentId) as Row[];
  const threads = new Map<string, Thread>();
  for (const row of rows) {
    if (!row.parent_id) threads.set(row.id, { ...toComment(row, actor), replies: [] });
  }
  for (const row of rows) {
    if (row.parent_id) threads.get(row.parent_id)?.replies.push(toComment(row, actor));
  }
  return [...threads.values()];
}

const cleanBody = (raw: unknown): string => {
  const body = typeof raw === 'string' ? raw.replace(/\r\n?/gu, '\n').trim() : '';
  if (body.length === 0) throw badRequest('A comment needs some words in it');
  if (body.length > MAX_COMMENT_LENGTH) throw badRequest('That comment is too long');
  return body;
};

export interface NewComment {
  body: unknown;
  parentId?: string | undefined;
  anchor?: unknown;
  /** Set only by the importer, for a comment signed by somebody with no account. */
  authorName?: string | undefined;
  createdAt?: string | undefined;
  resolved?: boolean | undefined;
}

/**
 * Add a comment. Reading a document is enough: somebody asked to review a
 * policy they cannot edit is exactly who needs to comment on it.
 */
export function addComment(db: Database, actor: Actor, documentId: string, input: NewComment): Comment {
  requireAccess(db, documentId, actor, 'read');
  const body = cleanBody(input.body);

  const count = db
    .prepare('SELECT COUNT(*) AS n FROM comments WHERE document_id = ?')
    .get(documentId) as { n: number };
  if (Number(count.n) >= MAX_COMMENTS_PER_DOCUMENT) {
    throw badRequest('This document has reached the limit on comments');
  }

  let parentId: string | null = null;
  if (input.parentId) {
    const parent = db
      .prepare('SELECT id, parent_id FROM comments WHERE id = ? AND document_id = ? AND deleted_at IS NULL')
      .get(input.parentId, documentId) as { id: string; parent_id: string | null } | undefined;
    if (!parent) throw notFound('That comment is no longer there');
    // A reply to a reply joins the same thread. One level is what Word has, and
    // what anybody can follow in a margin.
    parentId = parent.parent_id ?? parent.id;
  }

  const anchor = parentId ? null : anchorFrom(input.anchor);
  const author = db.prepare('SELECT name FROM users WHERE id = ?').get(actor.id) as { name: string } | undefined;
  const timestamp = input.createdAt ?? now();
  const row: Row = {
    id: newId(),
    document_id: documentId,
    parent_id: parentId,
    author_id: input.authorName ? null : actor.id,
    author_name: (input.authorName ?? author?.name ?? 'Unknown').slice(0, 200),
    body,
    anchor: anchor ? JSON.stringify(anchor) : null,
    created_at: timestamp,
    updated_at: timestamp,
    resolved_at: input.resolved && !parentId ? timestamp : null,
  };
  db.prepare(
    `INSERT INTO comments (id, document_id, parent_id, author_id, author_name, body, anchor, created_at, updated_at, resolved_at, resolved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.document_id, row.parent_id, row.author_id, row.author_name, row.body, row.anchor,
    row.created_at, row.updated_at, row.resolved_at, row.resolved_at ? actor.id : null,
  );
  return toComment(row, actor);
}

function findComment(db: Database, documentId: string, commentId: string): Row {
  const row = db
    .prepare('SELECT * FROM comments WHERE id = ? AND document_id = ? AND deleted_at IS NULL')
    .get(commentId, documentId) as Row | undefined;
  if (!row) throw notFound('That comment is no longer there');
  return row;
}

export interface CommentPatch {
  body?: unknown;
  resolved?: boolean | undefined;
  anchor?: unknown;
}

export function updateComment(
  db: Database,
  actor: Actor,
  documentId: string,
  commentId: string,
  patch: CommentPatch,
): Comment {
  requireAccess(db, documentId, actor, 'read');
  const row = findComment(db, documentId, commentId);
  const timestamp = now();

  if (patch.body !== undefined) {
    // Words are their author's. Resolving is anybody's who can read the thread.
    if (row.author_id !== actor.id) throw forbidden('Only its author can change a comment');
    row.body = cleanBody(patch.body);
    row.updated_at = timestamp;
  }
  if (patch.resolved !== undefined) {
    if (row.parent_id) throw badRequest('A reply cannot be resolved: resolve the thread it belongs to');
    row.resolved_at = patch.resolved ? timestamp : null;
  }
  if (patch.anchor !== undefined && !row.parent_id) {
    // The editor re-anchors a comment when the words under it have moved.
    const anchor = anchorFrom(patch.anchor);
    row.anchor = anchor ? JSON.stringify(anchor) : row.anchor;
  }
  db.prepare(
    'UPDATE comments SET body = ?, updated_at = ?, resolved_at = ?, resolved_by = ?, anchor = ? WHERE id = ?',
  ).run(row.body, row.updated_at, row.resolved_at, row.resolved_at ? actor.id : null, row.anchor, row.id);
  return toComment(row, actor);
}

export function deleteComment(db: Database, actor: Actor, documentId: string, commentId: string): void {
  const access = requireAccess(db, documentId, actor, 'read');
  const row = findComment(db, documentId, commentId);
  // Its author, the document's owner, or an administrator.
  if (row.author_id !== actor.id && access !== 'owner' && actor.role !== 'admin') {
    throw forbidden('Only its author or the document owner can remove a comment');
  }
  const timestamp = now();
  // Removing the first comment of a thread removes the thread.
  db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ? OR parent_id = ?').run(timestamp, row.id, row.id);
}
