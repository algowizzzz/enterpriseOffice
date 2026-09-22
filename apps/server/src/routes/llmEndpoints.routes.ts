import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../services/audit.js';
import {
  AUTH_SCHEMES,
  REQUEST_FORMATS,
  createLlmEndpoint,
  deleteLlmEndpoint,
  listLlmEndpoints,
  testLlmEndpoint,
  updateLlmEndpoint,
} from '../services/llmEndpoints.js';

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  url: z.string().trim().min(1).max(2000),
  authScheme: z.enum(AUTH_SCHEMES).default('none'),
  authHeaderName: z.string().trim().min(1).max(200).nullable().default(null),
  authSecret: z.string().trim().min(1).max(8000).nullable().default(null),
  requestFormat: z.enum(REQUEST_FORMATS).default('openai-chat'),
});

const patchSchema = createSchema.partial();

const idParams = z.object({ id: z.string().uuid() });

/**
 * Admin-only CRUD for where a future AI feature is allowed to send a
 * document or a prompt, plus a "Test connection" action. Every route but the
 * last only reads and writes configuration; `POST /llm-endpoints/:id/test`
 * is the one route in this product that makes an outbound HTTP call to an
 * address an administrator chose. See docs/16-ai-integration.md §7 and §12.
 */
export async function registerLlmEndpointRoutes(app: FastifyInstance): Promise<void> {
  app.get('/llm-endpoints', async (request) => {
    await app.requireAdmin(request);
    return { endpoints: listLlmEndpoints(app.db) };
  });

  app.post('/llm-endpoints', async (request, reply) => {
    const actor = await app.requireAdmin(request);
    const body = createSchema.parse(request.body);
    const created = createLlmEndpoint(app.db, app.secretKey, body, actor.id);
    recordAudit(app.db, {
      actorId: actor.id,
      action: 'llm_endpoint.created',
      targetType: 'llm_endpoint',
      targetId: created.id,
      detail: { name: created.name, url: created.url },
      ip: request.ip,
    });
    return reply.code(201).send({ endpoint: created });
  });

  app.patch('/llm-endpoints/:id', async (request) => {
    const actor = await app.requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const body = patchSchema.parse(request.body);
    const updated = updateLlmEndpoint(app.db, app.secretKey, id, body);
    recordAudit(app.db, {
      actorId: actor.id,
      action: 'llm_endpoint.updated',
      targetType: 'llm_endpoint',
      targetId: id,
      // The secret itself never goes in the audit trail, only whether the
      // request touched it.
      detail: { ...body, authSecret: body.authSecret !== undefined ? '(changed)' : undefined },
      ip: request.ip,
    });
    return { endpoint: updated };
  });

  app.delete('/llm-endpoints/:id', async (request) => {
    const actor = await app.requireAdmin(request);
    const { id } = idParams.parse(request.params);
    deleteLlmEndpoint(app.db, id);
    recordAudit(app.db, {
      actorId: actor.id,
      action: 'llm_endpoint.deleted',
      targetType: 'llm_endpoint',
      targetId: id,
      ip: request.ip,
    });
    return { ok: true };
  });

  app.post('/llm-endpoints/:id/test', async (request) => {
    const actor = await app.requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const result = await testLlmEndpoint(app.db, app.secretKey, id);
    recordAudit(app.db, {
      actorId: actor.id,
      action: 'llm_endpoint.tested',
      targetType: 'llm_endpoint',
      targetId: id,
      detail: { ok: result.ok, status: result.status },
      ip: request.ip,
    });
    return result;
  });
}
