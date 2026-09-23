import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, createAndLogin, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';

/** Analysis has no real model in the automated suite: a loopback HTTP server stands in for one. */
describe('AI Analysis', () => {
  let app: FastifyInstance;
  let admin: TestActor;
  let editor: TestActor;
  let server: Server | undefined;
  const call = (actor: TestActor | null, method: 'GET' | 'POST', url: string, payload?: object) =>
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

  // Creating a document with a doc type is only reachable through the Word
  // import route today, which needs a real .docx buffer; the API this test
  // is exercising does not care how the document got its type, only what it
  // is, so it is set directly rather than building an import fixture just
  // for this test's setup.
  const createDoc = async (actor: TestActor, docType?: string) => {
    const document = (
      await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: authHeader(actor),
        payload: { title: 'Doc' },
      })
    ).json().document;
    if (docType) app.db.prepare('UPDATE documents SET doc_type = ? WHERE id = ?').run(docType, document.id);
    return { ...document, docType: docType ?? null };
  };

  const createGroup = async (over: object = {}) =>
    (
      await call(admin, 'POST', '/api/workflow-groups', {
        name: 'Policy prompts',
        analysisPrompts: ['Does it name an owner?', 'Is it dated?'],
        summaryPrompt: 'Summarise the two findings above.',
        ...over,
      })
    ).json().group;

  it('lists only groups that apply to the document’s own type, plus type-agnostic ones', async () => {
    await createGroup({ name: 'Any type' });
    await createGroup({ name: 'Policy only', docType: 'Policy' });
    await createGroup({ name: 'Framework only', docType: 'Framework' });
    const doc = await createDoc(editor, 'Policy');

    const { groups } = (await call(editor, 'GET', `/api/documents/${doc.id}/workflow-groups`)).json();
    expect(groups.map((g: { name: string }) => g.name).sort()).toEqual(['Any type', 'Policy only']);
    // Only id/name/description travel to a non-admin: no prompt text.
    expect(groups[0].prompts).toBeUndefined();
  });

  it('runs every analysis prompt and the summary, returning both', async () => {
    const port = await startFakeModel((body) => {
      const userText = (body as { messages: { role: string; content: string }[] }).messages.at(-1)?.content ?? '';
      return { choices: [{ message: { content: `Answer to: ${userText}` } }] };
    });
    await call(admin, 'POST', '/api/llm-endpoints', {
      name: 'Local model',
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      isDefault: true,
    });
    const group = await createGroup();
    const doc = await createDoc(editor);

    const response = await call(editor, 'POST', `/api/documents/${doc.id}/analysis/run`, {
      groupId: group.id,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.analysis).toHaveLength(2);
    expect(body.analysis[0]).toMatchObject({ text: 'Does it name an owner?' });
    expect(body.analysis[0].output).toMatch(/^Answer to:/);
    expect(body.summary).toMatch(/^Answer to:/);
  });

  it('reports which endpoint the run used, without exposing prompt text or output in the audit trail', async () => {
    const port = await startFakeModel(() => ({ choices: [{ message: { content: 'ok' } }] }));
    const endpoint = (
      await call(admin, 'POST', '/api/llm-endpoints', {
        name: 'Local model',
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        isDefault: true,
      })
    ).json().endpoint;
    const group = await createGroup();
    const doc = await createDoc(editor);

    await call(editor, 'POST', `/api/documents/${doc.id}/analysis/run`, { groupId: group.id });

    const { entries } = (await call(admin, 'GET', '/api/audit')).json();
    const entry = entries.find((e: { action: string }) => e.action === 'analysis.run');
    expect(entry).toBeDefined();
    expect(entry.targetId).toBe(doc.id);
    expect(entry.detail).toMatchObject({ groupId: group.id, endpointId: endpoint.id, ok: true });
    expect(JSON.stringify(entry.detail)).not.toMatch(/Does it name an owner/);
  });

  it('refuses a group that does not apply to the document’s type', async () => {
    const group = await createGroup({ name: 'Framework only', docType: 'Framework' });
    const doc = await createDoc(editor, 'Policy');
    const response = await call(editor, 'POST', `/api/documents/${doc.id}/analysis/run`, { groupId: group.id });
    expect(response.statusCode).toBe(400);
  });

  it('reports no endpoint configured, and keeps the analysis output already produced when only the summary fails', async () => {
    const group = await createGroup();
    const doc = await createDoc(editor);
    const response = await call(editor, 'POST', `/api/documents/${doc.id}/analysis/run`, { groupId: group.id });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false });
    expect(response.json().message).toMatch(/no ai endpoint is configured/i);
  });

  it('refuses anyone without access to the document', async () => {
    const group = await createGroup();
    const doc = await createDoc(admin);
    const stranger = await createAndLogin(app, admin, { email: 'st@example.com', name: 'Stranger' });
    const response = await call(stranger, 'POST', `/api/documents/${doc.id}/analysis/run`, { groupId: group.id });
    expect(response.statusCode).toBe(404);
  });
});
