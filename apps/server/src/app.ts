import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { ZodError } from 'zod';
import { loadConfig, type Config } from './config.js';
import { openDatabase, type Database } from './db.js';
import { HttpError, unauthorized, forbidden, badRequest } from './errors.js';
import { resolveSession } from './services/sessions.js';
import { countUsers, createUser } from './services/users.js';
import { isValidEmail } from './lib/validation.js';
import type { Role } from './services/users.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerUserRoutes } from './routes/users.routes.js';
import { registerDocumentRoutes } from './routes/documents.routes.js';
import { registerCommentRoutes } from './routes/comments.routes.js';
import { registerCollabRoutes } from './routes/collab.routes.js';
import { registerAccessRoutes } from './routes/access.routes.js';
import { registerWordRoutes } from './routes/words.routes.js';
import { registerWorkflowGroupRoutes } from './routes/workflowGroups.routes.js';
import { registerLlmEndpointRoutes } from './routes/llmEndpoints.routes.js';
import { registerAiRoutes } from './routes/ai.routes.js';
import { registerExportTemplateRoutes } from './routes/exportTemplate.routes.js';
import websocket from '@fastify/websocket';
import { Rooms } from './collab/rooms.js';
import { purgeExpiredSessions } from './services/sessions.js';
import { loadOrCreateSecretKey } from './lib/secretKey.js';

export const SESSION_COOKIE = 'docforge_session';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    config: Config;
    /** The documents people have open together. */
    rooms: Rooms;
    /** Encrypts and decrypts `llm_endpoints.auth_secret`. See lib/secretKey.ts. */
    secretKey: Buffer;
    /** Rejects the request unless a valid session is present. */
    authenticate: (request: FastifyRequest) => Promise<AuthenticatedUser>;
    /** Rejects the request unless the caller is an administrator. */
    requireAdmin: (request: FastifyRequest) => Promise<AuthenticatedUser>;
  }
  interface FastifyRequest {
    user?: AuthenticatedUser;
    sessionToken?: string;
  }
}

function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const cookies = request.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[SESSION_COOKIE];
}

export interface BuildOptions {
  config?: Partial<Config>;
  /** Supply an already-open database. Used by tests to share an in-memory instance. */
  db?: Database;
  logger?: boolean;
}

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const config = loadConfig(options.config);
  const db = options.db ?? openDatabase(config.databaseFile);

  const app = Fastify({
    logger: options.logger ?? config.env !== 'test',
    bodyLimit: 16 * 1024 * 1024,
    trustProxy: config.trustProxy,
  });

  // Several endpoints take no body. A client that sets a JSON content type and
  // sends nothing is a common mistake, and rejecting it produces a confusing
  // error, so an empty JSON body is read as an empty object instead.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string | Buffer, done) => {
      const text = typeof body === 'string' ? body.trim() : body.toString('utf8').trim();
      if (text.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch {
        done(badRequest('The request body is not valid JSON'), undefined);
      }
    },
  );

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('rooms', new Rooms(db, app.log));
  app.decorate('secretKey', loadOrCreateSecretKey(config.llmSecretKeyFile));
  // One frame may carry a pasted picture, so the limit follows the largest
  // document the server will store rather than the library's default.
  await app.register(websocket, { options: { maxPayload: 24 * 1024 * 1024 } });

  await app.register(helmet, {
    // Everything is served from this origin. No CDN, no inline remote resources.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    max: config.loginRateLimit,
    timeWindow: '1 minute',
  });
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10 },
  });

  app.decorate('authenticate', async (request: FastifyRequest): Promise<AuthenticatedUser> => {
    const token = extractToken(request);
    if (!token) throw unauthorized();
    const user = resolveSession(db, token);
    if (!user) throw unauthorized('Your session has expired. Sign in again.');
    const authenticated: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
    request.user = authenticated;
    request.sessionToken = token;
    return authenticated;
  });

  app.decorate('requireAdmin', async (request: FastifyRequest): Promise<AuthenticatedUser> => {
    const user = await app.authenticate(request);
    if (user.role !== 'admin') throw forbidden('Administrator access is required');
    return user;
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof HttpError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request body is not valid.',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
    }
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode === 429) {
      return reply
        .code(429)
        .send({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again shortly.' } });
    }
    if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'That file is larger than the upload limit.' },
      });
    }
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled error');
      return reply
        .code(500)
        .send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
    }
    return reply
      .code(statusCode)
      .send({ error: { code: error.code ?? 'ERROR', message: error.message } });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } });
    }
    // Single-page app: unknown non-API paths fall through to the client router.
    if (existsSync(`${config.webRoot}/index.html`)) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    time: new Date().toISOString(),
    version: 1,
  }));

  await app.register(
    async (instance) => {
      await registerAuthRoutes(instance);
      await registerUserRoutes(instance);
      await registerDocumentRoutes(instance);
      await registerCommentRoutes(instance);
      await registerCollabRoutes(instance);
      await registerAccessRoutes(instance);
      await registerWordRoutes(instance);
      await registerWorkflowGroupRoutes(instance);
      await registerLlmEndpointRoutes(instance);
      await registerAiRoutes(instance);
      await registerExportTemplateRoutes(instance);
    },
    { prefix: '/api' },
  );

  if (existsSync(config.webRoot)) {
    await app.register(fastifyStatic, { root: config.webRoot, index: ['index.html'] });
  }

  await ensureBootstrapAdmin(app);
  purgeExpiredSessions(db);

  // Clearing expired sessions only at startup meant a server that runs for
  // months accumulated them for ever. `unref` keeps the timer from holding the
  // process open on shutdown.
  const housekeeping = setInterval(
    () => {
      try {
        purgeExpiredSessions(db);
      } catch (error) {
        app.log.warn({ err: error }, 'Could not clear expired sessions');
      }
    },
    60 * 60 * 1000,
  );
  housekeeping.unref();

  app.addHook('onClose', async () => {
    // Whatever people have typed since the last snapshot is written down first.
    app.rooms.flush();
    clearInterval(housekeeping);
    db.close();
  });

  return app;
}

/**
 * On a brand-new installation there are no users, so nobody could sign in.
 * Create the seed administrator from configuration. The password must be
 * supplied explicitly: we never invent a default credential.
 */
async function ensureBootstrapAdmin(app: FastifyInstance): Promise<void> {
  const { db, config } = app;
  if (countUsers(db) > 0) return;
  if (!isValidEmail(config.bootstrapAdminEmail)) {
    // Fail loudly rather than creating an account nobody can sign in to.
    throw new Error(
      `DOCFORGE_ADMIN_EMAIL is not a valid email address: "${config.bootstrapAdminEmail}"`,
    );
  }
  if (config.bootstrapAdminPassword.length === 0) {
    app.log.warn(
      'No users exist and DOCFORGE_ADMIN_PASSWORD is not set. Set it and restart to create the first administrator.',
    );
    return;
  }
  await createUser(db, {
    email: config.bootstrapAdminEmail,
    name: 'Administrator',
    password: config.bootstrapAdminPassword,
    role: 'admin',
  });
  app.log.info({ email: config.bootstrapAdminEmail }, 'Created the seed administrator account');
}
