import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, createAndLogin, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';
import {
  defaultExportTemplate,
  exportTemplateFrom,
  sniffImageMediaType,
  unknownTokensIn,
} from '../src/services/exportTemplate.js';

// A genuine, minimal valid 1x1 PNG -- unlike the fake header below, this one
// needs to survive actually being embedded in a real docx package.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/** Satisfies the PNG magic-byte check and the IHDR dimension reader, nothing more -- for testing rejection before any real image processing happens. */
function fakePngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function multipartUpload(bytes: Buffer, filename = 'logo.png', contentType = 'image/png'): { payload: Buffer; contentType: string } {
  const boundary = '----t';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

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

describe('sniffImageMediaType', () => {
  it('reads PNG and JPEG from their own magic bytes, not a claimed extension', () => {
    expect(sniffImageMediaType(fakePngHeader(10, 10))).toBe('image/png');
    expect(sniffImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });

  it('refuses anything else, including an SVG’s XML preamble', () => {
    expect(sniffImageMediaType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">', 'utf8'))).toBeNull();
    expect(sniffImageMediaType(Buffer.from('<?xml version="1.0"?>', 'utf8'))).toBeNull();
    expect(sniffImageMediaType(Buffer.alloc(0))).toBeNull();
  });
});

describe('export template logo', () => {
  let app: FastifyInstance;
  let admin: TestActor;
  let editor: TestActor;

  beforeEach(async () => {
    app = await makeApp();
    admin = await registerFirstAdmin(app);
    editor = await createAndLogin(app, admin, { email: 'ed@example.com', name: 'Ed Editor' });
  });
  afterEach(async () => {
    await app.close();
  });

  it('has no logo until one is uploaded', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/export-template',
      headers: authHeader(admin),
    });
    expect(response.json().template.logo).toBeNull();
  });

  it('accepts a real PNG, storing it and returning it as a data URL', async () => {
    const upload = multipartUpload(TINY_PNG);
    const response = await app.inject({
      method: 'POST',
      url: '/api/export-template/logo',
      headers: { ...authHeader(admin), 'content-type': upload.contentType },
      payload: upload.payload,
    });
    expect(response.statusCode).toBe(200);
    const { logo } = response.json().template;
    expect(logo.mediaType).toBe('image/png');
    expect(logo.dataUrl).toMatch(/^data:image\/png;base64,/u);

    const stored = await app.inject({ method: 'GET', url: '/api/export-template', headers: authHeader(admin) });
    expect(stored.json().template.logo.dataUrl).toBe(logo.dataUrl);
  });

  it('uploading a logo does not disturb the text fields already saved', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/export-template',
      headers: authHeader(admin),
      payload: { body: { fontFamily: 'Georgia', fontSize: 12, color: '#111111' } },
    });
    const upload = multipartUpload(TINY_PNG);
    await app.inject({
      method: 'POST',
      url: '/api/export-template/logo',
      headers: { ...authHeader(admin), 'content-type': upload.contentType },
      payload: upload.payload,
    });
    const after = await app.inject({ method: 'GET', url: '/api/export-template', headers: authHeader(admin) });
    expect(after.json().template.body.fontFamily).toBe('Georgia');
  });

  it('refuses a file that is not a PNG or JPEG, an SVG included', async () => {
    const upload = multipartUpload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'), 'logo.svg', 'image/svg+xml');
    const response = await app.inject({
      method: 'POST',
      url: '/api/export-template/logo',
      headers: { ...authHeader(admin), 'content-type': upload.contentType },
      payload: upload.payload,
    });
    expect(response.statusCode).toBe(415);
  });

  it('refuses a file larger than the cap', async () => {
    const huge = Buffer.concat([fakePngHeader(10, 10), Buffer.alloc(600 * 1024)]);
    const upload = multipartUpload(huge);
    const response = await app.inject({
      method: 'POST',
      url: '/api/export-template/logo',
      headers: { ...authHeader(admin), 'content-type': upload.contentType },
      payload: upload.payload,
    });
    expect(response.statusCode).toBe(413);
  });

  it('refuses an image larger than the dimension cap', async () => {
    const upload = multipartUpload(fakePngHeader(3000, 10));
    const response = await app.inject({
      method: 'POST',
      url: '/api/export-template/logo',
      headers: { ...authHeader(admin), 'content-type': upload.contentType },
      payload: upload.payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/2000/u);
  });

  it('refuses an empty upload', async () => {
    const upload = multipartUpload(Buffer.alloc(0));
    const response = await app.inject({
      method: 'POST',
      url: '/api/export-template/logo',
      headers: { ...authHeader(admin), 'content-type': upload.contentType },
      payload: upload.payload,
    });
    expect(response.statusCode).toBe(400);
  });

  it('is refused to anyone who is not an administrator', async () => {
    const upload = multipartUpload(TINY_PNG);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/export-template/logo',
          headers: { ...authHeader(editor), 'content-type': upload.contentType },
          payload: upload.payload,
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/export-template/logo' })).statusCode).toBe(401);
  });

  it('removes a logo', async () => {
    const upload = multipartUpload(TINY_PNG);
    await app.inject({
      method: 'POST',
      url: '/api/export-template/logo',
      headers: { ...authHeader(admin), 'content-type': upload.contentType },
      payload: upload.payload,
    });
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/export-template/logo',
      headers: authHeader(admin),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().template.logo).toBeNull();
  });
});
