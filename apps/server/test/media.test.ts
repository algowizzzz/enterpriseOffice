import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { strFromU8, unzipSync } from 'fflate';
import { validateDoc, type PMNode } from '@docforge/model';
import { authHeader, createAndLogin, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';

/** A real PNG of noise, so that it is large and does not compress away. */
function noisyPng(side: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of data) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(kind), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: side }, () => Buffer.concat([Buffer.from([0]), randomBytes(side * 3)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

describe('pictures kept beside the document', () => {
  let app: FastifyInstance;
  let owner: TestActor;
  let stranger: TestActor;
  const png = noisyPng(200);
  const src = `data:image/png;base64,${png.toString('base64')}`;
  const withPicture: PMNode = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Figure: ' }, { type: 'image', attrs: { src, width: 100, height: 100 } }] }],
  };
  const call = (actor: TestActor, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: authHeader(actor), ...(payload === undefined ? {} : { payload }) });

  beforeEach(async () => {
    app = await makeApp();
    owner = await registerFirstAdmin(app);
    stranger = await createAndLogin(app, owner, { email: 'out@example.com', name: 'Sam Stranger' });
  });
  afterEach(async () => {
    await app.close();
  });

  it('takes a large picture out of the text when the document is saved, and serves it back unchanged', async () => {
    // A document's pictures used to travel inside its text on every save: forty
    // megabytes of pictures was forty megabytes of JSON each time somebody typed.
    const created = (await call(owner, 'POST', '/api/documents', { title: 'Report', content: withPicture })).json().document;
    const stored = JSON.stringify(created.content);
    expect(stored.length).toBeLessThan(1000);
    expect(validateDoc(created.content)).toEqual({ ok: true, errors: [] });
    const address = created.content.content[0].content[1].attrs.src as string;
    expect(address).toMatch(/^\/api\/media\/[0-9a-f]{64}$/u);
    const fetched = await call(owner, 'GET', address);
    expect(fetched.headers['content-type']).toBe('image/png');
    expect(fetched.rawPayload.equals(png)).toBe(true);
  });

  it('shows a picture only to somebody who can read a document it is in', async () => {
    const created = (await call(owner, 'POST', '/api/documents', { title: 'Report', content: withPicture })).json().document;
    const address = created.content.content[0].content[1].attrs.src as string;
    expect((await call(stranger, 'GET', address)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: address })).statusCode).toBe(401);
    await call(owner, 'PUT', `/api/documents/${created.id}/shares`, { userId: stranger.id, permission: 'view' });
    expect((await call(stranger, 'GET', address)).statusCode).toBe(200);
  });

  it('puts the picture itself into the Word file and the PDF', async () => {
    const created = (await call(owner, 'POST', '/api/documents', { title: 'Report', content: withPicture })).json().document;
    const word = await call(owner, 'GET', `/api/documents/${created.id}/export?format=docx`);
    const parts = unzipSync(new Uint8Array(word.rawPayload));
    const media = Object.keys(parts).filter((name) => name.startsWith('word/media/'));
    expect(media).toHaveLength(1);
    expect(Buffer.from(parts[media[0] as string] as Uint8Array).equals(png)).toBe(true);
    expect(strFromU8(parts['word/document.xml'] as Uint8Array)).toContain('<w:drawing>');
    const pdf = await call(owner, 'GET', `/api/documents/${created.id}/export?format=pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.length).toBeGreaterThan(png.length / 2);
  });

  it('still shows the picture in an earlier version after it has been deleted from the text', async () => {
    const created = (await call(owner, 'POST', '/api/documents', { title: 'Report', content: withPicture })).json().document;
    const address = created.content.content[0].content[1].attrs.src as string;
    await call(owner, 'PUT', `/api/documents/${created.id}`, { content: { type: 'doc', content: [{ type: 'paragraph' }] }, expectedRevision: 1 });
    expect((await call(owner, 'GET', address)).statusCode).toBe(200);
  });

  it('leaves a small picture where it is', async () => {
    const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { src: tiny } }] }] };
    const created = (await call(owner, 'POST', '/api/documents', { title: 'Icon', content })).json().document;
    expect(created.content.content[0].content[0].attrs.src).toBe(tiny);
  });
});
