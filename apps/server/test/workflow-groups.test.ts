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

  it('lets an administrator create a group with its prompts and a summary of what they produce', async () => {
    const response = await call(admin, 'POST', '/api/workflow-groups', {
      name: 'Policy prompts',
      description: 'Checked against the policy template.',
      docType: 'Policy',
      prompts: ['Does the document name an owner?', 'Is the review date within a year?'],
      outputSummary: 'A list of gaps against the template, for the document owner to act on.',
    });
    expect(response.statusCode).toBe(201);
    const { group } = response.json();
    expect(group).toMatchObject({
      name: 'Policy prompts',
      docType: 'Policy',
      isDefault: false,
      prompts: ['Does the document name an owner?', 'Is the review date within a year?'],
      outputSummary: 'A list of gaps against the template, for the document owner to act on.',
    });

    const { groups } = (await call(admin, 'GET', '/api/workflow-groups')).json();
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe(group.id);
  });

  it('refuses an empty name and a prompt that is only whitespace', async () => {
    expect((await call(admin, 'POST', '/api/workflow-groups', { name: '' })).statusCode).toBe(400);
    expect(
      (await call(admin, 'POST', '/api/workflow-groups', { name: 'Group', prompts: ['   '] })).statusCode,
    ).toBe(400);
  });

  it('is refused to anyone who is not an administrator', async () => {
    expect((await call(editor, 'GET', '/api/workflow-groups')).statusCode).toBe(403);
    expect((await call(editor, 'POST', '/api/workflow-groups', { name: 'Mine' })).statusCode).toBe(403);
    expect((await call(null, 'GET', '/api/workflow-groups')).statusCode).toBe(401);
  });

  it('lets only one group be the default for a document type', async () => {
    const first = (
      await call(admin, 'POST', '/api/workflow-groups', { name: 'Standard A', docType: 'Standard', isDefault: true })
    ).json().group;
    const second = (
      await call(admin, 'POST', '/api/workflow-groups', { name: 'Standard B', docType: 'Standard', isDefault: true })
    ).json().group;

    const { groups } = (await call(admin, 'GET', '/api/workflow-groups')).json();
    const byId = Object.fromEntries(groups.map((entry: { id: string; isDefault: boolean }) => [entry.id, entry.isDefault]));
    expect(byId[first.id]).toBe(false);
    expect(byId[second.id]).toBe(true);
  });

  it('does not take the default away from a different document type', async () => {
    const policy = (
      await call(admin, 'POST', '/api/workflow-groups', { name: 'Policy', docType: 'Policy', isDefault: true })
    ).json().group;
    await call(admin, 'POST', '/api/workflow-groups', { name: 'Framework', docType: 'Framework', isDefault: true });

    const { groups } = (await call(admin, 'GET', '/api/workflow-groups')).json();
    const stillPolicy = groups.find((entry: { id: string }) => entry.id === policy.id);
    expect(stillPolicy.isDefault).toBe(true);
  });

  it('updates a group, and can delete it', async () => {
    const created = (await call(admin, 'POST', '/api/workflow-groups', { name: 'Draft' })).json().group;

    const updated = (
      await call(admin, 'PATCH', `/api/workflow-groups/${created.id}`, {
        name: 'Draft, renamed',
        prompts: ['One prompt now.'],
      })
    ).json().group;
    expect(updated.name).toBe('Draft, renamed');
    expect(updated.prompts).toEqual(['One prompt now.']);

    expect((await call(admin, 'DELETE', `/api/workflow-groups/${created.id}`)).statusCode).toBe(200);
    expect((await call(admin, 'GET', '/api/workflow-groups')).json().groups).toEqual([]);
  });

  it('reports a group that does not exist rather than deleting nothing silently', async () => {
    expect((await call(admin, 'DELETE', '/api/workflow-groups/00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
  });
});
