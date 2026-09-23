import type { Database } from '../db.js';
import { newId, now } from '../lib/ids.js';

export type AuditAction =
  | 'user.login'
  | 'user.login_failed'
  | 'user.logout'
  | 'user.created'
  | 'user.updated'
  | 'user.password_changed'
  | 'user.disabled'
  | 'user.enabled'
  | 'document.created'
  | 'document.imported'
  | 'document.updated'
  | 'document.renamed'
  | 'document.deleted'
  | 'document.restored'
  | 'document.exported'
  | 'document.shared'
  | 'document.unshared'
  | 'document.transferred'
  | 'document.locked'
  | 'access.requested'
  | 'access.approved'
  | 'access.declined'
  | 'document.unlocked'
  | 'comment.added'
  | 'comment.replied'
  | 'comment.edited'
  | 'comment.resolved'
  | 'comment.reopened'
  | 'comment.removed'
  | 'workflow_group.created'
  | 'workflow_group.updated'
  | 'workflow_group.deleted'
  | 'llm_endpoint.created'
  | 'llm_endpoint.updated'
  | 'llm_endpoint.deleted'
  | 'llm_endpoint.tested'
  | 'chat_settings.updated'
  | 'analysis.run'
  | 'export_template.updated';

export interface AuditEntry {
  actorId: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
  ip?: string;
}

/**
 * Append-only audit trail. Enterprise deployments are usually required to show
 * who did what to which document, so every state change routes through here.
 */
export function recordAudit(db: Database, entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit_log (id, created_at, actor_id, action, target_type, target_id, detail, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    now(),
    entry.actorId,
    entry.action,
    entry.targetType ?? null,
    entry.targetId ?? null,
    entry.detail ? JSON.stringify(entry.detail) : null,
    entry.ip ?? null,
  );
}

export interface AuditRow {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  /** The document's current title, when `targetType` is `document` -- a raw id means nothing to a person reading the trail. */
  targetTitle: string | null;
  /** The document named by `targetTitle` has since been deleted (soft-deleted rows keep their title forever). */
  targetDeleted: boolean;
  detail: unknown;
  ip: string | null;
}

export function listAudit(db: Database, limit = 100, offset = 0): AuditRow[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.created_at, a.actor_id, u.email AS actor_email, u.name AS actor_name, a.action,
              a.target_type, a.target_id, a.detail, a.ip,
              CASE
                WHEN a.target_type = 'document' THEN d.title
                WHEN a.target_type IN ('user', 'account') THEN tu.name
                ELSE NULL
              END AS target_title,
              d.deleted_at AS target_deleted_at
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.actor_id
         LEFT JOIN documents d ON a.target_type = 'document' AND d.id = a.target_id
         LEFT JOIN users tu ON a.target_type IN ('user', 'account') AND tu.id = a.target_id
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as Record<string, string | null>[];
  return rows.map((r) => ({
    id: r['id'] as string,
    createdAt: r['created_at'] as string,
    actorId: r['actor_id'] ?? null,
    actorEmail: r['actor_email'] ?? null,
    actorName: r['actor_name'] ?? null,
    action: r['action'] as string,
    targetType: r['target_type'] ?? null,
    targetId: r['target_id'] ?? null,
    targetTitle: r['target_title'] ?? null,
    targetDeleted: Boolean(r['target_deleted_at']),
    detail: r['detail'] ? JSON.parse(r['detail']) : null,
    ip: r['ip'] ?? null,
  }));
}
