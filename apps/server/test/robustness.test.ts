import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { toPlainText, validateDoc, wordCount, type PMNode } from '@docforge/model';
import { exportDocx } from '../src/docx/export.js';
import { importDocx } from '../src/docx/import.js';
import { authHeader, createAndLogin, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';

/** A document of the size a real report reaches, rather than a three-line fixture. */
function largeDocument(paragraphs: number): PMNode {
  const content: PMNode[] = [];
  for (let i = 0; i < paragraphs; i += 1) {
    if (i % 10 === 0) {
      content.push({
        type: 'heading',
        attrs: { level: (i % 30 === 0 ? 1 : 2) },
        content: [{ type: 'text', text: `Section ${i / 10 + 1}` }],
      });
    }
    content.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: `Paragraph ${i}. ` },
        { type: 'text', text: 'An emphasised clause', marks: [{ type: 'italic' }] },
        { type: 'text', text: ' followed by ordinary prose that runs on for a while.' },
      ],
    });
  }
  return { type: 'doc', content };
}

describe('large documents', () => {
  it('validates a thousand-paragraph document quickly', () => {
    const doc = largeDocument(1000);
    const started = performance.now();
    const result = validateDoc(doc);
    const elapsed = performance.now() - started;

    expect(result.ok).toBe(true);
    // Validation runs on every save, so it has to stay well clear of a
    // noticeable pause. A generous ceiling still catches an accidental
    // quadratic.
    expect(elapsed).toBeLessThan(1000);
  });

  it('counts the words in a large document', () => {
    expect(wordCount(largeDocument(500))).toBeGreaterThan(5000);
  });

  it('exports and reimports a large document without losing its shape', async () => {
    const doc = largeDocument(300);
    const buffer = await exportDocx(doc, { title: 'Large' });
    const { content } = await importDocx(buffer);

    const headings = (content.content ?? []).filter((node) => node.type === 'heading');
    expect(headings.length).toBe(30);
    expect(toPlainText(content)).toContain('Paragraph 299.');
  }, 60000);

  it('refuses a document past the storage limit rather than truncating it', async () => {
    const app = await makeApp();
    try {
      const admin = await registerFirstAdmin(app);
      const enormous = largeDocument(60000);
      const response = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: authHeader(admin),
        payload: { title: 'Enormous', content: enormous },
      });
      expect([400, 413]).toContain(response.statusCode);
    } finally {
      await app.close();
    }
  }, 60000);
});

describe('awkward content', () => {
  const cases: { name: string; text: string }[] = [
    { name: 'right-to-left Urdu', text: 'یہ ایک تحریری دستاویز ہے جو ٹیسٹ کے لیے بنائی گئی ہے۔' },
    { name: 'Arabic with diacritics', text: 'اَلسَّلامُ عَلَيْكُمْ وَرَحْمَةُ اللهِ' },
    { name: 'Chinese', text: '这是一个用于测试的文档。' },
    { name: 'emoji outside the basic plane', text: 'Status: shipped 🚀 and reviewed 👍' },
    { name: 'combining accents', text: 'Café naïve résumé Å' },
    { name: 'characters that matter in XML', text: 'Less < greater > amp & quote " apostrophe \'' },
    { name: 'a very long unbroken word', text: 'x'.repeat(5000) },
    { name: 'mixed direction in one line', text: 'Report رپورٹ 2026 نمبر 3' },
  ];

  for (const { name, text } of cases) {
    it(`carries ${name} through a round trip`, async () => {
      const doc: PMNode = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      };
      const buffer = await exportDocx(doc, { title: name });
      const { content } = await importDocx(buffer);
      expect(toPlainText(content)).toContain(text);
    });
  }

  it('keeps a table whose cells hold non-Latin text', async () => {
    const cell = (text: string): PMNode => ({
      type: 'tableCell',
      attrs: { colspan: 1, rowspan: 1, colwidth: null },
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const doc: PMNode = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [{ type: 'tableRow', content: [cell('علاقہ'), cell('کل')] }],
        },
      ],
    };
    const { content } = await importDocx(await exportDocx(doc, { title: 'Table' }));
    expect(toPlainText(content)).toContain('علاقہ');
  });

  it('handles a deeply nested list without losing the innermost text', async () => {
    let list: PMNode = {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Innermost' }] }] }],
    };
    for (let depth = 0; depth < 6; depth += 1) {
      list = {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: `Level ${6 - depth}` }] },
              list,
            ],
          },
        ],
      };
    }
    const doc: PMNode = { type: 'doc', content: [list] };
    expect(validateDoc(doc).ok).toBe(true);
    const { content } = await importDocx(await exportDocx(doc, { title: 'Nested' }));
    expect(toPlainText(content)).toContain('Innermost');
  });
});

describe('two people editing at once', () => {
  let app: FastifyInstance;
  let admin: TestActor;
  let owner: TestActor;
  let collaborator: TestActor;
  let documentId: string;

  beforeEach(async () => {
    app = await makeApp();
    admin = await registerFirstAdmin(app);
    owner = await createAndLogin(app, admin, { email: 'owner@example.com', name: 'Olive' });
    collaborator = await createAndLogin(app, admin, { email: 'co@example.com', name: 'Cora' });

    const created = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: authHeader(owner),
      payload: { title: 'Shared', content: { type: 'doc', content: [{ type: 'paragraph' }] } },
    });
    documentId = created.json().document.id;
    await app.inject({
      method: 'PUT',
      url: `/api/documents/${documentId}/shares`,
      headers: authHeader(owner),
      payload: { userId: collaborator.id, permission: 'edit' },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const save = (actor: TestActor, text: string, expectedRevision?: number) =>
    app.inject({
      method: 'PUT',
      url: `/api/documents/${documentId}`,
      headers: authHeader(actor),
      payload: {
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      },
    });

  it('lets the first writer through and refuses the second', async () => {
    const first = await save(owner, 'Olive wrote this', 1);
    expect(first.statusCode).toBe(200);

    // Cora read revision 1 before Olive saved, so her save is refused rather
    // than quietly discarding Olive's paragraph.
    const second = await save(collaborator, 'Cora wrote this', 1);
    expect(second.statusCode).toBe(409);

    const current = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
      headers: authHeader(owner),
    });
    expect(JSON.stringify(current.json().document.content)).toContain('Olive wrote this');
  });

  it('lets the second writer through once they have caught up', async () => {
    await save(owner, 'Olive wrote this', 1);
    const reread = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}`,
      headers: authHeader(collaborator),
    });
    const revision = reread.json().document.revision;

    const second = await save(collaborator, 'Cora wrote this', revision);
    expect(second.statusCode).toBe(200);
  });

  it('keeps both authors in the version history', async () => {
    await save(owner, 'Olive wrote this');
    await save(collaborator, 'Cora wrote this');

    const versions = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/versions`,
      headers: authHeader(owner),
    });
    const authors = (versions.json().versions as { authorName: string }[]).map((v) => v.authorName);
    expect(authors).toContain('Olive');
    expect(authors).toContain('Cora');
  });

  it('accepts a burst of saves from one person without losing count', async () => {
    // Autosave fires repeatedly while somebody types. Each save must advance
    // the revision exactly once.
    for (let i = 0; i < 20; i += 1) {
      const response = await save(owner, `Edit ${i}`);
      expect(response.statusCode).toBe(200);
      expect(response.json().document.revision).toBe(i + 2);
    }
  });

  it('serves a consistent document while it is being written to', async () => {
    await save(owner, 'Settled text');
    const reads = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: 'GET',
          url: `/api/documents/${documentId}`,
          headers: authHeader(collaborator),
        }),
      ),
    );
    for (const read of reads) {
      expect(read.statusCode).toBe(200);
      expect(JSON.stringify(read.json().document.content)).toContain('Settled text');
    }
  });
});
