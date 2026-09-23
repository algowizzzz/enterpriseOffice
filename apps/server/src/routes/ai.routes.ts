import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { toPlainText } from '@docforge/model';
import { badRequest } from '../errors.js';
import { recordAudit } from '../services/audit.js';
import { getDocument } from '../services/documents.js';
import { sendChatMessage } from '../services/chat.js';
import { getChatSettings, setChatSettings } from '../services/chatSettings.js';
import { runWorkflowGroup } from '../services/analysis.js';
import { listWorkflowGroups } from '../services/workflowGroups.js';

const idParam = z.object({ id: z.string().uuid() });

const chatSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }))
    .max(40)
    .default([]),
});

/**
 * Where a document's own text actually reaches the model: Chat, Analysis,
 * the document-scoped workflow-group listing a user picks one from, and the
 * admin setting for which endpoint Chat itself uses. Admin CRUD for
 * endpoints and workflow groups lives in `llmEndpoints.routes.ts` and
 * `workflowGroups.routes.ts`; this file is what a signed-in user with
 * ordinary access to a document reaches, not an administrator's console.
 */
export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  /** The groups eligible for one document: its own type, plus every type-agnostic group. */
  app.get('/documents/:id/workflow-groups', async (request) => {
    const user = await app.authenticate(request);
    const { id } = idParam.parse(request.params);
    const document = getDocument(app.db, user, id);
    const groups = listWorkflowGroups(app.db)
      .filter((group) => group.docType === null || group.docType === document.docType)
      .map((group) => ({ id: group.id, name: group.name, description: group.description }));
    return { groups };
  });

  app.post(
    '/documents/:id/chat',
    { config: { rateLimit: { max: app.config.aiRateLimit, timeWindow: '1 minute' } } },
    async (request) => {
      const user = await app.authenticate(request);
      const { id } = idParam.parse(request.params);
      const body = chatSchema.parse(request.body);
      const document = getDocument(app.db, user, id);
      const reply = await sendChatMessage(app.db, app.secretKey, {
        documentText: toPlainText(document.content),
        history: body.history,
        message: body.message,
      });
      return reply;
    },
  );

  app.post(
    '/documents/:id/analysis/run',
    { config: { rateLimit: { max: app.config.aiRateLimit, timeWindow: '1 minute' } } },
    async (request) => {
      const user = await app.authenticate(request);
      const { id } = idParam.parse(request.params);
      const { groupId } = z.object({ groupId: z.string().uuid() }).parse(request.body);
      const document = getDocument(app.db, user, id);
      const result = await runWorkflowGroup(
        app.db,
        app.secretKey,
        groupId,
        toPlainText(document.content),
        document.docType,
      );
      // Actor, document, group and endpoint only: not the prompt text or the
      // model's output, which are not audit-log material (docs/16 §5.4).
      recordAudit(app.db, {
        actorId: user.id,
        action: 'analysis.run',
        targetType: 'document',
        targetId: id,
        detail: { groupId: result.groupId, endpointId: result.endpointId, ok: result.ok },
        ip: request.ip,
      });
      return result;
    },
  );

  app.get('/chat-settings', async (request) => {
    await app.requireAdmin(request);
    return getChatSettings(app.db);
  });

  app.patch('/chat-settings', async (request) => {
    const actor = await app.requireAdmin(request);
    const { endpointId } = z.object({ endpointId: z.string().uuid().nullable() }).parse(request.body);
    if (endpointId && !app.db.prepare('SELECT id FROM llm_endpoints WHERE id = ?').get(endpointId)) {
      throw badRequest('That endpoint does not exist.');
    }
    const settings = setChatSettings(app.db, endpointId);
    recordAudit(app.db, {
      actorId: actor.id,
      action: 'chat_settings.updated',
      targetType: 'chat_settings',
      detail: { endpointId },
      ip: request.ip,
    });
    return settings;
  });
}
