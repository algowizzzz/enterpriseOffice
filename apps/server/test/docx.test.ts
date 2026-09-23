import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { toPlainText, type PMNode } from '@docforge/model';
import { exportDocx, safeFileName } from '../src/docx/export.js';
import { importDocx, titleFromFileName } from '../src/docx/import.js';
import {
  authHeader,
  createAndLogin,
  makeApp,
  registerFirstAdmin,
  type TestActor,
} from './helpers.js';

const richDoc: PMNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Quarterly Report' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Plain, ' },
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ', ' },
        { type: 'text', text: 'italic', marks: [{ type: 'italic' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'underlined', marks: [{ type: 'underline' }] },
        { type: 'text', text: '.' },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Findings' }] },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First finding' }] }],
        },
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second finding' }] }],
        },
      ],
    },
    {
      type: 'orderedList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Step one' }] }],
        },
      ],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Region' }] }],
            },
            {
              type: 'tableHeader',
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Revenue' }] }],
            },
          ],
        },
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'North' }] }],
            },
            {
              type: 'tableCell',
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '1200' }] }],
            },
          ],
        },
      ],
    },
    {
      type: 'paragraph',
      attrs: { textAlign: 'center' },
      content: [{ type: 'text', text: 'Centred closing line.' }],
    },
  ],
};

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

describe('docx export and import', () => {
  it('writes a real .docx zip container', async () => {
    const buffer = await exportDocx(richDoc, { title: 'Quarterly Report', author: 'Tester' });
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 4).equals(ZIP_MAGIC)).toBe(true);
    // The zip central directory names the main document part.
    expect(buffer.toString('latin1')).toContain('word/document.xml');
  });

  it('round trips text, headings, lists and tables', async () => {
    const buffer = await exportDocx(richDoc, { title: 'Quarterly Report' });
    const { content } = await importDocx(buffer);
    const text = toPlainText(content);

    for (const expected of [
      'Quarterly Report',
      'Findings',
      'First finding',
      'Second finding',
      'Step one',
      'Region',
      'Revenue',
      'North',
      '1200',
      'Centred closing line.',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('preserves heading levels through a round trip', async () => {
    const buffer = await exportDocx(richDoc, { title: 'Quarterly Report' });
    const { content } = await importDocx(buffer);
    const headings = (content.content ?? []).filter((node) => node.type === 'heading');
    expect(headings.length).toBeGreaterThanOrEqual(2);
    expect(headings[0]?.attrs?.['level']).toBe(1);
    expect(headings[1]?.attrs?.['level']).toBe(2);
  });

  it('preserves bold and italic marks through a round trip', async () => {
    const buffer = await exportDocx(richDoc, { title: 'Quarterly Report' });
    const { content } = await importDocx(buffer);
    const marks = new Set<string>();
    const walk = (node: PMNode): void => {
      for (const mark of node.marks ?? []) marks.add(mark.type);
      for (const child of node.content ?? []) walk(child);
    };
    walk(content);
    expect(marks.has('bold')).toBe(true);
    expect(marks.has('italic')).toBe(true);
  });

  it('keeps a table as a table after a round trip', async () => {
    const buffer = await exportDocx(richDoc, { title: 'Quarterly Report' });
    const { content } = await importDocx(buffer);
    const tables = (content.content ?? []).filter((node) => node.type === 'table');
    expect(tables).toHaveLength(1);
    expect(tables[0]?.content).toHaveLength(2);
  });

  it('refuses a file that is not a zip container', async () => {
    await expect(importDocx(Buffer.from('this is a plain text file'))).rejects.toThrow(
      /not a valid \.docx/u,
    );
  });

  it('refuses an empty buffer', async () => {
    await expect(importDocx(Buffer.alloc(0))).rejects.toThrow(/not a valid \.docx/u);
  });

  it('always produces at least one paragraph for an empty document', async () => {
    const buffer = await exportDocx({ type: 'doc', content: [] }, { title: 'Empty' });
    const { content } = await importDocx(buffer);
    expect(content.type).toBe('doc');
    expect((content.content ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('builds a file name that is safe on Windows', () => {
    expect(safeFileName('Q1: report/draft?', 'docx')).toBe('Q1 reportdraft.docx');
    expect(safeFileName('   ', 'docx')).toBe('document.docx');
    expect(safeFileName('تقرير', 'docx')).toBe('تقرير.docx');
  });

  it('derives a title from an uploaded file name', () => {
    expect(titleFromFileName('Annual Review.docx')).toBe('Annual Review');
    expect(titleFromFileName('/tmp/uploads/Notes.DOCX')).toBe('Notes');
    expect(titleFromFileName('.docx')).toBe('Imported document');
  });
});

describe('upload and export through the portal', () => {
  let app: FastifyInstance;
  let admin: TestActor;
  let owner: TestActor;

  beforeEach(async () => {
    app = await makeApp();
    admin = await registerFirstAdmin(app);
    owner = await createAndLogin(app, admin, { email: 'owner@example.com', name: 'Olive Owner' });
  });

  afterEach(async () => {
    await app.close();
  });

  const multipart = (
    buffer: Buffer,
    fileName: string,
    mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ): { payload: Buffer; headers: Record<string, string> } => {
    const boundary = '----docforgetest';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return {
      payload: Buffer.concat([head, buffer, tail]),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  };

  it('uploads a .docx and creates an editable document', async () => {
    const buffer = await exportDocx(richDoc, { title: 'Quarterly Report' });
    const { payload, headers } = multipart(buffer, 'Quarterly Report.docx');

    const response = await app.inject({
      method: 'POST',
      url: '/api/documents/import',
      headers: { ...headers, ...authHeader(owner) },
      payload,
    });
    expect(response.statusCode).toBe(201);
    const document = response.json().document;
    expect(document.title).toBe('Quarterly Report');
    expect(document.origin).toBe('import');
    expect(document.sourceName).toBe('Quarterly Report.docx');
    expect(document.wordCount).toBeGreaterThan(5);
    expect(JSON.stringify(document.content)).toContain('First finding');
  });

  it('rejects an upload that is neither a Word file nor a PDF', async () => {
    // A PDF was the example here until PDFs could be uploaded.
    const { payload, headers } = multipart(
      Buffer.from('a,b,c\n1,2,3\n'),
      'figures.csv',
      'text/csv',
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/documents/import',
      headers: { ...headers, ...authHeader(owner) },
      payload,
    });
    expect(response.statusCode).toBe(415);
  });

  it('rejects a .docx name whose bytes are not a zip', async () => {
    const { payload, headers } = multipart(Buffer.from('not a zip at all'), 'fake.docx');
    const response = await app.inject({
      method: 'POST',
      url: '/api/documents/import',
      headers: { ...headers, ...authHeader(owner) },
      payload,
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an upload without a session', async () => {
    const buffer = await exportDocx(richDoc, { title: 'Quarterly Report' });
    const { payload, headers } = multipart(buffer, 'Report.docx');
    const response = await app.inject({
      method: 'POST',
      url: '/api/documents/import',
      headers,
      payload,
    });
    expect(response.statusCode).toBe(401);
  });

  it('exports a saved document back to .docx with a download header', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: authHeader(owner),
      payload: { title: 'Exportable', content: richDoc },
    });
    const id = created.json().document.id;

    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${id}/export?format=docx`,
      headers: authHeader(owner),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('wordprocessingml.document');
    expect(response.headers['content-disposition']).toContain('Exportable.docx');
    expect(response.rawPayload.subarray(0, 4).equals(ZIP_MAGIC)).toBe(true);
  });

  it('exports plain text when asked', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: authHeader(owner),
      payload: { title: 'Exportable', content: richDoc },
    });
    const id = created.json().document.id;
    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${id}/export?format=txt`,
      headers: authHeader(owner),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Quarterly Report');
  });

  it('completes the full circle of upload, edit, export and re-import', async () => {
    const original = await exportDocx(richDoc, { title: 'Round trip' });
    const upload = multipart(original, 'Round trip.docx');
    const imported = await app.inject({
      method: 'POST',
      url: '/api/documents/import',
      headers: { ...upload.headers, ...authHeader(owner) },
      payload: upload.payload,
    });
    const document = imported.json().document;

    const edited = {
      ...document.content,
      content: [
        ...document.content.content,
        { type: 'paragraph', content: [{ type: 'text', text: 'Added in the editor.' }] },
      ],
    };
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/documents/${document.id}`,
      headers: authHeader(owner),
      payload: { content: edited, expectedRevision: document.revision },
    });
    expect(saved.statusCode).toBe(200);

    const exported = await app.inject({
      method: 'GET',
      url: `/api/documents/${document.id}/export`,
      headers: authHeader(owner),
    });
    expect(exported.statusCode).toBe(200);

    const reimported = await importDocx(Buffer.from(exported.rawPayload));
    const text = toPlainText(reimported.content);
    expect(text).toContain('Added in the editor.');
    expect(text).toContain('First finding');
  });
});
