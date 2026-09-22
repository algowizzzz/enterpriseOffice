/**
 * Workflow groups: an administrator-defined set of prompts for one kind of
 * document, plus a summary of what running them together is meant to
 * produce. This is configuration storage only. Nothing here calls a model;
 * there is no model to call yet. It is the shape ready for that to be wired
 * in later, the same way page_setup was carried on documents before there
 * was anything to change it beyond the header and footer.
 */
import type { Database } from '../db.js';
import { notFound } from '../errors.js';
import { transaction } from '../db.js';
import { newId, now } from '../lib/ids.js';
import { DOCUMENT_TYPES, type DocumentType } from './documents.js';

export interface WorkflowGroup {
  id: string;
  name: string;
  description: string;
  docType: DocumentType | null;
  isDefault: boolean;
  prompts: string[];
  outputSummary: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

interface WorkflowGroupRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string;
  doc_type: string | null;
  is_default: number;
  prompts: string;
  output_summary: string;
  created_at: string;
  updated_at: string;
  created_by: string;
}

const asDocType = (value: string | null): DocumentType | null =>
  value !== null && (DOCUMENT_TYPES as readonly string[]).includes(value) ? (value as DocumentType) : null;

const toGroup = (row: WorkflowGroupRow): WorkflowGroup => ({
  id: row.id,
  name: row.name,
  description: row.description,
  docType: asDocType(row.doc_type),
  isDefault: row.is_default === 1,
  // Written and read whole. A child table would only add a join nothing
  // here needs: this is never queried by one prompt's own text.
  prompts: JSON.parse(row.prompts) as string[],
  outputSummary: row.output_summary,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  createdBy: row.created_by,
});

export function listWorkflowGroups(db: Database): WorkflowGroup[] {
  const rows = db
    .prepare('SELECT * FROM workflow_groups ORDER BY name COLLATE NOCASE')
    .all() as WorkflowGroupRow[];
  return rows.map(toGroup);
}

export function getWorkflowGroup(db: Database, id: string): WorkflowGroup {
  const row = db.prepare('SELECT * FROM workflow_groups WHERE id = ?').get(id) as
    | WorkflowGroupRow
    | undefined;
  if (!row) throw notFound('Workflow group not found');
  return toGroup(row);
}

export interface WorkflowGroupInput {
  name: string;
  description: string;
  docType: DocumentType | null;
  isDefault: boolean;
  prompts: string[];
  outputSummary: string;
}

export type WorkflowGroupPatch = Partial<WorkflowGroupInput>;

/**
 * At most one default per document type, the same idea as one owner per
 * document: a group cannot become the default for a type without taking the
 * badge off whichever one had it, so the admin console is never shown two
 * defaults for "Policy" at once.
 */
function clearOtherDefaults(db: Database, docType: DocumentType | null, exceptId: string | null): void {
  if (docType === null) return;
  if (exceptId) {
    db.prepare('UPDATE workflow_groups SET is_default = 0 WHERE doc_type = ? AND id != ?').run(
      docType,
      exceptId,
    );
  } else {
    db.prepare('UPDATE workflow_groups SET is_default = 0 WHERE doc_type = ?').run(docType);
  }
}

export function createWorkflowGroup(
  db: Database,
  input: WorkflowGroupInput,
  actorId: string,
): WorkflowGroup {
  const id = newId();
  const timestamp = now();
  return transaction(db, () => {
    if (input.isDefault) clearOtherDefaults(db, input.docType, null);
    db.prepare(
      `INSERT INTO workflow_groups
         (id, name, description, doc_type, is_default, prompts, output_summary, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.description,
      input.docType,
      input.isDefault ? 1 : 0,
      JSON.stringify(input.prompts),
      input.outputSummary,
      timestamp,
      timestamp,
      actorId,
    );
    return getWorkflowGroup(db, id);
  });
}

export function updateWorkflowGroup(db: Database, id: string, patch: WorkflowGroupPatch): WorkflowGroup {
  return transaction(db, () => {
    const current = getWorkflowGroup(db, id);
    const next: WorkflowGroup = { ...current, ...patch };
    if (patch.isDefault) clearOtherDefaults(db, next.docType, id);
    db.prepare(
      `UPDATE workflow_groups
       SET name = ?, description = ?, doc_type = ?, is_default = ?, prompts = ?, output_summary = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      next.name,
      next.description,
      next.docType,
      next.isDefault ? 1 : 0,
      JSON.stringify(next.prompts),
      next.outputSummary,
      now(),
      id,
    );
    return getWorkflowGroup(db, id);
  });
}

export function deleteWorkflowGroup(db: Database, id: string): void {
  getWorkflowGroup(db, id); // Throws the same "not found" a get would, before deleting nothing.
  db.prepare('DELETE FROM workflow_groups WHERE id = ?').run(id);
}
