import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { validateDoc, type PMNode } from '@docforge/model';
import { importDocx } from '../src/docx/import.js';
import { docxFixture, drawing, PNG_BYTES } from './docxFixture.js';
import { createUser } from '../src/services/users.js';
import { authHeader, createAndLogin, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';

const image = (attrs: Record<string, unknown>): unknown => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'image', attrs: { src: 'data:image/png;base64,AAAA', ...attrs } }],
    },
  ],
});

describe('an image pasted from a web page', () => {
  it('does not make the document unsavable', () => {
    // Regression: the editor stores what pasted markup carried, so an image with
    // width="100%" was refused on every later save. The person saw a generic
    // failure with no hint which element was at fault, and could not save that
    // document again at all.
    expect(validateDoc(image({ width: '100%', height: 'auto' })).ok).toBe(true);
    expect(validateDoc(image({ width: '800', height: '600' })).ok).toBe(true);
    expect(validateDoc(image({ width: '12.5em' })).ok).toBe(true);
  });

  it('still refuses a count that would produce a broken file', () => {
    expect(validateDoc(image({ width: 1000000000 })).ok).toBe(false);
    expect(validateDoc(image({ height: 0 })).ok).toBe(false);
    expect(validateDoc(image({ width: 12.5 })).ok).toBe(false);
  });

  it('refuses a dimension long enough to be a payload of its own', () => {
    expect(validateDoc(image({ width: 'x'.repeat(200) })).ok).toBe(false);
  });
});

describe('what an image may point at', () => {
  it('accepts data embedded in the document', () => {
    expect(validateDoc(image({})).ok).toBe(true);
  });

  it('refuses a remote address', () => {
    // The air gap forbids the page fetching anything, and the rule belongs on
    // the server because a document can be written by a client that is not the
    // editor.
    for (const src of ['https://example.com/logo.png', '//example.com/logo.png', '/local.png']) {
      const doc = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { src } }] }],
      };
      expect(validateDoc(doc).ok, src).toBe(false);
    }
  });
});

describe('link targets', () => {
  const link = (href: string): unknown => ({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }] },
    ],
  });

  it('refuses one that leaves the site without naming a scheme', () => {
    // "//host/path" inherits the page's scheme and goes off site, which the
    // content security policy does not stop for a navigation.
    expect(validateDoc(link('//evil.test/page')).ok).toBe(false);
    expect(validateDoc(link('https:///nohost')).ok).toBe(false);
  });

  it('still accepts the ordinary forms', () => {
    for (const href of ['https://intranet/page', 'http://intranet', 'mailto:a@b', '#anchor', '/local']) {
      expect(validateDoc(link(href)).ok, href).toBe(true);
    }
  });

  it('refuses the same shapes on import', async () => {
    const result = await importDocx(
      docxFixture({
        body: '<w:p><w:hyperlink r:id="rId1"><w:r><w:t>click</w:t></w:r></w:hyperlink></w:p>',
        relationships: { rId1: { target: '//evil.test/page', external: true } },
      }),
    );
    expect(JSON.stringify(result.content)).not.toContain('"link"');
  });
});

describe('alternative text longer than an attribute allows', () => {
  const withAlt = (alt: string): Buffer =>
    docxFixture({
      body:
        `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/>` +
        `<wp:docPr id="1" name="Picture" descr="${alt}"/><a:graphic><a:graphicData>` +
        `<a:blip r:embed="rId1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
      relationships: { rId1: { target: 'media/image1.png' } },
      media: { 'image1.png': PNG_BYTES },
    });

  it('is trimmed rather than having the whole upload refused', async () => {
    const result = await importDocx(withAlt('A'.repeat(6000)));
    expect(validateDoc(result.content).ok).toBe(true);
  });

  it('keeps ordinary alternative text as written', async () => {
    const result = await importDocx(withAlt('A dot'));
    expect(JSON.stringify(result.content)).toContain('A dot');
  });
});

describe('two administrators adding the same address at once', () => {
  let app: FastifyInstance;
  let admin: TestActor;

  beforeEach(async () => {
    app = await makeApp();
    admin = await registerFirstAdmin(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('is answered as a conflict, not as a server error', async () => {
    // Regression: hashing a password yields, so both requests passed the
    // duplicate check and the second insert broke the unique constraint, which
    // surfaced as an opaque server error.
    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        app.inject({
          method: 'POST',
          url: '/api/users',
          headers: authHeader(admin),
          payload: {
            email: 'same@example.com',
            name: 'Same Person',
            password: 'Correct-Horse-9',
            role: 'editor',
          },
        }),
      ),
    );

    const created = responses.filter((response) => response.statusCode === 201);
    expect(created).toHaveLength(1);
    for (const response of responses.filter((r) => r.statusCode !== 201)) {
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CONFLICT');
    }
  });

  it('reports a duplicate from the service as a conflict too', async () => {
    await createUser(app.db, {
      email: 'dup@example.com',
      name: 'First',
      password: 'Correct-Horse-9',
      role: 'editor',
    });
    await expect(
      createUser(app.db, {
        email: 'DUP@example.com',
        name: 'Second',
        password: 'Correct-Horse-9',
        role: 'editor',
      }),
    ).rejects.toThrow(/already exists/u);
  });
});

describe('downloading is limited like uploading', () => {
  it('refuses a burst of exports', async () => {
    // Writing a Word file costs as much as reading one, and anyone with a view
    // share could ask for the same large document over and over.
    const app = await makeApp();
    try {
      const admin = await registerFirstAdmin(app);
      const owner = await createAndLogin(app, admin, { email: 'o@example.com', name: 'Olive' });
      const created = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: authHeader(owner),
        payload: {
          title: 'Heavy',
          content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
        },
      });
      const id = created.json().document.id;

      const statuses: number[] = [];
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/documents/${id}/export`,
          headers: authHeader(owner),
          remoteAddress: '198.51.100.21',
        });
        statuses.push(response.statusCode);
      }
      expect(statuses).toContain(429);
      expect(statuses).toContain(200);
    } finally {
      await app.close();
    }
  });
});

describe('the budget for embedded pictures', () => {
  it('sits below the limit on a stored document', async () => {
    // Otherwise an image-heavy file passed the reader and was then refused with
    // an unrelated message about the document's size.
    const { MAX_CONTENT_BYTES } = await import('../src/services/documents.js');
    const oneMegabyte = new Uint8Array(1024 * 1024);
    const media: Record<string, Uint8Array> = {};
    const relationships: Record<string, { target: string }> = {};
    let body = '';
    for (let index = 1; index <= 12; index += 1) {
      media[`image${index}.png`] = oneMegabyte;
      relationships[`rId${index}`] = { target: `media/image${index}.png` };
      body += drawing(`rId${index}`);
    }
    const result = await importDocx(docxFixture({ body, relationships, media }));
    // What is stored is the document with its pictures taken out into their own
    // store, which is what keeps this true however many pictures there are.
    const { takePicturesOut } = await import('../src/services/media.js');
    const stored = takePicturesOut(result.content);
    const size = Buffer.byteLength(JSON.stringify(stored.doc), 'utf8');
    expect(size).toBeLessThan(MAX_CONTENT_BYTES);
    expect(stored.pictures).toHaveLength(1);
  });
});

describe('a table inside a quote', () => {
  it('is indented with the quote it sits in', async () => {
    const { exportDocx } = await import('../src/docx/export.js');
    const cell = (text: string): PMNode => ({
      type: 'tableCell',
      attrs: { colspan: 1, rowspan: 1, colwidth: null },
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const doc: PMNode = {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [
            { type: 'table', content: [{ type: 'tableRow', content: [cell('Inside')] }] },
          ],
        },
      ],
    };
    const buffer = await exportDocx(doc, { title: 'Quoted table' });
    // The file is compressed, so read the part that actually holds the markup.
    const { unzipSync, strFromU8 } = await import('fflate');
    const parts = unzipSync(new Uint8Array(buffer));
    const documentXml = strFromU8(parts['word/document.xml'] as Uint8Array);
    expect(documentXml).toContain('Inside');
    // The cell's paragraph carries the quote's indent.
    expect(documentXml).toMatch(/<w:ind [^>]*w:left="720"/u);
  });
});
