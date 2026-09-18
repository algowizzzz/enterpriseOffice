import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { isSafeHref, repairDocument, validateDoc, type PMNode } from '@docforge/model';
import { importDocx } from '../src/docx/import.js';
import { docxFixture } from './docxFixture.js';
import { restoreVersion } from '../src/services/documents.js';
import { authHeader, createAndLogin, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';

describe('restoring a version stored under older rules', () => {
  let app: FastifyInstance;
  let admin: TestActor;
  let owner: TestActor;

  beforeEach(async () => {
    app = await makeApp();
    admin = await registerFirstAdmin(app);
    owner = await createAndLogin(app, admin, { email: 'o@example.com', name: 'Olive' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('succeeds although the stored content would be refused today', async () => {
    // Regression: a rule was tightened while this write path had no repair in
    // front of it, so "History → Restore" failed with "Document content is not
    // valid" and never succeeded, on the version people most want back: the
    // document as it was uploaded.
    const created = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: authHeader(owner),
      payload: {
        title: 'Old',
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
      },
    });
    const id = created.json().document.id as string;

    // Write a shape an older build accepted straight into the stored version.
    const legacy = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1 } }] }],
        },
      ],
    });
    app.db
      .prepare('UPDATE document_versions SET content = ? WHERE document_id = ? AND revision = 1')
      .run(legacy, id);

    const restored = restoreVersion(app.db, { id: owner.id, role: 'editor' }, id, 1);
    expect(validateDoc(restored.content)).toEqual({ ok: true, errors: [] });
  });
});

describe('a link the model will not store', () => {
  it('is named by one rule, which the editor can apply as well', () => {
    for (const href of ['https://intranet/page', 'mailto:a@b', '#top', '/local']) {
      expect(isSafeHref(href), href).toBe(true);
    }
    for (const href of ['tel:+441234567890', 'ftp://host/file', '../sibling.html', '//evil.test']) {
      expect(isSafeHref(href), href).toBe(false);
    }
  });

  it('is refused on import rather than shown and then dropped', async () => {
    const result = await importDocx(
      docxFixture({
        body: '<w:p><w:hyperlink r:id="rId1"><w:r><w:t>the desk</w:t></w:r></w:hyperlink></w:p>',
        relationships: { rId1: { target: 'tel:+441234567890', external: true } },
      }),
    );
    expect(JSON.stringify(result.content)).not.toContain('tel:');
    expect(JSON.stringify(result.content)).toContain('the desk');
  });
});

describe('a list item holding only a nested list', () => {
  it('is given the paragraph the editor requires', async () => {
    const numbering =
      '<w:numbering><w:abstractNum w:abstractNumId="0">' +
      '<w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>' +
      '<w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>' +
      '</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';
    const item = (level: string, text: string): string =>
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr></w:pPr>` +
      `<w:r><w:t>${text}</w:t></w:r></w:p>`;
    const result = await importDocx(
      docxFixture({ body: `${item('0', '')}${item('1', 'deep')}`, numbering }),
    );
    const listItem = result.content.content?.[0]?.content?.[0];
    expect(listItem?.type).toBe('listItem');
    expect(listItem?.content?.[0]?.type).toBe('paragraph');
    expect(JSON.stringify(result.content)).toContain('deep');
  });
});

describe('a page break', () => {
  it('survives a document the model accepts', () => {
    const doc: PMNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Page one' }] },
        { type: 'pageBreak' },
        { type: 'paragraph', content: [{ type: 'text', text: 'Page two' }] },
      ],
    };
    expect(validateDoc(doc).ok).toBe(true);
    expect(repairDocument(doc)).toEqual({ doc, changed: false, removed: false });
  });

  it('is written into the Word file as a break', async () => {
    const { exportDocx } = await import('../src/docx/export.js');
    const buffer = await exportDocx(
      {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
          { type: 'pageBreak' },
        ],
      },
      { title: 'Broken up' },
    );
    const { unzipSync, strFromU8 } = await import('fflate');
    const xml = strFromU8(unzipSync(new Uint8Array(buffer))['word/document.xml'] as Uint8Array);
    expect(xml).toMatch(/<w:pageBreakBefore/u);
  });
});
