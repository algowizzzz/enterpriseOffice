import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, conflict } from '../errors.js';
import { passwordProblems } from '../lib/password.js';
import { listAudit, recordAudit } from '../services/audit.js';
import {
  countActiveAdmins,
  createUser,
  getUser,
  listUsers,
  revokeAllSessions,
  setPassword,
  updateUser,
} from '../services/users.js';

const roleSchema = z.enum(['admin', 'editor', 'viewer']);

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users', async (request) => {
    const user = await app.authenticate(request);
    // Any signed-in user needs the directory to share documents, but only
    // administrators see roles, status and sign-in history.
    const users = listUsers(app.db);
    if (user.role === 'admin') return { users };
    return {
      users: users
        .filter((candidate) => candidate.status === 'active')
        .map((candidate) => ({ id: candidate.id, name: candidate.name, email: candidate.email })),
    };
  });

  app.post('/users', async (request, reply) => {
    const actor = await app.requireAdmin(request);
    const body = z
      .object({
        email: z.string().trim().email().max(254),
        name: z.string().trim().min(1).max(120),
        password: z.string().min(1).max(200),
        role: roleSchema,
      })
      .parse(request.body);
    const problems = passwordProblems(body.password);
    if (problems.length > 0) throw badRequest(problems.join(' '));
    const created = await createUser(app.db, body);
    recordAudit(app.db, {
      actorId: actor.id,
      action: 'user.created',
      targetType: 'user',
      targetId: created.id,
      detail: { email: created.email, role: created.role },
      ip: request.ip,
    });
    return reply.code(201).send({ user: created });
  });

  app.patch('/users/:id', async (request) => {
    const actor = await app.requireAdmin(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        role: roleSchema.optional(),
        status: z.enum(['active', 'disabled']).optional(),
      })
      .parse(request.body);

    const target = getUser(app.db, id);
    const losesAdmin =
      (body.role !== undefined && body.role !== 'admin' && target.role === 'admin') ||
      (body.status === 'disabled' && target.role === 'admin');
    if (losesAdmin && countActiveAdmins(app.db, id) === 0) {
      throw conflict('This is the last active administrator. Promote someone else first.');
    }
    if (target.id === actor.id && body.status === 'disabled') {
      throw badRequest('You cannot disable your own account');
    }

    const updated = updateUser(app.db, id, body);
    recordAudit(app.db, {
      actorId: actor.id,
      action:
        body.status === 'disabled'
          ? 'user.disabled'
          : body.status === 'active' && target.status === 'disabled'
            ? 'user.enabled'
            : 'user.updated',
      targetType: 'user',
      targetId: id,
      detail: body,
      ip: request.ip,
    });
    return { user: updated };
  });

  /** Administrator password reset. The user's other sessions are revoked. */
  app.post('/users/:id/password', async (request) => {
    const actor = await app.requireAdmin(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ password: z.string().min(1).max(200) }).parse(request.body);
    const problems = passwordProblems(body.password);
    if (problems.length > 0) throw badRequest(problems.join(' '));
    await setPassword(app.db, id, body.password);
    revokeAllSessions(app.db, id);
    recordAudit(app.db, {
      actorId: actor.id,
      action: 'user.password_changed',
      targetType: 'user',
      targetId: id,
      detail: { byAdministrator: true },
      ip: request.ip,
    });
    return { ok: true };
  });

  app.get('/audit', async (request) => {
    await app.requireAdmin(request);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);
    return { entries: listAudit(app.db, query.limit, query.offset) };
  });
}
