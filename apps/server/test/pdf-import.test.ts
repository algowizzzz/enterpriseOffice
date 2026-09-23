import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import PDFDocument from 'pdfkit';
import { validateDoc, type PMNode } from '@docforge/model';
import { importPdf, type PdfImportResult } from '../src/pdf/importPdf.js';
import { encodePng } from '../src/pdf/png.js';
import { HttpError } from '../src/errors.js';

/**
 * Every fixture is a real PDF, written in memory by pdfkit, so the importer is
 * exercised through pdf.js exactly as an upload is and the tests need nothing
 * installed on the machine that runs them.
 */

type Doc = InstanceType<typeof PDFDocument>;

async function pdf(options: ConstructorParameters<typeof PDFDocument>[0], draw: (doc: Doc) => void): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 72, ...options });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));
  draw(doc);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

/** A small red and blue picture, encoded by the importer's own PNG writer. */
function picture(width = 24, height = 12): Buffer {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 3] = i % 2 === 0 ? 200 : 20;
    data[i * 3 + 2] = i % 2 === 0 ? 20 : 200;
  }
  const png = encodePng({ width, height, kind: 2, data });
  if (!png) throw new Error('the fixture picture did not encode');
  return png;
}

const BULLET = String.fromCodePoint(0x2022);

const textOf = (node: PMNode): string =>
  node.type === 'text' ? (node.text ?? '') : (node.content ?? []).map(textOf).join('');

const blocksOf = (result: PdfImportResult): PMNode[] => result.content.content ?? [];

const find = (result: PdfImportResult, type: string): PMNode[] => {
  const found: PMNode[] = [];
  const visit = (node: PMNode): void => {
    if (node.type === type) found.push(node);
    (node.content ?? []).forEach(visit);
  };
  visit(result.content);
  return found;
};

const marksOn = (result: PdfImportResult, words: string): string[] => {
  const node = find(result, 'text').find((candidate) => (candidate.text ?? '').includes(words));
  return (node?.marks ?? []).map((mark) => mark.type);
};

const SENTENCE =
  'The committee reviewed the register of risks in full and agreed that the controls described by each owner were adequate for the period under review. ';

async function rejection(buffer: Buffer): Promise<HttpError> {
  try {
    await importPdf(buffer);
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('the upload was accepted');
}

describe('opening a PDF as an editable document', () => {
  it('keeps a paragraph that wraps across lines as one paragraph', async () => {
    // Every line of the PDF came back as a paragraph of its own, so a page of
    // prose opened as forty fragments that each had to be joined by hand.
    const result = await importPdf(
      await pdf({}, (doc) => {
        doc.font('Helvetica').fontSize(11);
        doc.text(SENTENCE.repeat(3).trim());
        doc.moveDown();
        doc.text(`Second paragraph. ${SENTENCE.repeat(2)}`.trim());
      }),
    );
    const paragraphs = blocksOf(result).filter((node) => node.type === 'paragraph');
    expect(paragraphs).toHaveLength(2);
    expect(textOf(paragraphs[0]!)).toBe(SENTENCE.repeat(3).trim());
    expect(textOf(paragraphs[1]!).startsWith('Second paragraph. The committee')).toBe(true);
  });

  it('turns the big bold lines into headings', async () => {
    const result = await importPdf(
      await pdf({}, (doc) => {
        doc.font('Helvetica-Bold').fontSize(22).text('Annual Review');
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(11).text(SENTENCE.repeat(2).trim());
        doc.moveDown();
        doc.font('Helvetica-Bold').fontSize(15).text('Findings');
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(11).text(SENTENCE.repeat(2).trim());
        doc.moveDown();
        doc.font('Helvetica-Bold').fontSize(15).text('Next steps');
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(11).text(SENTENCE.trim());
      }),
    );
    const headings = find(result, 'heading').map((node) => [node.attrs?.['level'], textOf(node)]);
    expect(headings).toEqual([
      [1, 'Annual Review'],
      [2, 'Findings'],
      [2, 'Next steps'],
    ]);
    expect(blocksOf(result).filter((node) => node.type === 'paragraph')).toHaveLength(3);
  });

  it('treats a bold line of ordinary size over plain text as a heading, and bold words inside a sentence as bold', async () => {
    const result = await importPdf(
      await pdf({}, (doc) => {
        doc.font('Helvetica-Bold').fontSize(11).text('Scope of the policy');
        doc.moveDown(0.5);
        doc.font('Helvetica').text('This applies to ', { continued: true });
        doc.font('Helvetica-Bold').text('every member', { continued: true });
        doc.font('Helvetica-Oblique').text(' without exception', { continued: true });
        doc.font('Helvetica').text(' and takes effect at once.');
      }),
    );
    expect(find(result, 'heading').map(textOf)).toEqual(['Scope of the policy']);
    const paragraph = blocksOf(result).find((node) => node.type === 'paragraph')!;
    expect(textOf(paragraph)).toBe('This applies to every member without exception and takes effect at once.');
    expect(marksOn(result, 'every member')).toContain('bold');
    expect(marksOn(result, 'without exception')).toContain('italic');
    expect(marksOn(result, 'This applies')).not.toContain('bold');
  });

  it('reads a two-column page in reading order, left column first', async () => {
    // Read straight across, a two-column page came out as alternating halves
    // of unrelated sentences, which is unreadable and cannot be repaired by
    // hand short of retyping it.
    const left = 'LEFT '.concat(SENTENCE.repeat(5)).trim();
    const right = 'RIGHT '.concat(SENTENCE.repeat(5)).trim();
    const result = await importPdf(
      await pdf({}, (doc) => {
        doc.font('Helvetica-Bold').fontSize(18).text('Newsletter', 72, 72);
        doc.font('Helvetica').fontSize(10);
        doc.text(left, 72, 120, { width: 215, align: 'justify' });
        doc.text(right, 308, 120, { width: 215, align: 'justify' });
      }),
    );
    const blocks = blocksOf(result).map(textOf);
    expect(blocks).toEqual(['Newsletter', left, right]);
  });

  it('rejoins a paragraph that runs over the end of a page', async () => {
    // The page boundary of the PDF became a paragraph boundary in the middle
    // of a sentence, on every page of a long document.
    const long = SENTENCE.repeat(60).trim();
    const result = await importPdf(
      await pdf({}, (doc) => {
        doc.font('Helvetica').fontSize(11).text(long, { align: 'justify' });
      }),
    );
    expect(result.pages).toBeGreaterThan(1);
    const paragraphs = blocksOf(result);
    expect(paragraphs).toHaveLength(1);
    expect(textOf(paragraphs[0]!)).toBe(long);
    expect(find(result, 'pageBreak')).toHaveLength(0);
  });

  it('puts a word hyphenated at the end of a line back together', async () => {
    const result = await importPdf(
      await pdf({}, (doc) => {
        doc.font('Helvetica').fontSize(11);
        doc.text('The board asked for a full and frank account of each of the various arrange-', 72, 100, { lineBreak: false });
        doc.text('ments made for the year and was given one by the chair.', 72, 113.5, { lineBreak: false });
      }),
    );
    expect(blocksOf(result).map(textOf)).toEqual([
      'The board asked for a full and frank account of each of the various arrangements made for the year and was given one by the chair.',
    ]);
  });

  it('makes bulleted and numbered lines into lists and drops the markers', async () => {
    const result = await importPdf(
      await pdf({}, (doc) => {
        doc.font('Helvetica').fontSize(11);
        doc.text('The following were agreed:');
        doc.moveDown(0.5);
        for (const item of ['Approve the minutes', 'Note the register', 'Defer the audit plan']) {
          doc.text(`${BULLET} ${item}`, 90);
        }
        doc.moveDown();
        doc.text('Then, in order:', 72);
        doc.moveDown(0.5);
        ['Draft the paper', 'Circulate it to members', 'Table it at the next meeting'].forEach((item, index) => {
          const y = doc.y;
          doc.text(`${index + 1}.`, 90, y, { lineBreak: false });
          doc.text(item, 112, y);
        });
      }),
    );
    const [bullets] = find(result, 'bulletList');
    const [numbers] = find(result, 'orderedList');
    expect((bullets?.content ?? []).map(textOf)).toEqual([
      'Approve the minutes',
      'Note the register',
      'Defer the audit plan',
    ]);
    expect((numbers?.content ?? []).map(textOf)).toEqual([
      'Draft the paper',
      'Circulate it to members',
      'Table it at the next meeting',
    ]);
    expect(blocksOf(result).map((node) => node.type)).toEqual([
      'paragraph',
      'bulletList',
      'paragraph',
      'orderedList',
    ]);
  });

  it('keeps the number on a single numbered line instead of making a list of one', async () => {
    // "7. Review" became a one-item list, which the editor renumbers, so the
    // clause number a policy is cited by was no longer in the text.
    const result = await importPdf(
      await pdf({}, (doc) => {
        doc.font('Helvetica').fontSize(11);
        doc.text('7. Review of this policy takes place every year.');
        doc.moveDown();
        doc.text(SENTENCE.trim());
      }),
    );
    expect(find(result, 'orderedList')).toHaveLength(0);
    expect(textOf(blocksOf(result)[0]!)).toBe('7. Review of this policy takes place every year.');
  });

  it('rebuilds a ruled table as a table, with its bold first row as the header', async () => {
    const rows = [
      ['Risk', 'Owner', 'Rating'],
      ['Supplier failure', 'Head of Procurement', 'High'],
      ['Data loss', 'Head of Technology', 'Medium'],
      ['Key staff leaving', 'Head of People', 'Low'],
    ];
    const result = await importPdf(
      await pdf({}, (doc) => {
        doc.font('Helvetica').fontSize(11).text('The register at the end of the quarter:');
        const xs = [72, 250, 430];
        let y = 120;
        rows.forEach((cells, index) => {
          doc.font(index === 0 ? 'Helvetica-Bold' : 'Helvetica');
          cells.forEach((cell, at) => doc.text(cell, xs[at]! + 4, y + 6, { lineBreak: false }));
          doc.rect(72, y, 451, 24).stroke();
          y += 24;
        });
        for (const x of [250, 430]) doc.moveTo(x, 120).lineTo(x, y).stroke();
        doc.font('Helvetica').text('No other risks were raised.', 72, y + 24);
      }),
    );
    const [table] = find(result, 'table');
    expect(table).toBeDefined();
    const grid = (table?.content ?? []).map((row) => (row.content ?? []).map(textOf));
    expect(grid).toEqual(rows);
    expect((table?.content?.[0]?.content ?? []).every((cell) => cell.type === 'tableHeader')).toBe(true);
    expect((table?.content?.[1]?.content ?? []).every((cell) => cell.type === 'tableCell')).toBe(true);
    expect(blocksOf(result).map((node) => node.type)).toEqual(['paragraph', 'table', 'paragraph']);
    expect(result.messages.some((message) => message.includes('Tables were rebuilt'))).toBe(true);
  });

  it('keeps a cell whose words wrap onto a second line inside its table', async () => {
    // The second line of a wrapped cell ended the table, so one table arrived
    // as several small ones with loose lines of text between them.
    const result = await importPdf(
      await pdf({}, (doc) => {
        doc.font('Helvetica').fontSize(11);
        const put = (cells: string[], y: number): void =>
          cells.forEach((cell, at) => doc.text(cell, [72, 240, 440][at], y, { lineBreak: false }));
        put(['Control', 'What it covers', 'Checked'], 100);
        put(['Access', 'Who may open the register and', 'Monthly'], 122);
        put(['', 'who may change an entry in it', ''], 135);
        put(['Backup', 'Copies kept off site', 'Weekly'], 157);
        put(['Audit', 'An outside review', 'Yearly'], 179);
      }),
    );
    const [table] = find(result, 'table');
    const grid = (table?.content ?? []).map((row) => (row.content ?? []).map(textOf));
    expect(grid).toEqual([
      ['Control', 'What it covers', 'Checked'],
      ['Access', 'Who may open the register and who may change an entry in it', 'Monthly'],
      ['Backup', 'Copies kept off site', 'Weekly'],
      ['Audit', 'An outside review', 'Yearly'],
    ]);
    expect(blocksOf(result)).toHaveLength(1);
  });

  it('does not invent a table from two lines that happen to line up', async () => {
    // A letterhead with the date set to the right of the reference, over two
    // lines, was turned into a table, and the letter below it could not be
    // edited as a letter any more.
    const result = await importPdf(
      await pdf({}, (doc) => {
        doc.font('Helvetica').fontSize(11);
        doc.text('Reference 2291', 72, 100, { lineBreak: false });
        doc.text('4 March', 400, 100, { lineBreak: false });
        doc.text('Finance team', 72, 114, { lineBreak: false });
        doc.text('By hand', 400, 114, { lineBreak: false });
        doc.text(SENTENCE.trim(), 72, 160);
      }),
    );
    expect(find(result, 'table')).toHaveLength(0);
    const all = textOf(result.content);
    for (const words of ['Reference 2291', '4 March', 'Finance team', 'By hand']) expect(all).toContain(words);
  });

  it('leaves the running header and the page numbers out of the text', async () => {
    // The header and "Page 2 of 3" landed in the middle of the sentence that
    // crossed each page boundary.
    const result = await importPdf(
      await pdf({ bufferPages: true }, (doc) => {
        doc.font('Helvetica').fontSize(11).text(SENTENCE.repeat(90).trim(), { align: 'justify' });
        const range = doc.bufferedPageRange();
        for (let index = 0; index < range.count; index += 1) {
          doc.switchToPage(index);
          doc.page.margins.top = 0;
          doc.page.margins.bottom = 0;
          doc.fontSize(9).text('Governance Committee: quarterly report', 72, 30, { lineBreak: false });
          doc.text(`Page ${index + 1} of ${range.count}`, 72, 805, { lineBreak: false });
        }
      }),
    );
    expect(result.pages).toBeGreaterThanOrEqual(3);
    const all = textOf(result.content);
    expect(all).not.toContain('quarterly report');
    expect(all).not.toMatch(/Page \d/u);
    expect(all).toBe(SENTENCE.repeat(90).trim());
    expect(result.meta.header).toBe('Governance Committee: quarterly report');
    expect(result.meta.footer).toBe('');
    expect(result.messages.some((message) => message.includes('page numbers'))).toBe(true);
  });

  it('keeps a link on the words it was on, and only on those', async () => {
    const result = await importPdf(
      await pdf({}, (doc) => {
        doc.font('Helvetica').fontSize(11);
        doc.text('The full terms are in ', { continued: true });
        doc.text('the published policy', { continued: true, link: 'https://example.org/policy' });
        doc.text(' on the intranet.', { link: null as unknown as string });
      }),
    );
    const linked = find(result, 'text').filter((node) => (node.marks ?? []).some((mark) => mark.type === 'link'));
    expect(linked.map((node) => node.text?.trim())).toEqual(['the published policy']);
    expect(linked[0]?.marks?.find((mark) => mark.type === 'link')?.attrs?.['href']).toBe('https://example.org/policy');
    expect(textOf(blocksOf(result)[0]!)).toBe('The full terms are in the published policy on the intranet.');
  });

  it('drops a link that points somewhere unsafe but keeps its words', async () => {
    const result = await importPdf(
      await pdf({}, (doc) => {
        doc.font('Helvetica').fontSize(11).text('Open the form', { link: 'javascript:alert(1)' });
      }),
    );
    expect(textOf(result.content)).toBe('Open the form');
    expect(marksOn(result, 'Open the form')).not.toContain('link');
  });

  it('carries a picture over at the size and place it had on the page', async () => {
    const result = await importPdf(
      await pdf({}, (doc) => {
        doc.font('Helvetica').fontSize(11).text('Before the picture.');
        doc.moveDown();
        doc.image(picture(), { width: 150 });
        doc.moveDown();
        doc.text('After the picture.');
      }),
    );
    const blocks = blocksOf(result);
    expect(blocks.map((node) => textOf(node) || node.content?.[0]?.type)).toEqual([
      'Before the picture.',
      'image',
      'After the picture.',
    ]);
    const [image] = find(result, 'image');
    expect(image?.attrs?.['width']).toBe(200);
    expect(image?.attrs?.['height']).toBe(100);
    expect(String(image?.attrs?.['src']).startsWith('data:image/png;base64,iVBORw0KGgo')).toBe(true);
  });

  it('notices text in a different size, font and colour', async () => {
    const result = await importPdf(
      await pdf({}, (doc) => {
        doc.font('Helvetica').fontSize(11).text(SENTENCE.repeat(2).trim());
        doc.moveDown();
        doc.font('Times-Roman').fontSize(8).fillColor('#aa0000').text('Small print in red.');
      }),
    );
    const small = find(result, 'text').find((node) => node.text === 'Small print in red.');
    const style = small?.marks?.find((mark) => mark.type === 'textStyle')?.attrs;
    expect(style).toEqual({ fontSize: '8pt', fontFamily: 'Times', color: '#aa0000' });
    const body = find(result, 'text')[0];
    expect(body?.marks?.find((mark) => mark.type === 'textStyle')?.attrs).toEqual({ fontFamily: 'Helvetica' });
  });

  it('sees centred text as centred and a landscape page as landscape', async () => {
    const result = await importPdf(
      await pdf({ layout: 'landscape' }, (doc) => {
        doc.font('Helvetica').fontSize(11).text(SENTENCE.repeat(3).trim(), { align: 'justify' });
        doc.moveDown();
        doc.text('Signed on behalf of the board', { align: 'center' });
      }),
    );
    expect(result.meta.orientation).toBe('landscape');
    const centred = blocksOf(result).find((node) => textOf(node) === 'Signed on behalf of the board');
    expect(centred?.attrs?.['textAlign']).toBe('center');
    expect(blocksOf(result)[0]?.attrs?.['textAlign']).toBe('justify');
  });

  it('says that the layout was reconstructed', async () => {
    const result = await importPdf(await pdf({}, (doc) => doc.text('One line.')));
    expect(result.messages[0]).toContain('converted from a PDF');
    expect(result.meta).toEqual({ header: '', footer: '', orientation: 'portrait' });
    expect(result.pages).toBe(1);
  });

  it('produces a document the rules accept', async () => {
    // A document the validator refuses can be opened once and never saved.
    const result = await importPdf(
      await pdf({}, (doc) => {
        doc.font('Helvetica-Bold').fontSize(20).text('Everything at once');
        doc.font('Helvetica').fontSize(11).text(SENTENCE.repeat(4).trim(), { align: 'justify' });
        doc.moveDown();
        for (const item of ['One', 'Two']) doc.text(`${BULLET} ${item}`, 90);
        doc.text('', 72);
        doc.moveDown();
        doc.image(picture(), { width: 90 });
        doc.moveDown();
        const top = doc.y;
        [['Name', 'Value'], ['Alpha', '1'], ['Beta', '2'], ['Gamma', '3']].forEach((cells, index) => {
          doc.text(cells[0]!, 76, top + index * 20 + 5, { lineBreak: false });
          doc.text(cells[1]!, 300, top + index * 20 + 5, { lineBreak: false });
          doc.rect(72, top + index * 20, 400, 20).stroke();
        });
        doc.moveTo(72, top + 140).lineTo(520, top + 140).stroke();
        doc.text('See the site.', 72, top + 160, { link: 'https://example.org/' });
        doc.addPage();
        doc.text(SENTENCE.repeat(6).trim(), 72, 72, { width: 215 });
        doc.text(SENTENCE.repeat(6).trim(), 308, 72, { width: 215 });
      }),
    );
    const verdict = validateDoc(result.content);
    expect(verdict.errors).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(find(result, 'table')).toHaveLength(1);
    expect(find(result, 'image')).toHaveLength(1);
    expect(find(result, 'bulletList')).toHaveLength(1);
    expect(find(result, 'horizontalRule')).toHaveLength(1);
    expect(find(result, 'text').every((node) => (node.text ?? '').length > 0)).toBe(true);
  });
});

describe('PDFs that cannot be converted', () => {
  it('refuses something that is not a PDF', async () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from(' a Word file renamed to .pdf')]);
    const error = await rejection(zip);
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe('That file is not a PDF.');
  });

  it('refuses a scanned PDF and says why', async () => {
    // A scan used to open as an empty document, which looks like the upload
    // worked and the text was lost.
    const error = await rejection(await pdf({}, (doc) => doc.image(picture(200, 280), 0, 0, { width: 595 })));
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe(
      'This PDF is a scan: it holds pictures of pages and no text. Scanned PDFs cannot be converted.',
    );
  });

  it('refuses a password-protected PDF and says what to do about it', async () => {
    const error = await rejection(
      await pdf({ userPassword: 'secret', ownerPassword: 'owner' }, (doc) => doc.text('Locked away.')),
    );
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('protected with a password');
  });

  it('refuses a damaged PDF without taking the server down', async () => {
    const whole = await pdf({}, (doc) => doc.text('About to be cut short.'));
    const error = await rejection(Buffer.concat([Buffer.from('%PDF-1.7\n'), deflateSync(whole).subarray(0, 200)]));
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('damaged or incomplete');
  });

  it('refuses a PDF with more than 500 pages', async () => {
    const error = await rejection(
      await pdf({}, (doc) => {
        doc.text('Page one.');
        for (let page = 0; page < 500; page += 1) doc.addPage();
      }),
    );
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('501 pages');
  });
});

describe('the PNG writer', () => {
  it('writes one-bit, RGB and RGBA pictures and refuses what it does not know', () => {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    for (const [kind, bytes] of [[1, 2], [2, 8 * 2 * 3], [3, 8 * 2 * 4]] as const) {
      const png = encodePng({ width: 8, height: 2, kind, data: new Uint8Array(bytes).fill(0x55) });
      expect(png?.subarray(0, 4).equals(signature)).toBe(true);
      expect(png?.readUInt32BE(16)).toBe(8);
      expect(png?.readUInt32BE(20)).toBe(2);
    }
    expect(encodePng({ width: 8, height: 2, kind: 9, data: new Uint8Array(64) })).toBeNull();
    // A buffer shorter than the size it claims would be read past its end.
    expect(encodePng({ width: 80, height: 20, kind: 2, data: new Uint8Array(10) })).toBeNull();
  });

  it('shrinks a picture far more detailed than the space it is shown in', () => {
    const data = new Uint8Array(400 * 200 * 3).fill(128);
    const png = encodePng({ width: 400, height: 200, kind: 2, data }, 50);
    expect(png?.readUInt32BE(16)).toBe(100);
    expect(png?.readUInt32BE(20)).toBe(50);
  });
});
