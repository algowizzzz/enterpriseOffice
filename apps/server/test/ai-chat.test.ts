import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, createAndLogin, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';

/**
 * Chat has no real model in the automated suite (docs/16 §9): a loopback
 * HTTP server stands in for one, so these exercise the real request built
 * for an OpenAI-compatible endpoint, not a mock at the service boundary.
 */
describe('Chat', () => {
  let app: FastifyInstance;
  let admin: TestActor;
  let editor: TestActor;
  let server: Server | undefined;
  const call = (actor: TestActor | null, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      ...(actor ? { headers: authHeader(actor) } : {}),
      ...(payload === undefined ? {} : { payload }),
    });

  const startFakeModel = async (reply: (body: unknown) => unknown): Promise<number> => {
    const localServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply(JSON.parse(raw || '{}'))));
      });
    });
    server = localServer;
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    return (localServer.address() as { port: number }).port;
  };

  beforeEach(async () => {
    app = await makeApp();
    admin = await registerFirstAdmin(app);
    editor = await createAndLogin(app, admin, { email: 'ed@example.com', name: 'Ed Editor' });
  });
  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve()));
    await app.close();
  });

  const createDoc = async (actor: TestActor, title = 'Quarterly report') =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: authHeader(actor),
        payload: { title },
      })
    ).json().document;

  it('reports that no endpoint is configured, rather than failing, when none is registered', async () => {
    const doc = await createDoc(editor);
    const response = await call(editor, 'POST', `/api/documents/${doc.id}/chat`, { message: 'Hello?' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false });
    expect(response.json().message).toMatch(/no ai endpoint is configured/i);
  });

  it('sends the document text as context and returns the model’s reply', async () => {
    const port = await startFakeModel((body) => {
      const messages = (body as { messages: { role: string; content: string }[] }).messages;
      return { choices: [{ message: { content: `You said: ${messages.at(-1)?.content}` } }] };
    });
    await call(admin, 'POST', '/api/llm-endpoints', {
      name: 'Local model',
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      isDefault: true,
    });
    const doc = await createDoc(editor);

    const response = await call(editor, 'POST', `/api/documents/${doc.id}/chat`, {
      message: 'What is this about?',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      reply: 'You said: What is this about?',
      truncated: false,
    });
  });

  it('truncates a document past the context cap and says so', async () => {
    const port = await startFakeModel((body) => {
      const system = (body as { messages: { role: string; content: string }[] }).messages[0]?.content ?? '';
      return { choices: [{ message: { content: `context length ${system.length}` } }] };
    });
    await call(admin, 'POST', '/api/llm-endpoints', {
      name: 'Local model',
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      isDefault: true,
    });
    const doc = await createDoc(editor);
    // Far past the 24,000 character cap: a blank document has almost no
    // text, so pad it with a save carrying one long paragraph.
    const huge = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'word '.repeat(6000) }] }],
    };
    await app.inject({
      method: 'PUT',
      url: `/api/documents/${doc.id}`,
      headers: authHeader(editor),
      payload: { content: huge, expectedRevision: 1 },
    });

    const response = await call(editor, 'POST', `/api/documents/${doc.id}/chat`, { message: 'Summarise it' });
    expect(response.statusCode).toBe(200);
    expect(response.json().truncated).toBe(true);
  });

  it('refuses anyone without access to the document', async () => {
    const doc = await createDoc(admin);
    const stranger = await createAndLogin(app, admin, { email: 'st@example.com', name: 'Stranger' });
    const response = await call(stranger, 'POST', `/api/documents/${doc.id}/chat`, { message: 'Hi' });
    expect(response.statusCode).toBe(404);
  });

  it('refuses an anonymous request', async () => {
    const doc = await createDoc(editor);
    expect((await call(null, 'POST', `/api/documents/${doc.id}/chat`, { message: 'Hi' })).statusCode).toBe(401);
  });

  describe('chat settings', () => {
    it('defaults to no endpoint chosen', async () => {
      expect((await call(admin, 'GET', '/api/chat-settings')).json()).toEqual({ endpointId: null });
    });

    it('lets an administrator choose which endpoint Chat uses', async () => {
      const endpoint = (
        await call(admin, 'POST', '/api/llm-endpoints', { name: 'A', url: 'http://10.0.0.5' })
      ).json().endpoint;
      const response = await call(admin, 'PATCH', '/api/chat-settings', { endpointId: endpoint.id });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ endpointId: endpoint.id });
      expect((await call(admin, 'GET', '/api/chat-settings')).json()).toEqual({ endpointId: endpoint.id });
    });

    it('refuses an endpoint id that does not exist', async () => {
      const response = await call(admin, 'PATCH', '/api/chat-settings', {
        endpointId: '00000000-0000-0000-0000-000000000000',
      });
      expect(response.statusCode).toBe(400);
    });

    it('is refused to anyone who is not an administrator', async () => {
      expect((await call(editor, 'GET', '/api/chat-settings')).statusCode).toBe(403);
    });
  });
});
