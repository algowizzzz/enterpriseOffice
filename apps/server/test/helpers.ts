import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';

export interface TestActor {
  id: string;
  email: string;
  name: string;
  role: string;
  token: string;
}

export async function makeApp(): Promise<FastifyInstance> {
  return buildApp({
    db: openDatabase(':memory:'),
    logger: false,
    config: {
      env: 'test',
      // Rate limits high enough that they never fire by accident during tests.
      loginRateLimit: 1000,
      bootstrapAdminPassword: '',
      webRoot: '/nonexistent-web-root',
    },
  });
}

export const authHeader = (actor: TestActor): Record<string, string> => ({
  authorization: `Bearer ${actor.token}`,
});

/** Register the very first account, which the server makes an administrator. */
export async function registerFirstAdmin(
  app: FastifyInstance,
  overrides: Partial<{ email: string; name: string; password: string }> = {},
): Promise<TestActor> {
  const payload = {
    email: overrides.email ?? 'admin@example.com',
    name: overrides.name ?? 'Ada Admin',
    password: overrides.password ?? 'Correct-Horse-9',
  };
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload });
  if (response.statusCode !== 201) {
    throw new Error(`registerFirstAdmin failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json() as { user: TestActor; token: string };
  return { ...body.user, token: body.token };
}

/** Create an additional account as an administrator, then sign in as it. */
export async function createAndLogin(
  app: FastifyInstance,
  admin: TestActor,
  input: { email: string; name: string; password?: string; role?: string },
): Promise<TestActor> {
  const password = input.password ?? 'Correct-Horse-9';
  const created = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: authHeader(admin),
    payload: { email: input.email, name: input.name, password, role: input.role ?? 'editor' },
  });
  if (created.statusCode !== 201) {
    throw new Error(`createAndLogin create failed: ${created.statusCode} ${created.body}`);
  }
  return login(app, input.email, password);
}

export async function login(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<TestActor> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json() as { user: TestActor; token: string };
  return { ...body.user, token: body.token };
}

export function paragraphDoc(...lines: string[]): unknown {
  return {
    type: 'doc',
    content: lines.map((line) => ({
      type: 'paragraph',
      content: line.length > 0 ? [{ type: 'text', text: line }] : undefined,
    })),
  };
}
