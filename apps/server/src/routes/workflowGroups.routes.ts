import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../services/audit.js';
import { DOCUMENT_TYPES } from '../services/documents.js';
import {
  MAX_ANALYSIS_PROMPTS,
  addWorkflowGroupPrompt,
  createWorkflowGroup,
  deleteWorkflowGroup,
  deleteWorkflowGroupPrompt,
  listWorkflowGroups,
  reorderWorkflowGroupPrompts,
  updateWorkflowGroup,
  updateWorkflowGroupPrompt,
} from '../services/workflowGroups.js';

const docTypeSchema = z.enum(DOCUMENT_TYPES).nullable();
// A prompt is a paragraph, not a document: capped well short of what would
// make the group unreadable in the list this is edited from.
const promptTextSchema = z.string().trim().min(1).max(4000);

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
  docType: docTypeSchema.default(null),
  isDefault: z.boolean().default(false),
  endpointId: z.string().uuid().nullable().default(null),
  analysisPrompts: z.array(promptTextSchema).max(MAX_ANALYSIS_PROMPTS).default([]),
  summaryPrompt: promptTextSchema,
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  docType: docTypeSchema.optional(),
  isDefault: z.boolean().optional(),
  endpointId: z.string().uuid().nullable().optional(),
});

const idParams = z.object({ id: z.string().uuid() });
const promptParams = z.object({ id: z.string().uuid(), promptId: z.string().uuid() });

/**
 * A workflow group names a set of prompts for one kind of document: analysis
 * prompts that read the document, and one summary prompt that reads their
 * collected output (docs/16-ai-integration.md §4-5). No route here calls a
 * model; `apps/server/src/services/analysis.ts` is what executes a group.
 */
export async function registerWorkflowGroupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/workflow-groups', async (request) => {
    await app.requireAdmin(request);
    return { groups: listWorkflowGroups(app.db) };
  });

  app.post('/workflow-groups', async (request, reply) => {
    const actor = await app.requireAdmin(request);
    const body = createSchema.parse(request.body);
    const created = createWorkflowGroup(app.db, body, actor.id);
    recordAudit(app.db, {
      actorId: actor.id,
      action: 'workflow_group.created',
      targetType: 'workflow_group',
      targetId: created.id,
      detail: { name: created.name, docType: created.docType },
      ip: request.ip,
    });
    return reply.code(201).send({ group: created });
  });

  app.patch('/workflow-groups/:id', async (request) => {
    const actor = await app.requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const body = patchSchema.parse(request.body);
    const updated = updateWorkflowGroup(app.db, id, body);
    recordAudit(app.db, {
      actorId: actor.id,
      action: 'workflow_group.updated',
      targetType: 'workflow_group',
      targetId: id,
      detail: body,
      ip: request.ip,
    });
    return { group: updated };
  });

  app.delete('/workflow-groups/:id', async (request) => {
    const actor = await app.requireAdmin(request);
    const { id } = idParams.parse(request.params);
    deleteWorkflowGroup(app.db, id);
    recordAudit(app.db, {
      actorId: actor.id,
      action: 'workflow_group.deleted',
      targetType: 'workflow_group',
      targetId: id,
      ip: request.ip,
    });
    return { ok: true };
  });

  app.post('/workflow-groups/:id/prompts', async (request, reply) => {
    const actor = await app.requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const body = z.object({ role: z.enum(['analysis', 'summary']), text: promptTextSchema }).parse(
      request.body,
    );
    const updated = addWorkflowGroupPrompt(app.db, id, body);
    recordAudit(app.db, {
      actorId: actor.id,
      action: 'workflow_group.updated',
      targetType: 'workflow_group',
      targetId: id,
      detail: { promptAction: 'added', role: body.role },
      ip: request.ip,
    });
    return reply.code(201).send({ group: updated });
  });

  app.patch('/workflow-groups/:id/prompts/:promptId', async (request) => {
    const actor = await app.requireAdmin(request);
    const { id, promptId } = promptParams.parse(request.params);
    const { text } = z.object({ text: promptTextSchema }).parse(request.body);
    const updated = updateWorkflowGroupPrompt(app.db, id, promptId, text);
    recordAudit(app.db, {
      actorId: actor.id,
      action: 'workflow_group.updated',
      targetType: 'workflow_group',
      targetId: id,
      detail: { promptAction: 'edited', promptId },
      ip: request.ip,
    });
    return { group: updated };
  });

  app.delete('/workflow-groups/:id/prompts/:promptId', async (request) => {
    const actor = await app.requireAdmin(request);
    const { id, promptId } = promptParams.parse(request.params);
    const updated = deleteWorkflowGroupPrompt(app.db, id, promptId);
    recordAudit(app.db, {
      actorId: actor.id,
      action: 'workflow_group.updated',
      targetType: 'workflow_group',
      targetId: id,
      detail: { promptAction: 'deleted', promptId },
      ip: request.ip,
    });
    return { group: updated };
  });

  app.post('/workflow-groups/:id/prompts/reorder', async (request) => {
    const actor = await app.requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const { promptIds } = z.object({ promptIds: z.array(z.string().uuid()) }).parse(request.body);
    const updated = reorderWorkflowGroupPrompts(app.db, id, promptIds);
    recordAudit(app.db, {
      actorId: actor.id,
      action: 'workflow_group.updated',
      targetType: 'workflow_group',
      targetId: id,
      detail: { promptAction: 'reordered' },
      ip: request.ip,
    });
    return { group: updated };
  });
}
