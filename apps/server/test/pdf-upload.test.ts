import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import PDFDocument from 'pdfkit';
import { unzipSync } from 'fflate';
import { toPlainText, validateDoc } from '@docforge/model';
import { authHeader, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';

/** A small real PDF: a heading, two paragraphs, made in memory. */
const makePdf = (): Promise<Buffer> =>
  new Promise((resolve) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 72 });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.font('Helvetica-Bold').fontSize(20).text('Retention Policy');
    pdf.moveDown();
    pdf.font('Helvetica').fontSize(11).text('Records are kept for ten years from the end of the financial year, and then destroyed.');
    pdf.moveDown();
    pdf.text('Exceptions need written approval from the record owner.');
    pdf.end();
  });

describe('uploading a PDF', () => {
  let app: FastifyInstance;
  let owner: TestActor;

  const upload = (name: string, type: string, bytes: Buffer) => {
    const boundary = '----docforge-pdf';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: 'POST',
      url: '/api/documents/import',
      headers: { ...authHeader(owner), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
  };

  beforeEach(async () => {
    app = await makeApp();
    owner = await registerFirstAdmin(app);
  });
  afterEach(async () => {
    await app.close();
  });

  it('opens as a document that can be edited, named after the file, and says it was converted', async () => {
    const response = await upload('Retention Policy.pdf', 'application/pdf', await makePdf());
    expect(response.statusCode).toBe(201);
    const { document, messages } = response.json();
    expect(document.title).toBe('Retention Policy');
    expect(validateDoc(document.content)).toEqual({ ok: true, errors: [] });
    expect(toPlainText(document.content)).toContain('Records are kept for ten years from the end of the financial year, and then destroyed.');
    expect(document.content.content[0]).toMatchObject({ type: 'heading' });
    expect(messages.join(' ')).toMatch(/PDF/u);
  });

  it('keeps the PDF itself as the original, and exports the converted text to Word', async () => {
    const pdf = await makePdf();
    const { document } = (await upload('policy.pdf', 'application/pdf', pdf)).json();
    const original = await app.inject({ method: 'GET', url: `/api/documents/${document.id}/export?format=original`, headers: authHeader(owner) });
    expect(original.headers['content-type']).toBe('application/pdf');
    expect(original.rawPayload.equals(pdf)).toBe(true);
    // Exporting to Word must start from a Word template, not try to patch a PDF.
    const word = await app.inject({ method: 'GET', url: `/api/documents/${document.id}/export?format=docx`, headers: authHeader(owner) });
    expect(word.statusCode).toBe(200);
    expect(Object.keys(unzipSync(new Uint8Array(word.rawPayload)))).toContain('word/document.xml');
  });

  it('refuses something that only claims to be a PDF, in words', async () => {
    const response = await upload('notes.pdf', 'application/pdf', Buffer.from('not a pdf at all'));
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/not a PDF/u);
  });

  it('still refuses a file that is neither Word nor PDF', async () => {
    const response = await upload('sheet.xlsx', 'application/vnd.ms-excel', Buffer.from('PK'));
    expect(response.statusCode).toBe(415);
  });
});

describe('exporting to PDF', () => {
  let app: FastifyInstance;
  let owner: TestActor;
  beforeEach(async () => {
    app = await makeApp();
    owner = await registerFirstAdmin(app);
  });
  afterEach(async () => {
    await app.close();
  });

  it('downloads a PDF named after the document, which reads back as the same words', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/documents', headers: authHeader(owner),
      payload: {
        title: 'Retention Policy',
        content: { type: 'doc', content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Purpose' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Records are kept for ten years.' }] },
        ] },
      },
    });
    const id = created.json().document.id;
    const exported = await app.inject({ method: 'GET', url: `/api/documents/${id}/export?format=pdf`, headers: authHeader(owner) });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toBe('application/pdf');
    expect(String(exported.headers['content-disposition'])).toContain('Retention Policy.pdf');
    expect(exported.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // Out through one module and back in through the other.
    const { importPdf } = await import('../src/pdf/importPdf.js');
    const back = await importPdf(exported.rawPayload);
    expect(toPlainText(back.content)).toContain('Records are kept for ten years.');
  });
});
