import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../services/audit.js';
import { addComment, deleteComment, listThreads, updateComment } from '../services/comments.js';

const documentParam = z.object({ id: z.string().uuid() });
const commentParam = z.object({ id: z.string().uuid(), commentId: z.string().uuid() });

const anchorSchema = z
  .object({
    quote: z.string().min(1).max(2000),
    prefix: z.string().max(80).default(''),
    suffix: z.string().max(80).default(''),
    block: z.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

export async function registerCommentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/documents/:id/comments', async (request) => {
    const user = await app.authenticate(request);
    const { id } = documentParam.parse(request.params);
    return { threads: listThreads(app.db, user, id) };
  });

  app.post(
    '/documents/:id/comments',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const user = await app.authenticate(request);
      const { id } = documentParam.parse(request.params);
      const body = z
        .object({
          body: z.string().min(1).max(10000),
          parentId: z.string().uuid().optional(),
          anchor: anchorSchema.optional(),
        })
        .strict()
        .parse(request.body);
      const comment = addComment(app.db, user, id, body);
      recordAudit(app.db, {
        actorId: user.id,
        action: body.parentId ? 'comment.replied' : 'comment.added',
        targetType: 'document',
        targetId: id,
        detail: { commentId: comment.id, anchored: comment.anchor !== null },
        ip: request.ip,
      });
      return reply.code(201).send({ comment });
    },
  );

  app.patch('/documents/:id/comments/:commentId', async (request) => {
    const user = await app.authenticate(request);
    const { id, commentId } = commentParam.parse(request.params);
    const patch = z
      .object({
        body: z.string().min(1).max(10000).optional(),
        resolved: z.boolean().optional(),
        anchor: anchorSchema.optional(),
      })
      .strict()
      .parse(request.body);
    const comment = updateComment(app.db, user, id, commentId, patch);
    if (patch.resolved !== undefined || patch.body !== undefined) {
      recordAudit(app.db, {
        actorId: user.id,
        action:
          patch.resolved === true ? 'comment.resolved' : patch.resolved === false ? 'comment.reopened' : 'comment.edited',
        targetType: 'document',
        targetId: id,
        detail: { commentId },
        ip: request.ip,
      });
    }
    return { comment };
  });

  app.delete('/documents/:id/comments/:commentId', async (request) => {
    const user = await app.authenticate(request);
    const { id, commentId } = commentParam.parse(request.params);
    deleteComment(app.db, user, id, commentId);
    recordAudit(app.db, {
      actorId: user.id,
      action: 'comment.removed',
      targetType: 'document',
      targetId: id,
      detail: { commentId },
      ip: request.ip,
    });
    return { ok: true };
  });
}
