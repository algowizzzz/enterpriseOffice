/**
 * Workflow groups: an administrator-defined set of prompts for one kind of
 * document. The summary prompt is not a description of an outcome, it is an
 * executed prompt with a different input than the rest: it receives what
 * every analysis prompt produced, not the document itself (see
 * docs/16-ai-integration.md §4-5). Nothing here calls a model; this is where
 * a real execution flow reads its configuration from.
 */
import type { Database } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { transaction } from '../db.js';
import { newId, now } from '../lib/ids.js';
import { DOCUMENT_TYPES, type DocumentType } from './documents.js';

export type WorkflowPromptRole = 'analysis' | 'summary';

/** Tightened from the old flat array's soft cap of 50 once prompts gained their own identity. */
export const MAX_ANALYSIS_PROMPTS = 10;

export interface WorkflowGroupPrompt {
  id: string;
  role: WorkflowPromptRole;
  position: number;
  text: string;
}

export interface WorkflowGroup {
  id: string;
  name: string;
  description: string;
  docType: DocumentType | null;
  isDefault: boolean;
  /** Null falls back to the installation's default endpoint. */
  endpointId: string | null;
  /** The summary prompt first (it is pinned at the top of the admin UI despite running last), then analysis prompts in position order. */
  prompts: WorkflowGroupPrompt[];
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
  endpoint_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
}

interface WorkflowGroupPromptRow extends Record<string, unknown> {
  id: string;
  group_id: string;
  role: WorkflowPromptRole;
  position: number;
  text: string;
}

const asDocType = (value: string | null): DocumentType | null =>
  value !== null && (DOCUMENT_TYPES as readonly string[]).includes(value) ? (value as DocumentType) : null;

function loadPrompts(db: Database, groupId: string): WorkflowGroupPrompt[] {
  const rows = db
    .prepare(
      `SELECT id, role, position, text FROM workflow_group_prompts
       WHERE group_id = ?
       ORDER BY CASE role WHEN 'summary' THEN 0 ELSE 1 END, position`,
    )
    .all(groupId) as WorkflowGroupPromptRow[];
  return rows.map((row) => ({ id: row.id, role: row.role, position: row.position, text: row.text }));
}

function toGroup(db: Database, row: WorkflowGroupRow): WorkflowGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    docType: asDocType(row.doc_type),
    isDefault: row.is_default === 1,
    endpointId: row.endpoint_id,
    prompts: loadPrompts(db, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

function getRowOrThrow(db: Database, id: string): WorkflowGroupRow {
  const row = db.prepare('SELECT * FROM workflow_groups WHERE id = ?').get(id) as
    | WorkflowGroupRow
    | undefined;
  if (!row) throw notFound('Workflow group not found');
  return row;
}

export function listWorkflowGroups(db: Database): WorkflowGroup[] {
  const rows = db
    .prepare('SELECT * FROM workflow_groups ORDER BY name COLLATE NOCASE')
    .all() as WorkflowGroupRow[];
  return rows.map((row) => toGroup(db, row));
}

export function getWorkflowGroup(db: Database, id: string): WorkflowGroup {
  return toGroup(db, getRowOrThrow(db, id));
}

export interface WorkflowGroupInput {
  name: string;
  description: string;
  docType: DocumentType | null;
  isDefault: boolean;
  endpointId: string | null;
  /** In display/execution order. Capped at `MAX_ANALYSIS_PROMPTS`. */
  analysisPrompts: string[];
  /** Runs last, over the analysis prompts' collected output rather than the document. */
  summaryPrompt: string;
}

export type WorkflowGroupPatch = Partial<
  Pick<WorkflowGroupInput, 'name' | 'description' | 'docType' | 'isDefault' | 'endpointId'>
>;

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
  if (input.analysisPrompts.length > MAX_ANALYSIS_PROMPTS) {
    throw conflict(`A workflow group can hold at most ${MAX_ANALYSIS_PROMPTS} analysis prompts.`);
  }
  const id = newId();
  const timestamp = now();
  return transaction(db, () => {
    if (input.isDefault) clearOtherDefaults(db, input.docType, null);
    db.prepare(
      `INSERT INTO workflow_groups
         (id, name, description, doc_type, is_default, endpoint_id, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.description,
      input.docType,
      input.isDefault ? 1 : 0,
      input.endpointId,
      timestamp,
      timestamp,
      actorId,
    );
    const insertPrompt = db.prepare(
      `INSERT INTO workflow_group_prompts (id, group_id, role, position, text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    input.analysisPrompts.forEach((text, position) => {
      insertPrompt.run(newId(), id, 'analysis', position, text, timestamp, timestamp);
    });
    insertPrompt.run(newId(), id, 'summary', 0, input.summaryPrompt, timestamp, timestamp);
    return getWorkflowGroup(db, id);
  });
}

export function updateWorkflowGroup(db: Database, id: string, patch: WorkflowGroupPatch): WorkflowGroup {
  return transaction(db, () => {
    const current = getWorkflowGroup(db, id);
    const next = {
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      docType: patch.docType !== undefined ? patch.docType : current.docType,
      isDefault: patch.isDefault ?? current.isDefault,
      endpointId: patch.endpointId !== undefined ? patch.endpointId : current.endpointId,
    };
    if (patch.isDefault) clearOtherDefaults(db, next.docType, id);
    db.prepare(
      `UPDATE workflow_groups
       SET name = ?, description = ?, doc_type = ?, is_default = ?, endpoint_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(next.name, next.description, next.docType, next.isDefault ? 1 : 0, next.endpointId, now(), id);
    return getWorkflowGroup(db, id);
  });
}

export function deleteWorkflowGroup(db: Database, id: string): void {
  getRowOrThrow(db, id); // Throws the same "not found" a get would, before deleting nothing.
  db.prepare('DELETE FROM workflow_groups WHERE id = ?').run(id);
}

/** Adds a prompt to a group. A second `summary` prompt, or an analysis prompt past the cap, is refused. */
export function addWorkflowGroupPrompt(
  db: Database,
  groupId: string,
  input: { role: WorkflowPromptRole; text: string },
): WorkflowGroup {
  return transaction(db, () => {
    getRowOrThrow(db, groupId);
    const existing = loadPrompts(db, groupId);
    if (input.role === 'summary' && existing.some((prompt) => prompt.role === 'summary')) {
      throw conflict('This group already has a summary prompt. Edit it instead of adding another.');
    }
    const analysisCount = existing.filter((prompt) => prompt.role === 'analysis').length;
    if (input.role === 'analysis' && analysisCount >= MAX_ANALYSIS_PROMPTS) {
      throw conflict(`A workflow group can hold at most ${MAX_ANALYSIS_PROMPTS} analysis prompts.`);
    }
    const position = input.role === 'analysis' ? analysisCount : 0;
    const timestamp = now();
    db.prepare(
      `INSERT INTO workflow_group_prompts (id, group_id, role, position, text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId(), groupId, input.role, position, input.text, timestamp, timestamp);
    return getWorkflowGroup(db, groupId);
  });
}

/** Only a prompt's text can be changed; its role is fixed once created. */
export function updateWorkflowGroupPrompt(
  db: Database,
  groupId: string,
  promptId: string,
  text: string,
): WorkflowGroup {
  return transaction(db, () => {
    getRowOrThrow(db, groupId);
    const row = db
      .prepare('SELECT id FROM workflow_group_prompts WHERE id = ? AND group_id = ?')
      .get(promptId, groupId);
    if (!row) throw notFound('Prompt not found');
    db.prepare('UPDATE workflow_group_prompts SET text = ?, updated_at = ? WHERE id = ?').run(
      text,
      now(),
      promptId,
    );
    return getWorkflowGroup(db, groupId);
  });
}

/** A group must always keep exactly one summary prompt: deleting its only one is refused. */
export function deleteWorkflowGroupPrompt(db: Database, groupId: string, promptId: string): WorkflowGroup {
  return transaction(db, () => {
    getRowOrThrow(db, groupId);
    const prompt = db
      .prepare('SELECT id, role FROM workflow_group_prompts WHERE id = ? AND group_id = ?')
      .get(promptId, groupId) as { id: string; role: WorkflowPromptRole } | undefined;
    if (!prompt) throw notFound('Prompt not found');
    if (prompt.role === 'summary') {
      throw conflict(
        'A workflow group must keep its summary prompt. Edit it, or delete the whole group instead.',
      );
    }
    db.prepare('DELETE FROM workflow_group_prompts WHERE id = ?').run(promptId);
    // Close the gap so positions stay a dense 0..n-1 sequence, the shape
    // `reorderWorkflowGroupPrompts` and the admin UI both assume.
    const remaining = db
      .prepare(
        `SELECT id FROM workflow_group_prompts WHERE group_id = ? AND role = 'analysis' ORDER BY position`,
      )
      .all(groupId) as { id: string }[];
    const reposition = db.prepare('UPDATE workflow_group_prompts SET position = ? WHERE id = ?');
    remaining.forEach((row, position) => reposition.run(position, row.id));
    return getWorkflowGroup(db, groupId);
  });
}

/** Reorders the analysis prompts. `orderedIds` must be exactly that group's set of analysis-prompt ids. */
export function reorderWorkflowGroupPrompts(
  db: Database,
  groupId: string,
  orderedIds: string[],
): WorkflowGroup {
  return transaction(db, () => {
    getRowOrThrow(db, groupId);
    const current = loadPrompts(db, groupId).filter((prompt) => prompt.role === 'analysis');
    const currentIds = new Set(current.map((prompt) => prompt.id));
    const sameSet =
      orderedIds.length === currentIds.size && orderedIds.every((id) => currentIds.has(id));
    if (!sameSet) {
      throw conflict('The reorder list must name exactly this group’s analysis prompts, each once.');
    }
    const reposition = db.prepare('UPDATE workflow_group_prompts SET position = ? WHERE id = ?');
    orderedIds.forEach((id, position) => reposition.run(position, id));
    return getWorkflowGroup(db, groupId);
  });
}
