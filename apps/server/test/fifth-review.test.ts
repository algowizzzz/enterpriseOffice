import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { isSafeHref, repairDocument, validateDoc, type PMNode } from '@docforge/model';
import { htmlToDocument } from '../src/docx/import.js';
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

  it('is refused on import rather than shown and then dropped', () => {
    const result = htmlToDocument('<p>Ring <a href="tel:+441234567890">the desk</a> first.</p>');
    expect(JSON.stringify(result.content)).not.toContain('tel:');
    expect(JSON.stringify(result.content)).toContain('the desk');
  });
});

describe('a list item holding only a nested list', () => {
  it('is given the paragraph the editor requires', () => {
    const result = htmlToDocument('<ul><li><ul><li>deep</li></ul></li></ul>');
    const item = result.content.content?.[0]?.content?.[0];
    expect(item?.type).toBe('listItem');
    expect(item?.content?.[0]?.type).toBe('paragraph');
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
