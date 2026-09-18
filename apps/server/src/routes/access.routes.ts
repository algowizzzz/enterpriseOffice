import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../services/audit.js';
import { decideRequest, listOpenRequests, requestAccount, requestDocumentAccess } from '../services/accessRequests.js';

export async function registerAccessRoutes(app: FastifyInstance): Promise<void> {
  /** From the sign-in page, by somebody with no account. Always answers the same way. */
  app.post('/access-requests/account', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = z
      .object({ name: z.string().max(200), email: z.string().max(300), note: z.string().max(1000).default('') })
      .strict()
      .parse(request.body);
    requestAccount(app.db, body);
    recordAudit(app.db, { actorId: null, action: 'access.requested', targetType: 'account', detail: { email: body.email.slice(0, 254) }, ip: request.ip });
    return reply.code(202).send({ ok: true });
  });

  app.post('/documents/:id/access-requests', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await app.authenticate(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ note: z.string().max(1000).default('') }).strict().parse(request.body ?? {});
    requestDocumentAccess(app.db, user, id, body.note);
    recordAudit(app.db, { actorId: user.id, action: 'access.requested', targetType: 'document', targetId: id, ip: request.ip });
    return reply.code(202).send({ ok: true });
  });

  app.get('/access-requests', async (request) => {
    const user = await app.authenticate(request);
    return { requests: listOpenRequests(app.db, user) };
  });

  app.post('/access-requests/:requestId', async (request) => {
    const user = await app.authenticate(request);
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params);
    const { approve } = z.object({ approve: z.boolean() }).strict().parse(request.body);
    const decided = decideRequest(app.db, user, requestId, approve);
    recordAudit(app.db, {
      actorId: user.id,
      action: approve ? 'access.approved' : 'access.declined',
      targetType: decided.documentId ? 'document' : 'account',
      ...(decided.documentId ? { targetId: decided.documentId } : {}),
      detail: { for: decided.email, wanted: decided.wanted },
      ip: request.ip,
    });
    return { request: decided };
  });
}
