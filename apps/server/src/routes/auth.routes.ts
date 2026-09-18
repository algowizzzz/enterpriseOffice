import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE } from '../app.js';
import { badRequest, unauthorized } from '../errors.js';
import { verifyPassword, passwordProblems } from '../lib/password.js';
import { emailSchema } from '../lib/validation.js';
import { createSession, revokeSession } from '../services/sessions.js';
import { recordAudit } from '../services/audit.js';
import {
  countUsers,
  createFirstAdmin,
  findUserByEmail,
  getUser,
  markLogin,
  revokeAllSessions,
  setPassword,
} from '../services/users.js';

const credentials = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

const registration = credentials.extend({
  name: z.string().trim().min(1, 'Name is required').max(120),
});

function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: reply.server.config.secureCookies,
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

const clientIp = (request: FastifyRequest): string => request.ip;

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Self-service registration is only open while the instance has no users,
   * so the very first person becomes the administrator. After that an
   * administrator creates accounts, which is what enterprise deployments expect.
   */
  app.post('/auth/register', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = registration.parse(request.body);
    if (countUsers(app.db) > 0) {
      throw badRequest('Registration is closed. Ask an administrator for an account.');
    }
    const problems = passwordProblems(body.password);
    if (problems.length > 0) throw badRequest(problems.join(' '));

    // The check above is a courtesy for the common case. The one that counts is
    // inside the transaction below, because hashing a password takes long
    // enough that two requests arriving together would otherwise both see an
    // empty instance and both become administrators.
    const user = await createFirstAdmin(app.db, {
      email: body.email,
      name: body.name,
      password: body.password,
      role: 'admin',
    });
    if (!user) {
      throw badRequest('Registration is closed. Ask an administrator for an account.');
    }
    recordAudit(app.db, {
      actorId: user.id,
      action: 'user.created',
      targetType: 'user',
      targetId: user.id,
      detail: { role: 'admin', bootstrap: true },
      ip: clientIp(request),
    });
    const session = createSession(app.db, user.id, app.config.sessionTtlSeconds, {
      userAgent: request.headers['user-agent'],
      ip: clientIp(request),
    });
    markLogin(app.db, user.id);
    setSessionCookie(reply, session.token, app.config.sessionTtlSeconds);
    return reply.code(201).send({ user, token: session.token, expiresAt: session.expiresAt });
  });

  app.post('/auth/login', { config: { rateLimit: { max: app.config.loginRateLimit, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = credentials.parse(request.body);
    const row = findUserByEmail(app.db, body.email);
    // Always run a verification so that a missing account and a wrong password
    // take the same amount of time.
    const hash = row?.password_hash ?? 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const ok = await verifyPassword(body.password, hash);
    if (!row || !ok || row.status !== 'active') {
      recordAudit(app.db, {
        actorId: row?.id ?? null,
        action: 'user.login_failed',
        targetType: 'user',
        targetId: row?.id,
        detail: { email: body.email, reason: row ? (ok ? 'disabled' : 'bad_password') : 'unknown_user' },
        ip: clientIp(request),
      });
      throw unauthorized('Email or password is incorrect');
    }
    const session = createSession(app.db, row.id, app.config.sessionTtlSeconds, {
      userAgent: request.headers['user-agent'],
      ip: clientIp(request),
    });
    markLogin(app.db, row.id);
    recordAudit(app.db, {
      actorId: row.id,
      action: 'user.login',
      targetType: 'user',
      targetId: row.id,
      ip: clientIp(request),
    });
    setSessionCookie(reply, session.token, app.config.sessionTtlSeconds);
    return {
      user: getUser(app.db, row.id),
      token: session.token,
      expiresAt: session.expiresAt,
    };
  });

  app.post('/auth/logout', async (request, reply) => {
    const user = await app.authenticate(request);
    if (request.sessionToken) revokeSession(app.db, request.sessionToken);
    recordAudit(app.db, {
      actorId: user.id,
      action: 'user.logout',
      targetType: 'user',
      targetId: user.id,
      ip: clientIp(request),
    });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (request) => {
    const user = await app.authenticate(request);
    return { user: getUser(app.db, user.id) };
  });

  /** Reports whether the instance still needs its first account. */
  app.get('/auth/bootstrap', async () => ({ needsSetup: countUsers(app.db) === 0 }));

  app.post(
    '/auth/password',
    { config: { rateLimit: { max: app.config.loginRateLimit, timeWindow: '1 minute' } } },
    async (request) => {
      const user = await app.authenticate(request);
      const body = z
        .object({
          currentPassword: z.string().min(1).max(200),
          newPassword: z.string().min(1).max(200),
        })
        .parse(request.body);
      const row = findUserByEmail(app.db, user.email);
      if (!row || !(await verifyPassword(body.currentPassword, row.password_hash))) {
        throw unauthorized('Your current password is incorrect');
      }
      const problems = passwordProblems(body.newPassword);
      if (problems.length > 0) throw badRequest(problems.join(' '));
      await setPassword(app.db, user.id, body.newPassword);
      // Force every other device to sign in again with the new password.
      revokeAllSessions(app.db, user.id);
      recordAudit(app.db, {
        actorId: user.id,
        action: 'user.password_changed',
        targetType: 'user',
        targetId: user.id,
        ip: clientIp(request),
      });
      return { ok: true };
    },
  );
}
