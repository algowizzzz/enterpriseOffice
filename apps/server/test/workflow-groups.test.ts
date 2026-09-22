import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, createAndLogin, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';

describe('workflow groups', () => {
  let app: FastifyInstance;
  let admin: TestActor;
  let editor: TestActor;
  const call = (actor: TestActor | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
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

  it('is empty until an administrator creates a group', async () => {
    expect((await call(admin, 'GET', '/api/workflow-groups')).json().groups).toEqual([]);
  });

  it('lets an administrator create a group with its analysis prompts and a summary prompt', async () => {
    const response = await call(admin, 'POST', '/api/workflow-groups', {
      name: 'Policy prompts',
      description: 'Checked against the policy template.',
      docType: 'Policy',
      analysisPrompts: ['Does the document name an owner?', 'Is the review date within a year?'],
      summaryPrompt: 'Summarise the gaps found above for the document owner.',
    });
    expect(response.statusCode).toBe(201);
    const { group } = response.json();
    expect(group).toMatchObject({
      name: 'Policy prompts',
      docType: 'Policy',
      isDefault: false,
      endpointId: null,
    });
    // The summary prompt is first, despite running last (docs/16 §4).
    expect(group.prompts).toHaveLength(3);
    expect(group.prompts[0]).toMatchObject({
      role: 'summary',
      text: 'Summarise the gaps found above for the document owner.',
    });
    expect(group.prompts[1]).toMatchObject({ role: 'analysis', position: 0, text: 'Does the document name an owner?' });
    expect(group.prompts[2]).toMatchObject({ role: 'analysis', position: 1, text: 'Is the review date within a year?' });

    const { groups } = (await call(admin, 'GET', '/api/workflow-groups')).json();
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe(group.id);
  });

  it('refuses an empty name, a whitespace-only prompt, and more than the cap of analysis prompts', async () => {
    expect(
      (await call(admin, 'POST', '/api/workflow-groups', { name: '', summaryPrompt: 'Summarise.' })).statusCode,
    ).toBe(400);
    expect(
      (
        await call(admin, 'POST', '/api/workflow-groups', {
          name: 'Group',
          analysisPrompts: ['   '],
          summaryPrompt: 'Summarise.',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(admin, 'POST', '/api/workflow-groups', {
          name: 'Too many',
          analysisPrompts: Array.from({ length: 11 }, (_, i) => `Prompt ${i}`),
          summaryPrompt: 'Summarise.',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('is refused to anyone who is not an administrator', async () => {
    expect((await call(editor, 'GET', '/api/workflow-groups')).statusCode).toBe(403);
    expect(
      (await call(editor, 'POST', '/api/workflow-groups', { name: 'Mine', summaryPrompt: 'Summarise.' })).statusCode,
    ).toBe(403);
    expect((await call(null, 'GET', '/api/workflow-groups')).statusCode).toBe(401);
  });

  it('lets only one group be the default for a document type', async () => {
    const first = (
      await call(admin, 'POST', '/api/workflow-groups', {
        name: 'Standard A',
        docType: 'Standard',
        isDefault: true,
        summaryPrompt: 'Summarise.',
      })
    ).json().group;
    const second = (
      await call(admin, 'POST', '/api/workflow-groups', {
        name: 'Standard B',
        docType: 'Standard',
        isDefault: true,
        summaryPrompt: 'Summarise.',
      })
    ).json().group;

    const { groups } = (await call(admin, 'GET', '/api/workflow-groups')).json();
    const byId = Object.fromEntries(groups.map((entry: { id: string; isDefault: boolean }) => [entry.id, entry.isDefault]));
    expect(byId[first.id]).toBe(false);
    expect(byId[second.id]).toBe(true);
  });

  it('does not take the default away from a different document type', async () => {
    const policy = (
      await call(admin, 'POST', '/api/workflow-groups', {
        name: 'Policy',
        docType: 'Policy',
        isDefault: true,
        summaryPrompt: 'Summarise.',
      })
    ).json().group;
    await call(admin, 'POST', '/api/workflow-groups', {
      name: 'Framework',
      docType: 'Framework',
      isDefault: true,
      summaryPrompt: 'Summarise.',
    });

    const { groups } = (await call(admin, 'GET', '/api/workflow-groups')).json();
    const stillPolicy = groups.find((entry: { id: string }) => entry.id === policy.id);
    expect(stillPolicy.isDefault).toBe(true);
  });

  it('updates a group’s own fields, and can delete it', async () => {
    const created = (
      await call(admin, 'POST', '/api/workflow-groups', { name: 'Draft', summaryPrompt: 'Summarise.' })
    ).json().group;

    const updated = (
      await call(admin, 'PATCH', `/api/workflow-groups/${created.id}`, { name: 'Draft, renamed' })
    ).json().group;
    expect(updated.name).toBe('Draft, renamed');

    expect((await call(admin, 'DELETE', `/api/workflow-groups/${created.id}`)).statusCode).toBe(200);
    expect((await call(admin, 'GET', '/api/workflow-groups')).json().groups).toEqual([]);
  });

  it('reports a group that does not exist rather than deleting nothing silently', async () => {
    expect((await call(admin, 'DELETE', '/api/workflow-groups/00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
  });

  describe('prompts', () => {
    const createGroup = async () =>
      (
        await call(admin, 'POST', '/api/workflow-groups', {
          name: 'Draft',
          analysisPrompts: ['First prompt.'],
          summaryPrompt: 'Summarise the above.',
        })
      ).json().group;

    it('adds an analysis prompt, appended after the existing ones', async () => {
      const group = await createGroup();
      const response = await call(admin, 'POST', `/api/workflow-groups/${group.id}/prompts`, {
        role: 'analysis',
        text: 'Second prompt.',
      });
      expect(response.statusCode).toBe(201);
      const analysis = response.json().group.prompts.filter((p: { role: string }) => p.role === 'analysis');
      expect(analysis).toHaveLength(2);
      expect(analysis[1]).toMatchObject({ position: 1, text: 'Second prompt.' });
    });

    it('refuses a second summary prompt', async () => {
      const group = await createGroup();
      const response = await call(admin, 'POST', `/api/workflow-groups/${group.id}/prompts`, {
        role: 'summary',
        text: 'Another summary.',
      });
      expect(response.statusCode).toBe(409);
    });

    it('refuses an analysis prompt past the cap', async () => {
      const group = await createGroup();
      for (let i = 0; i < 9; i += 1) {
        await call(admin, 'POST', `/api/workflow-groups/${group.id}/prompts`, {
          role: 'analysis',
          text: `Prompt ${i}`,
        });
      }
      // 1 (from creation) + 9 = 10, at the cap.
      const response = await call(admin, 'POST', `/api/workflow-groups/${group.id}/prompts`, {
        role: 'analysis',
        text: 'One too many',
      });
      expect(response.statusCode).toBe(409);
    });

    it('edits a prompt’s text without changing its role', async () => {
      const group = await createGroup();
      const promptId = group.prompts.find((p: { role: string }) => p.role === 'analysis').id;
      const response = await call(admin, 'PATCH', `/api/workflow-groups/${group.id}/prompts/${promptId}`, {
        text: 'Edited text.',
      });
      expect(response.statusCode).toBe(200);
      const edited = response.json().group.prompts.find((p: { id: string }) => p.id === promptId);
      expect(edited).toMatchObject({ role: 'analysis', text: 'Edited text.' });
    });

    it('deletes an analysis prompt and closes the position gap', async () => {
      const group = await createGroup();
      await call(admin, 'POST', `/api/workflow-groups/${group.id}/prompts`, {
        role: 'analysis',
        text: 'Second prompt.',
      });
      const withSecond = (await call(admin, 'GET', '/api/workflow-groups')).json().groups[0];
      const first = withSecond.prompts.find((p: { text: string }) => p.text === 'First prompt.');

      const response = await call(admin, 'DELETE', `/api/workflow-groups/${group.id}/prompts/${first.id}`);
      expect(response.statusCode).toBe(200);
      const analysis = response.json().group.prompts.filter((p: { role: string }) => p.role === 'analysis');
      expect(analysis).toEqual([expect.objectContaining({ text: 'Second prompt.', position: 0 })]);
    });

    it('refuses to delete the only summary prompt', async () => {
      const group = await createGroup();
      const summary = group.prompts.find((p: { role: string }) => p.role === 'summary');
      const response = await call(admin, 'DELETE', `/api/workflow-groups/${group.id}/prompts/${summary.id}`);
      expect(response.statusCode).toBe(409);
    });

    it('reorders the analysis prompts', async () => {
      const group = await createGroup();
      await call(admin, 'POST', `/api/workflow-groups/${group.id}/prompts`, {
        role: 'analysis',
        text: 'Second prompt.',
      });
      const loaded = (await call(admin, 'GET', '/api/workflow-groups')).json().groups[0];
      const [first, second] = loaded.prompts.filter((p: { role: string }) => p.role === 'analysis');

      const response = await call(admin, 'POST', `/api/workflow-groups/${group.id}/prompts/reorder`, {
        promptIds: [second.id, first.id],
      });
      expect(response.statusCode).toBe(200);
      const analysis = response.json().group.prompts.filter((p: { role: string }) => p.role === 'analysis');
      expect(analysis.map((p: { text: string }) => p.text)).toEqual(['Second prompt.', 'First prompt.']);
    });

    it('refuses a reorder that does not name exactly the current analysis prompts', async () => {
      const group = await createGroup();
      const summary = group.prompts.find((p: { role: string }) => p.role === 'summary');
      const response = await call(admin, 'POST', `/api/workflow-groups/${group.id}/prompts/reorder`, {
        promptIds: [summary.id],
      });
      expect(response.statusCode).toBe(409);
    });
  });
});
