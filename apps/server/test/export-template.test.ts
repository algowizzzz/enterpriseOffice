import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, createAndLogin, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';
import { defaultExportTemplate, exportTemplateFrom, unknownTokensIn } from '../src/services/exportTemplate.js';

describe('export template defaults and parsing', () => {
  it('gives every heading level a considered default, not a placeholder', () => {
    const template = defaultExportTemplate();
    expect(template.headings).toHaveLength(6);
    expect(template.body).toMatchObject({ fontFamily: 'Carlito', fontSize: 11, color: '#000000' });
    // Sizes step down from Heading 1 to Heading 6, the same shape a real house style has.
    for (let i = 1; i < 6; i += 1) {
      expect(template.headings[i]!.fontSize).toBeLessThanOrEqual(template.headings[i - 1]!.fontSize);
    }
  });

  it('repairs a malformed or partial value field by field, rather than refusing it', () => {
    const template = exportTemplateFrom(
      { header: { left: { content: 'ok', fontSize: 'not a number', color: 'not a colour' } }, body: null },
      '2026-01-01T00:00:00.000Z',
      null,
    );
    expect(template.header.left.content).toBe('ok');
    expect(template.header.left.fontSize).toBe(defaultExportTemplate().header.left.fontSize);
    expect(template.header.left.color).toBe(defaultExportTemplate().header.left.color);
    expect(template.body).toEqual(defaultExportTemplate().body);
    // The other side, never mentioned in the input, still comes back whole.
    expect(template.header.right).toEqual(defaultExportTemplate().header.right);
  });

  it('finds a token that is not in the known vocabulary', () => {
    expect(unknownTokensIn('{{document.title}} — {{page}} of {{pageCount}}')).toEqual([]);
    expect(unknownTokensIn('{{document.owner}}')).toEqual(['document.owner']);
  });
});

describe('export template routes', () => {
  let app: FastifyInstance;
  let admin: TestActor;
  let editor: TestActor;
  const call = (actor: TestActor | null, method: 'GET' | 'PATCH', url: string, payload?: object) =>
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

  it('returns the default template before anyone has changed it', async () => {
    const response = await call(admin, 'GET', '/api/export-template');
    expect(response.statusCode).toBe(200);
    expect(response.json().template.body.fontFamily).toBe('Carlito');
  });

  it('is refused to anyone who is not an administrator', async () => {
    expect((await call(editor, 'GET', '/api/export-template')).statusCode).toBe(403);
    expect((await call(null, 'GET', '/api/export-template')).statusCode).toBe(401);
    expect((await call(editor, 'PATCH', '/api/export-template', {})).statusCode).toBe(403);
  });

  it('lets an administrator update just the body style, keeping everything else', async () => {
    const before = (await call(admin, 'GET', '/api/export-template')).json().template;
    const response = await call(admin, 'PATCH', '/api/export-template', {
      body: { fontFamily: 'Georgia', fontSize: 12, color: '#111111' },
    });
    expect(response.statusCode).toBe(200);
    const { template } = response.json();
    expect(template.body).toEqual({ fontFamily: 'Georgia', fontSize: 12, color: '#111111' });
    expect(template.headings).toEqual(before.headings);

    // And it stuck.
    expect((await call(admin, 'GET', '/api/export-template')).json().template.body.fontFamily).toBe('Georgia');
  });

  it('updates a heading level', async () => {
    const before = (await call(admin, 'GET', '/api/export-template')).json().template;
    const headings = before.headings.map((h: object, i: number) =>
      i === 0 ? { ...h, color: '#FF0000', fontSize: 24 } : h,
    );
    const response = await call(admin, 'PATCH', '/api/export-template', { headings });
    expect(response.statusCode).toBe(200);
    expect(response.json().template.headings[0]).toMatchObject({ color: '#FF0000', fontSize: 24 });
  });

  it('refuses an invalid colour or an out-of-range font size', async () => {
    const before = (await call(admin, 'GET', '/api/export-template')).json().template;
    expect(
      (
        await call(admin, 'PATCH', '/api/export-template', {
          body: { ...before.body, color: 'blue' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(admin, 'PATCH', '/api/export-template', {
          body: { ...before.body, fontSize: 200 },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('refuses a header or footer content token that is not in the known vocabulary', async () => {
    const before = (await call(admin, 'GET', '/api/export-template')).json().template;
    const response = await call(admin, 'PATCH', '/api/export-template', {
      header: {
        left: { ...before.header.left, content: '{{document.owner}}' },
        right: before.header.right,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/document\.owner/);
  });

  it('accepts a known token in header or footer content', async () => {
    const before = (await call(admin, 'GET', '/api/export-template')).json().template;
    const response = await call(admin, 'PATCH', '/api/export-template', {
      footer: {
        left: { ...before.footer.left, content: '{{document.title}}' },
        right: { ...before.footer.right, content: 'Page {{page}} of {{pageCount}}' },
      },
    });
    expect(response.statusCode).toBe(200);
  });
});
