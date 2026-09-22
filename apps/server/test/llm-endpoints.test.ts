import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, createAndLogin, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';

describe('LLM endpoints', () => {
  let app: FastifyInstance;
  let admin: TestActor;
  let editor: TestActor;
  const call = (
    actor: TestActor | null,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url,
      ...(actor ? { headers: authHeader(actor) } : {}),
      ...(payload === undefined ? {} : { payload }),
    });

  beforeEach(async () => {
    app = await makeApp();
    admin = await registerFirstAdmin(app);
    editor = await createAndLogin(app, admin, { email: 'ed@example.com', name: 'Ed Editor' });
  });
  afterEach(async () => {
    await app.close();
  });

  it('is empty until an administrator registers one', async () => {
    expect((await call(admin, 'GET', '/api/llm-endpoints')).json().endpoints).toEqual([]);
  });

  it('registers an endpoint on a private address, encrypting its secret and never returning it', async () => {
    const response = await call(admin, 'POST', '/api/llm-endpoints', {
      name: 'Internal GPU box',
      url: 'http://10.0.0.5:8000/v1/chat/completions',
      authScheme: 'bearer',
      authSecret: 'sk-super-secret-value',
    });
    expect(response.statusCode).toBe(201);
    const { endpoint } = response.json();
    expect(endpoint).toMatchObject({
      name: 'Internal GPU box',
      url: 'http://10.0.0.5:8000/v1/chat/completions',
      authScheme: 'bearer',
      hasSecret: true,
      requestFormat: 'openai-chat',
    });
    expect(endpoint.authSecret).toBeUndefined();
    expect(JSON.stringify(endpoint)).not.toContain('sk-super-secret-value');

    const { endpoints } = (await call(admin, 'GET', '/api/llm-endpoints')).json();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].id).toBe(endpoint.id);
  });

  it('refuses a public address', async () => {
    const response = await call(admin, 'POST', '/api/llm-endpoints', {
      name: 'Somebody else’s cloud model',
      url: 'https://api.openai.com/v1/chat/completions',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/private network/);
  });

  it('refuses an empty name and a header scheme with no header name', async () => {
    expect(
      (await call(admin, 'POST', '/api/llm-endpoints', { name: '', url: 'http://10.0.0.5' })).statusCode,
    ).toBe(400);
    expect(
      (
        await call(admin, 'POST', '/api/llm-endpoints', {
          name: 'Needs a header',
          url: 'http://10.0.0.5',
          authScheme: 'header',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('is refused to anyone who is not an administrator', async () => {
    expect((await call(editor, 'GET', '/api/llm-endpoints')).statusCode).toBe(403);
    expect(
      (await call(editor, 'POST', '/api/llm-endpoints', { name: 'Mine', url: 'http://10.0.0.5' })).statusCode,
    ).toBe(403);
    expect((await call(null, 'GET', '/api/llm-endpoints')).statusCode).toBe(401);
  });

  it('updates an endpoint, keeping its secret when the patch omits one, and can delete it', async () => {
    const created = (
      await call(admin, 'POST', '/api/llm-endpoints', {
        name: 'Draft',
        url: 'http://10.0.0.5',
        authScheme: 'bearer',
        authSecret: 'sk-original',
      })
    ).json().endpoint;

    const renamed = (
      await call(admin, 'PATCH', `/api/llm-endpoints/${created.id}`, { name: 'Draft, renamed' })
    ).json().endpoint;
    expect(renamed.name).toBe('Draft, renamed');
    expect(renamed.hasSecret).toBe(true);

    const resecreted = (
      await call(admin, 'PATCH', `/api/llm-endpoints/${created.id}`, { authSecret: 'sk-replaced' })
    ).json().endpoint;
    expect(resecreted.hasSecret).toBe(true);

    const cleared = (
      await call(admin, 'PATCH', `/api/llm-endpoints/${created.id}`, { authSecret: null })
    ).json().endpoint;
    expect(cleared.hasSecret).toBe(false);

    expect((await call(admin, 'DELETE', `/api/llm-endpoints/${created.id}`)).statusCode).toBe(200);
    expect((await call(admin, 'GET', '/api/llm-endpoints')).json().endpoints).toEqual([]);
  });

  it('refuses to patch an endpoint onto a public address', async () => {
    const created = (
      await call(admin, 'POST', '/api/llm-endpoints', { name: 'Draft', url: 'http://10.0.0.5' })
    ).json().endpoint;
    const response = await call(admin, 'PATCH', `/api/llm-endpoints/${created.id}`, {
      url: 'https://api.openai.com/v1/chat/completions',
    });
    expect(response.statusCode).toBe(400);
  });

  it('reports an endpoint that does not exist rather than deleting nothing silently', async () => {
    expect(
      (await call(admin, 'DELETE', '/api/llm-endpoints/00000000-0000-0000-0000-000000000000')).statusCode,
    ).toBe(404);
  });

  it('lets only one endpoint be the default', async () => {
    const first = (
      await call(admin, 'POST', '/api/llm-endpoints', { name: 'A', url: 'http://10.0.0.5', isDefault: true })
    ).json().endpoint;
    const second = (
      await call(admin, 'POST', '/api/llm-endpoints', { name: 'B', url: 'http://10.0.0.6', isDefault: true })
    ).json().endpoint;

    const { endpoints } = (await call(admin, 'GET', '/api/llm-endpoints')).json();
    const byId = Object.fromEntries(endpoints.map((e: { id: string; isDefault: boolean }) => [e.id, e.isDefault]));
    expect(byId[first.id]).toBe(false);
    expect(byId[second.id]).toBe(true);
  });

  describe('test connection', () => {
    let server: Server | undefined;
    let port: number;

    afterEach(async () => {
      if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve()));
    });

    it('reports success against a reachable loopback endpoint, and checks its bearer token', async () => {
      let receivedAuth: string | undefined;
      const localServer = createServer((req, res) => {
        receivedAuth = req.headers.authorization;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
      });
      server = localServer;
      await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
      port = (localServer.address() as { port: number }).port;

      const created = (
        await call(admin, 'POST', '/api/llm-endpoints', {
          name: 'Local test server',
          url: `http://127.0.0.1:${port}/v1/chat/completions`,
          authScheme: 'bearer',
          authSecret: 'sk-check-me',
        })
      ).json().endpoint;

      const response = await call(admin, 'POST', `/api/llm-endpoints/${created.id}/test`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, status: 200 });
      expect(receivedAuth).toBe('Bearer sk-check-me');
    });

    it('reports failure, not an error, when the endpoint is unreachable', async () => {
      // Nothing is listening on this loopback port.
      const localServer = createServer();
      server = localServer;
      await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
      port = (localServer.address() as { port: number }).port;
      await new Promise<void>((resolve) => localServer.close(() => resolve()));

      const created = (
        await call(admin, 'POST', '/api/llm-endpoints', {
          name: 'Nothing home',
          url: `http://127.0.0.1:${port}/v1/chat/completions`,
        })
      ).json().endpoint;

      const response = await call(admin, 'POST', `/api/llm-endpoints/${created.id}/test`);
      expect(response.statusCode).toBe(200);
      expect(response.json().ok).toBe(false);
    });
  });
});
