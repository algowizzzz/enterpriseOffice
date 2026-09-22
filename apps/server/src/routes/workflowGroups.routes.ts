import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../services/audit.js';
import { DOCUMENT_TYPES } from '../services/documents.js';
import {
  createWorkflowGroup,
  deleteWorkflowGroup,
  listWorkflowGroups,
  updateWorkflowGroup,
} from '../services/workflowGroups.js';

const docTypeSchema = z.enum(DOCUMENT_TYPES).nullable();
// A prompt is a paragraph, not a document: capped well short of what would
// make the group unreadable in the list this is edited from.
const promptsSchema = z.array(z.string().trim().min(1).max(4000)).max(50);

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
  docType: docTypeSchema.default(null),
  isDefault: z.boolean().default(false),
  prompts: promptsSchema.default([]),
  outputSummary: z.string().trim().max(2000).default(''),
});

const patchSchema = createSchema.partial();

/**
 * Configuration only: naming a set of prompts and what they are meant to add
 * up to for one kind of document. No route here calls a model.
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
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
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
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
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
}
