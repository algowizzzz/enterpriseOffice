/**
 * The PDF export, checked by reading its own output back.
 *
 * Nothing here looks at bytes. Each test opens the PDF with pdf.js, the same
 * reader a browser uses, and asks what a person would see: how many pages,
 * which words, where on the page, how large, and what can be clicked. No test
 * relies on a font installed on the machine: the operating system's fonts are
 * switched off wherever the outcome would depend on them.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PMNode, StyleTable } from '@docforge/model';
import { exportPdf } from '../src/pdf/exportPdf.js';
import type { PdfExportOptions } from '../src/pdf/exportPdf.js';

interface Word {
  text: string;
  x: number;
  /** Distance of the baseline from the top of the page, in points. */
  y: number;
  size: number;
  width: number;
  /** An identifier private to the file: good for telling two fonts apart, not for naming one. */
  font: string;
  /** What kind of face pdf.js takes the font for: serif, sans-serif or monospace. */
  family: string;
}

interface Page {
  width: number;
  height: number;
  words: Word[];
  text: string;
  links: Array<{ url: string; rect: number[] }>;
}

interface Read {
  pages: Page[];
  info: Record<string, unknown>;
}

beforeAll(async () => {
  // pdf.js looks for its worker here before trying to start a real one, which
  // in Node would mean resolving a file path it cannot find under Vitest. The
  // specifier is a variable so that the type checker leaves the module alone:
  // it ships no declarations.
  const worker = 'pdfjs-dist/legacy/build/pdf.worker.mjs';
  (globalThis as any).pdfjsWorker = await import(/* @vite-ignore */ worker);
});

async function read(data: Buffer): Promise<Read> {
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const pdf = await task.promise;
  const pages: Page[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const view = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const words: Word[] = [];
    for (const item of content.items) {
      if (!('str' in item) || item.str.trim() === '') continue;
      words.push({
        text: item.str,
        x: item.transform[4],
        y: view.height - item.transform[5],
        size: Math.hypot(item.transform[0], item.transform[1]),
        width: item.width,
        font: item.fontName,
        family: content.styles[item.fontName]?.fontFamily ?? '',
      });
    }
    const annotations = await page.getAnnotations();
    pages.push({
      width: view.width,
      height: view.height,
      words,
      text: words.map((word) => word.text).join(' ').replace(/\s+/g, ' '),
      links: annotations
        .filter((annotation) => annotation.subtype === 'Link' && typeof annotation.url === 'string')
        .map((annotation) => ({ url: annotation.url as string, rect: annotation.rect as number[] })),
    });
  }
  const meta = await pdf.getMetadata();
  await task.destroy();
  return { pages, info: meta.info as Record<string, unknown> };
}

const FIXED: Partial<PdfExportOptions> = { creationDate: new Date('2024-01-02T03:04:05Z'), systemFonts: false };

async function render(doc: PMNode, options: Partial<PdfExportOptions> = {}): Promise<Read> {
  return read(await exportPdf(doc, { title: 'Test', ...FIXED, ...options }));
}

const text = (value: string, marks?: PMNode['marks']): PMNode => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
const para = (value: string | PMNode[], attrs?: Record<string, unknown>): PMNode => ({
  type: 'paragraph',
  ...(attrs ? { attrs } : {}),
  content: typeof value === 'string' ? (value ? [text(value)] : []) : value,
});
const heading = (level: number, value: string): PMNode => ({ type: 'heading', attrs: { level }, content: [text(value)] });
const doc = (...content: PMNode[]): PMNode => ({ type: 'doc', content });
const item = (...content: PMNode[]): PMNode => ({ type: 'listItem', content });
const cell = (value: string, attrs: Record<string, unknown> = {}, type = 'tableCell'): PMNode => ({
  type,
  attrs,
  content: [para(value)],
});
const row = (...cells: PMNode[]): PMNode => ({ type: 'tableRow', content: cells });

const SENTENCE = 'The committee met on Tuesday and agreed the wording of the third clause without a vote. ';

function find(page: Page | undefined, needle: string): Word {
  const word = page?.words.find((candidate) => candidate.text.includes(needle));
  if (!word) throw new Error(`"${needle}" is not on the page. The page reads: ${page?.text ?? '(no page)'}`);
  return word;
}

/** A PNG of one flat colour, made here so that no fixture file is needed. */
function png(width: number, height: number, alpha = false): string {
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([head.subarray(4), body])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
  const line = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * (alpha ? 4 : 3), 0x66)]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => line));
  const file = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${file.toString('base64')}`;
}

/** Where pictures were painted, which pdf.js reports as drawing operations and not as text. */
async function pictures(data: Buffer): Promise<Array<{ width: number; height: number; x: number }>> {
  const task = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const pdf = await task.promise;
  const page = await pdf.getPage(1);
  const list = await page.getOperatorList();
  const found: Array<{ width: number; height: number; x: number }> = [];
  let matrix: number[] = [1, 0, 0, 1, 0, 0];
  list.fnArray.forEach((fn, index) => {
    if (fn === pdfjs.OPS.transform) matrix = list.argsArray[index] as number[];
    if (fn === pdfjs.OPS.paintImageXObject) {
      found.push({ width: Math.abs(matrix[0] ?? 0), height: Math.abs(matrix[3] ?? 0), x: matrix[4] ?? 0 });
    }
  });
  await task.destroy();
  return found;
}

async function operations(data: Buffer): Promise<Array<{ name: string; args: unknown[] }>> {
  const task = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const pdf = await task.promise;
  const list = await (await pdf.getPage(1)).getOperatorList();
  const names = new Map(Object.entries(pdfjs.OPS).map(([name, code]) => [code, name]));
  const out = list.fnArray.map((fn, index) => ({ name: names.get(fn) ?? '', args: (list.argsArray[index] ?? []) as unknown[] }));
  await task.destroy();
  return out;
}

/** Straight horizontal strokes on the first page: underlines, strike-throughs and rules. */
async function rules(data: Buffer): Promise<Array<{ colour: string; x: number; y: number; width: number }>> {
  const found: Array<{ colour: string; x: number; y: number; width: number }> = [];
  let colour = '#000000';
  for (const { name, args } of await operations(data)) {
    if (name === 'setStrokeRGBColor') colour = String(args[0]);
    if (name !== 'constructPath') continue;
    const path = Array.from((args[1] as ArrayLike<ArrayLike<number>>)[0] ?? []);
    // A move and a line: six numbers, and the same height at both ends.
    if (path.length === 6 && path[2] === path[5]) {
      found.push({ colour, x: path[1] ?? 0, y: path[2] ?? 0, width: (path[4] ?? 0) - (path[1] ?? 0) });
    }
  }
  return found;
}

async function fills(data: Buffer): Promise<string[]> {
  return (await operations(data)).filter(({ name }) => name === 'setFillRGBColor').map(({ args }) => String(args[0]));
}

describe('exporting a document as a PDF', () => {
  it('produces a PDF that a reader opens', async () => {
    const data = await exportPdf(doc(para('Hello.')), { title: 'Minutes', ...FIXED });
    expect(data.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(data.subarray(-6).toString('latin1')).toContain('%%EOF');
    expect((await read(data)).pages).toHaveLength(1);
  });

  it('writes every paragraph, in order', async () => {
    const out = await render(doc(heading(1, 'Minutes'), para('First point.'), para('Second point.'), para('Third point.')));
    const page = out.pages[0];
    expect(page?.text).toContain('Minutes First point. Second point. Third point.');
    const ys = ['Minutes', 'First', 'Second', 'Third'].map((needle) => find(page, needle).y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it('prints on A4 with an inch of margin all round', async () => {
    const out = await render(doc(para(SENTENCE.repeat(12))));
    const page = out.pages[0];
    expect(page?.width).toBeCloseTo(595.28, 1);
    expect(page?.height).toBeCloseTo(841.89, 1);
    const body = page?.words.filter((word) => !word.text.startsWith('Page ')) ?? [];
    expect(Math.min(...body.map((word) => word.x))).toBeCloseTo(72, 0);
    expect(Math.min(...body.map((word) => word.y))).toBeGreaterThan(72);
  });

  it('turns the page for landscape', async () => {
    const out = await render(doc(para('Wide.')), { pageSetup: { header: '', footer: '', orientation: 'landscape' } });
    expect(out.pages[0]?.width).toBeCloseTo(841.89, 1);
    expect(out.pages[0]?.height).toBeCloseTo(595.28, 1);
  });

  it('breaks a long document over pages and numbers them "Page 2 of 5"', async () => {
    const out = await render(doc(...Array.from({ length: 5 }, () => [para('A page.'), { type: 'pageBreak' }]).flat()));
    expect(out.pages).toHaveLength(5);
    out.pages.forEach((page, index) => {
      expect(page.text).toContain(`Page ${index + 1} of 5`);
      const label = find(page, `Page ${index + 1} of 5`);
      expect(label.y).toBeGreaterThan(page.height - 72);
      expect(label.x).toBeGreaterThan(page.width / 2);
    });
  });

  it('flows a long paragraph across pages without losing a word', async () => {
    const words = Array.from({ length: 1500 }, (_, index) => `w${index}`);
    const out = await render(doc(para(words.join(' '))));
    expect(out.pages.length).toBeGreaterThan(1);
    const seen = out.pages.flatMap((page) => page.text.split(' ')).filter((word) => /^w\d+$/.test(word));
    expect(seen).toEqual(words);
    for (const page of out.pages) {
      const body = page.words.filter((word) => /^w\d+/.test(word.text));
      expect(Math.max(...body.map((word) => word.y))).toBeLessThanOrEqual(page.height - 72);
    }
  });

  it('prints the running header and footer on every page', async () => {
    const out = await render(doc(para('One.'), { type: 'pageBreak' }, para('Two.'), { type: 'pageBreak' }, para('Three.')), {
      pageSetup: { header: 'Board papers', footer: 'In confidence', orientation: 'portrait' },
    });
    expect(out.pages).toHaveLength(3);
    for (const page of out.pages) {
      expect(find(page, 'Board papers').y).toBeLessThan(72);
      expect(find(page, 'In confidence').y).toBeGreaterThan(page.height - 72);
    }
  });

  it('cuts a running header that is too long rather than letting it spill down the page', async () => {
    const out = await render(doc(para('Body.')), {
      pageSetup: { header: 'A very long running header '.repeat(11), footer: '', orientation: 'portrait' },
    });
    const top = out.pages[0]?.words.filter((word) => word.y < 72) ?? [];
    expect(new Set(top.map((word) => Math.round(word.y))).size).toBe(1);
    expect(top.map((word) => word.text).join('')).toContain('\u2026');
  });

  it('keeps a heading with the paragraph under it', async () => {
    // Filler that ends with room for the heading but not for the heading and
    // a line of the text under it. The count is searched for, not assumed, so
    // the test does not depend on the exact height of a line.
    let stranded = 0;
    for (let lines = 38; lines < 50; lines += 1) {
      const filler = Array.from({ length: lines }, (_, index) => para(`Filler ${index}`, { spacingAfter: 0 }));
      const out = await render(doc(...filler, heading(2, 'Conclusions'), para(SENTENCE.repeat(3))));
      const headingPage = out.pages.findIndex((page) => page.text.includes('Conclusions'));
      const bodyPage = out.pages.findIndex((page) => page.text.includes('The committee met'));
      expect(headingPage).toBe(bodyPage);
      if (headingPage === 1 && out.pages[0]?.text.includes(`Filler ${lines - 1}`)) stranded += 1;
    }
    // At least one of those lengths pushed the heading over, so the rule was really exercised.
    expect(stranded).toBeGreaterThan(0);
  });

  it('gives headings their sizes and sets them bold', async () => {
    const out = await render(doc(heading(1, 'Title'), heading(2, 'Section'), heading(3, 'Clause'), para('Body text.')));
    const page = out.pages[0];
    expect(find(page, 'Title').size).toBeCloseTo(20, 1);
    expect(find(page, 'Section').size).toBeCloseTo(16, 1);
    expect(find(page, 'Clause').size).toBeCloseTo(14, 1);
    expect(find(page, 'Body text').size).toBeCloseTo(11, 1);
    expect(find(page, 'Title').font).not.toBe(find(page, 'Body text').font);
  });

  it('keeps mixed formatting on one line and in order', async () => {
    const out = await render(
      doc(
        para([
          text('Plain '),
          text('bold', [{ type: 'bold' }]),
          text(' then '),
          text('italic', [{ type: 'italic' }]),
          text(' then H'),
          text('2', [{ type: 'subscript' }]),
          text('O and x'),
          text('2', [{ type: 'superscript' }]),
          text(' in '),
          text('large', [{ type: 'textStyle', attrs: { fontSize: '18pt' } }]),
          text(' type.'),
        ]),
      ),
    );
    const page = out.pages[0];
    const line = ['Plain', 'bold', 'then', 'italic', 'large', 'type.'].map((needle) => find(page, needle));
    for (const word of line) expect(word.y).toBeCloseTo(line[0]?.y ?? 0, 1);
    expect(line.map((word) => word.x)).toEqual([...line.map((word) => word.x)].sort((a, b) => a - b));
    expect(new Set([find(page, 'Plain').font, find(page, 'bold').font, find(page, 'italic').font]).size).toBe(3);
    expect(find(page, 'large').size).toBeCloseTo(18, 1);

    const twos = page?.words.filter((word) => word.text === '2') ?? [];
    expect(twos).toHaveLength(2);
    const baseline = find(page, 'Plain').y;
    expect(twos[0]?.y).toBeGreaterThan(baseline);
    expect(twos[1]?.y).toBeLessThan(baseline);
    expect(twos[0]?.size).toBeLessThan(11);
  });

  it('does not split a word where its formatting changes', async () => {
    // "unbreakable" is half bold. Treating the change of font as a place to
    // break put "un" at the end of one line and "breakable" on the next.
    const lead = 'x '.repeat(200);
    for (let pad = 0; pad < 12; pad += 1) {
      const out = await render(doc(para([text(lead + 'y'.repeat(pad) + ' un'), text('breakable', [{ type: 'bold' }])])));
      const page = out.pages[0];
      expect(find(page, 'un').y).toBeCloseTo(find(page, 'breakable').y, 1);
    }
  });

  it('aligns text left, centre and right, and stretches justified lines to both margins', async () => {
    const out = await render(
      doc(
        para('Left', { textAlign: 'left' }),
        para('Middle', { textAlign: 'center' }),
        para('Right', { textAlign: 'right' }),
        para(SENTENCE.repeat(4), { textAlign: 'justify' }),
      ),
    );
    const page = out.pages[0];
    expect(find(page, 'Left').x).toBeCloseTo(72, 0);
    expect(find(page, 'Middle').x).toBeGreaterThan(250);
    expect(find(page, 'Middle').x).toBeLessThan(300);
    expect(find(page, 'Right').x).toBeGreaterThan(480);

    const justified = page?.words.filter((word) => word.y > find(page, 'Right').y + 5 && !word.text.startsWith('Page')) ?? [];
    const firstLine = justified.filter((word) => Math.abs(word.y - (justified[0]?.y ?? 0)) < 1);
    expect(Math.min(...firstLine.map((word) => word.x))).toBeCloseTo(72, 0);
    // A full justified line ends exactly at the right margin. Left-aligned, the
    // same line would stop wherever its last word happened to.
    expect(Math.max(...firstLine.map((word) => word.x + word.width))).toBeCloseTo(595.28 - 72, 0);
  });

  it('indents the first line, and hangs the rest when the indent is negative', async () => {
    const out = await render(
      doc(
        para(`Indented ${SENTENCE.repeat(3)}`, { indentFirstLine: 720 }),
        para(`Hanging ${SENTENCE.repeat(3)}`, { indentLeft: 720, indentFirstLine: -720 }),
      ),
    );
    const page = out.pages[0];
    const indented = find(page, 'Indented');
    expect(indented.x).toBeCloseTo(72 + 36, 0);
    const second = page?.words.find((word) => word.y > indented.y + 5);
    expect(second?.x).toBeCloseTo(72, 0);

    const hanging = find(page, 'Hanging');
    expect(hanging.x).toBeCloseTo(72, 0);
    const under = page?.words.find((word) => word.y > hanging.y + 5 && !word.text.startsWith('Page'));
    expect(under?.x).toBeCloseTo(72 + 36, 0);
  });

  it('takes its look from the styles of the Word file the document came from', async () => {
    const styles: StyleTable = {
      defaults: { fontSize: 10, fontFamily: 'Cambria' },
      defaultParagraph: 'Normal',
      paragraph: {
        Normal: { name: 'Normal', props: { spacingAfter: 0 } },
        Quote: { name: 'Quote', props: { fontSize: 14, indentLeft: 1440, italic: true } },
        Heading1: { name: 'heading 1', props: { fontSize: 26, bold: true } },
      },
      character: {},
    };
    const out = await render(
      doc(heading(1, 'Styled heading'), para('Ordinary.'), para('Quoted.', { styleId: 'Quote' }), para('Overridden.', { styleId: 'Quote', indentLeft: 0 })),
      { styles },
    );
    const page = out.pages[0];
    expect(find(page, 'Styled heading').size).toBeCloseTo(26, 1);
    expect(find(page, 'Ordinary').size).toBeCloseTo(10, 1);
    expect(find(page, 'Quoted').size).toBeCloseTo(14, 1);
    expect(find(page, 'Quoted').x).toBeCloseTo(72 + 72, 0);
    // The paragraph's own formatting wins over the style it names.
    expect(find(page, 'Overridden').x).toBeCloseTo(72, 0);
    // Cambria is a serif, so the nearest built-in family is Times, not Helvetica.
    expect(find(page, 'Ordinary').family).toBe('serif');
  });

  it('draws a list with its numbers, restarting for each list', async () => {
    const ordered = (format: string, ...items: PMNode[]): PMNode => ({ type: 'orderedList', attrs: { listFormat: format, start: 1 }, content: items });
    const out = await render(
      doc(
        ordered('decimal', item(para('Alpha')), item(para('Beta')), item(para('Gamma'))),
        para('Between the lists.'),
        ordered('decimal', item(para('Delta')), item(para('Epsilon'))),
        ordered('upperRoman', item(para('Zeta')), item(para('Eta')), item(para('Theta')), item(para('Iota'))),
        { type: 'orderedList', attrs: { listFormat: 'decimal', start: 7 }, content: [item(para('Kappa'))] },
      ),
    );
    const page = out.pages[0];
    expect(page?.text).toContain('1. Alpha 2. Beta 3. Gamma Between the lists. 1. Delta 2. Epsilon I. Zeta II. Eta III. Theta IV. Iota 7. Kappa');
    const number = find(page, '2.');
    const label = find(page, 'Beta');
    expect(number.y).toBeCloseTo(label.y, 1);
    expect(number.x).toBeLessThan(label.x);
    expect(label.x).toBeCloseTo(72 + 36, 0);
  });

  it('indents a list inside a list by a quarter of an inch, with its own numbering', async () => {
    const out = await render(
      doc({
        type: 'orderedList',
        attrs: { listFormat: 'decimal' },
        content: [
          item(para('Outer one'), {
            type: 'orderedList',
            attrs: { listFormat: 'lowerLetter' },
            content: [item(para('Inner one')), item(para('Inner two'), { type: 'bulletList', content: [item(para('Deepest'))] })],
          }),
          item(para(`Outer two ${SENTENCE.repeat(3)}`)),
        ],
      }),
    );
    const page = out.pages[0];
    expect(page?.text).toContain('1. Outer one a. Inner one b. Inner two');
    expect(page?.text).toContain('2. Outer two');
    const outer = find(page, 'Outer one').x;
    expect(find(page, 'Inner one').x).toBeCloseTo(outer + 18, 0);
    expect(find(page, 'Deepest').x).toBeCloseTo(outer + 36, 0);
    // A wrapped line of an item starts under the item's text, not under its number.
    const wrapped = page?.words.find((word) => word.y > find(page, 'Outer two').y + 5 && !word.text.startsWith('Page'));
    expect(wrapped?.x).toBeCloseTo(outer, 0);
  });

  it('marks a bulleted list with bullets', async () => {
    const out = await render(doc({ type: 'bulletList', content: [item(para('Apples')), item(para('Pears'))] }));
    expect(out.pages[0]?.text).toContain('\u2022 Apples \u2022 Pears');
  });

  it('lays a table out in columns, wrapping text inside its cell', async () => {
    const out = await render(
      doc({
        type: 'table',
        content: [
          row(cell('Item', { colwidth: [120] }, 'tableHeader'), cell('Decision', { colwidth: [480] }, 'tableHeader')),
          row(cell('Clause three'), cell(SENTENCE.repeat(4))),
          row(cell('Clause four'), cell('Deferred.')),
        ],
      }),
    );
    const page = out.pages[0];
    const left = find(page, 'Item');
    const right = find(page, 'Decision');
    expect(left.y).toBeCloseTo(right.y, 1);
    // 120px and 480px are 90pt and 360pt: the second column starts 90pt after the first.
    expect(right.x - left.x).toBeCloseTo(90, 0);
    const wrapped = page?.words.filter((word) => word.text.includes('committee')) ?? [];
    expect(wrapped.length).toBeGreaterThan(0);
    for (const word of page?.words.filter((candidate) => candidate.y > left.y + 5 && candidate.y < find(page, 'Clause four').y - 5) ?? []) {
      if (word.text.includes('Clause three')) continue;
      expect(word.x).toBeGreaterThanOrEqual(right.x - 0.5);
    }
    // The row below starts under the tallest cell of the row above, not under its first line.
    expect(find(page, 'Clause four').y).toBeGreaterThan(Math.max(...wrapped.map((word) => word.y)));
    expect(left.font).not.toBe(find(page, 'Clause three').font);
  });

  it('shrinks a table that is wider than the page to fit between the margins', async () => {
    const out = await render(doc({ type: 'table', content: [row(cell('A', { colwidth: [800] }), cell('B', { colwidth: [800] }))] }));
    const page = out.pages[0];
    expect(find(page, 'B').x - find(page, 'A').x).toBeCloseTo((595.28 - 144) / 2, 0);
  });

  it('honours cells that span columns and rows', async () => {
    const out = await render(
      doc({
        type: 'table',
        content: [
          row(cell('Wide', { colspan: 2 }), cell('Tall', { rowspan: 2 })),
          row(cell('One'), cell('Two')),
          row(cell('Three'), cell('Four'), cell('Five')),
        ],
      }),
    );
    const page = out.pages[0];
    const third = (595.28 - 144) / 3;
    expect(find(page, 'Tall').x - find(page, 'Wide').x).toBeCloseTo(2 * third, 0);
    // "Two" sits in the second column because the third is taken by the cell above it.
    expect(find(page, 'Two').x - find(page, 'One').x).toBeCloseTo(third, 0);
    expect(find(page, 'Five').x).toBeCloseTo(find(page, 'Tall').x, 0);
  });

  it("repeats a table's header row on the next page", async () => {
    const rows = Array.from({ length: 80 }, (_, index) => row(cell(`Name ${index}`), cell(`Value ${index}`)));
    const out = await render(doc({ type: 'table', content: [row(cell('Column A', {}, 'tableHeader'), cell('Column B', {}, 'tableHeader')), ...rows] }));
    expect(out.pages.length).toBeGreaterThan(1);
    for (const page of out.pages) {
      const head = find(page, 'Column A');
      const firstRow = page.words.find((word) => word.text.startsWith('Name '));
      expect(head.y).toBeLessThan(firstRow?.y ?? 0);
    }
    const all = out.pages.map((page) => page.text).join(' ');
    for (let index = 0; index < 80; index += 1) expect(all).toContain(`Name ${index} Value ${index}`);
    expect(all.match(/Column A/g)).toHaveLength(out.pages.length);
  });

  it('keeps a row in one piece rather than splitting it', async () => {
    const tall = SENTENCE.repeat(9);
    const rows = Array.from({ length: 12 }, (_, index) => row(cell(`Row ${index} start. ${tall} Row ${index} end.`)));
    const out = await render(doc({ type: 'table', content: rows }));
    expect(out.pages.length).toBeGreaterThan(1);
    for (let index = 0; index < 12; index += 1) {
      const startPage = out.pages.findIndex((page) => page.text.includes(`Row ${index} start.`));
      const endPage = out.pages.findIndex((page) => page.text.includes(`Row ${index} end.`));
      expect(startPage).toBeGreaterThanOrEqual(0);
      expect(endPage).toBe(startPage);
    }
  });

  it('cuts a row taller than a whole page between lines, so that none of it is lost', async () => {
    // A row is normally placed whole. One that no page can hold used to run
    // off the bottom of the paper, and everything past the margin was gone.
    const words = Array.from({ length: 1200 }, (_, index) => `c${index}`);
    const out = await render(doc({ type: 'table', content: [row(cell(words.join(' ')), cell('Beside it'))] }));
    expect(out.pages.length).toBeGreaterThan(1);
    const seen = out.pages.flatMap((page) => page.text.split(' ')).filter((word) => /^c\d+$/.test(word));
    expect(seen).toEqual(words);
    for (const page of out.pages) {
      const body = page.words.filter((word) => /^c\d+/.test(word.text));
      expect(Math.max(...body.map((word) => word.y))).toBeLessThanOrEqual(page.height - 72);
    }
  });

  it('draws a table inside a table', async () => {
    const inner: PMNode = { type: 'table', content: [row(cell('Inner left'), cell('Inner right'))] };
    const out = await render(doc({ type: 'table', content: [row(cell('Outer'), { type: 'tableCell', content: [para('Holds:'), inner] })] }));
    const page = out.pages[0];
    expect(find(page, 'Inner left').y).toBeCloseTo(find(page, 'Inner right').y, 1);
    expect(find(page, 'Inner right').x).toBeGreaterThan(find(page, 'Inner left').x);
    expect(find(page, 'Inner left').x).toBeGreaterThan(find(page, 'Outer').x + 100);
  });

  it('makes a link something that can be clicked', async () => {
    const out = await render(
      doc(
        para('A paragraph above.'),
        para([text('The register', [{ type: 'link', attrs: { href: 'https://example.org/register' } }]), text(' has the details.')]),
      ),
    );
    const page = out.pages[0];
    expect(page?.links).toHaveLength(1);
    expect(page?.links[0]?.url).toBe('https://example.org/register');
    const word = find(page, 'The register');
    const rect = page?.links[0]?.rect ?? [];
    // The clickable area is where the words are, not somewhere else on the page.
    expect(rect[0]).toBeCloseTo(word.x, 0);
    expect((rect[2] ?? 0) - (rect[0] ?? 0)).toBeGreaterThan(40);
    expect((rect[2] ?? 0) - (rect[0] ?? 0)).toBeLessThan(90);
    expect((page?.height ?? 0) - word.y).toBeGreaterThan(rect[1] ?? 0);
    expect((page?.height ?? 0) - word.y).toBeLessThan(rect[3] ?? 0);
  });

  it('does not make a link out of an address that runs script', async () => {
    const out = await render(doc(para([text('Click me', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }])])));
    expect(out.pages[0]?.text).toContain('Click me');
    expect(out.pages[0]?.links).toHaveLength(0);
  });

  it('draws a tracked deletion struck out and an insertion underlined', async () => {
    const data = await exportPdf(
      doc(
        para([
          text('The fee is '),
          text('ten', [{ type: 'deletion', attrs: { author: 'A', date: '2024-01-01' } }]),
          text('twelve', [{ type: 'insertion', attrs: { author: 'A', date: '2024-01-01' } }]),
          text(' pounds.'),
        ]),
      ),
      { title: 'Tracked', ...FIXED },
    );
    const out = await read(data);
    expect(out.pages[0]?.text).toContain('The fee is');
    expect(out.pages[0]?.text).toContain('ten');
    expect(out.pages[0]?.text).toContain('twelve');
    expect(out.pages[0]?.text).toContain('pounds.');

    const baseline = find(out.pages[0], 'The fee is').y;
    const red = (await rules(data)).filter((line) => line.colour === '#c00000');
    expect(red).toHaveLength(2);
    const [struck, under] = [...red].sort((a, b) => a.x - b.x);
    // The deletion comes first on the line and its rule runs through the
    // letters; the insertion follows it and its rule runs beneath them.
    expect(struck?.y).toBeLessThan(baseline - 1);
    expect(under?.y).toBeGreaterThan(baseline);
    expect(under?.x).toBeCloseTo((struck?.x ?? 0) + (struck?.width ?? 0), 0);
  });

  it('underlines, strikes and highlights the words that ask for it and no others', async () => {
    const data = await exportPdf(
      doc(para([text('plain '), text('under', [{ type: 'underline' }]), text(' plain '), text('marked', [{ type: 'highlight', attrs: { color: '#00ff00' } }])])),
      { title: 'Marks', ...FIXED },
    );
    expect((await rules(data)).filter((line) => line.colour === '#000000')).toHaveLength(1);
    expect(await fills(data)).toContain('#00ff00');
  });

  it('draws a picture at its stated size, and shrinks one that is wider than the page', async () => {
    const small = await exportPdf(doc(para([{ type: 'image', attrs: { src: png(4, 2), width: 200, height: 100 } }])), { title: 'P', ...FIXED });
    expect((await pictures(small))[0]?.width).toBeCloseTo(150, 0);
    expect((await pictures(small))[0]?.height).toBeCloseTo(75, 0);

    const wide = await exportPdf(doc(para([{ type: 'image', attrs: { src: png(4, 2), width: 2000, height: 1000 } }])), { title: 'P', ...FIXED });
    const drawn = (await pictures(wide))[0];
    expect(drawn?.width).toBeCloseTo(595.28 - 144, 0);
    expect((drawn?.width ?? 0) / (drawn?.height ?? 1)).toBeCloseTo(2, 2);
  });

  it('centres a picture that is alone in a centred paragraph', async () => {
    const data = await exportPdf(doc(para([{ type: 'image', attrs: { src: png(4, 4), width: 96, height: 96 } }], { textAlign: 'center' })), {
      title: 'P',
      ...FIXED,
    });
    expect((await pictures(data))[0]?.x).toBeCloseTo((595.28 - 72) / 2, 0);
  });

  it('leaves out a picture it cannot draw and carries on with the text', async () => {
    const gif = `data:image/gif;base64,${Buffer.from('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;', 'latin1').toString('base64')}`;
    const broken = `data:image/png;base64,${Buffer.from('not a picture at all').toString('base64')}`;
    const truncated = png(40, 40).slice(0, 120);
    const out = await render(
      doc(
        para([text('Before. '), { type: 'image', attrs: { src: gif, width: 10, height: 10 } }]),
        para([{ type: 'image', attrs: { src: broken, width: 10, height: 10 } }]),
        para([{ type: 'image', attrs: { src: truncated, width: 10, height: 10 } }]),
        para('After.'),
      ),
    );
    expect(out.pages[0]?.text).toContain('Before.');
    expect(out.pages[0]?.text).toContain('After.');
  });

  it('is not brought down by a see-through picture whose data is damaged', async () => {
    // pdfkit unpacks a PNG that has transparency inside a zlib callback and
    // rethrows a failure from there, outside any try/catch: one bad picture
    // was an uncaught exception, which in the server means the process exits.
    const sound = png(8, 8, true);
    const bytes = Buffer.from(sound.slice(sound.indexOf(',') + 1), 'base64');
    const idat = bytes.indexOf('IDAT', 0, 'latin1');
    for (let at = idat + 6; at < idat + 12; at += 1) bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    const damaged = `data:image/png;base64,${bytes.toString('base64')}`;

    const data = await exportPdf(
      doc(para([{ type: 'image', attrs: { src: sound, width: 40, height: 40 } }]), para([{ type: 'image', attrs: { src: damaged, width: 40, height: 40 } }]), para('Still here.')),
      { title: 'P', ...FIXED },
    );
    // The sound one is drawn, the damaged one is left out, and the text survives.
    expect(await pictures(data)).toHaveLength(1);
    expect((await read(data)).pages[0]?.text).toContain('Still here.');
  });

  it('draws curly quotes and dashes as themselves', async () => {
    const typed = '\u201cQuoted\u201d and \u2018single\u2019, 1914\u20131918, wait\u2014what\u2026 \u20ac5 \u2022 caf\u00e9 \u2122';
    const out = await render(doc(para(typed)));
    expect(out.pages[0]?.text).toContain(typed);
    expect(out.pages[0]?.text).not.toContain('?');
  });

  it('draws a non-breaking space and a non-breaking hyphen, and does not break the line at either', async () => {
    const out = await render(doc(para(`${'x '.repeat(118)}10\u00a0000\u00a0km and well\u2011known.`)));
    const page = out.pages[0];
    expect(page?.text).toContain('10 000 km');
    expect(page?.text).toContain('well-known.');
    expect(page?.text).not.toContain('?');
  });

  it('survives characters its fonts cannot draw', async () => {
    const out = await render(doc(para('Arabic \u0645\u0631\u062d\u0628\u0627, Chinese \u4f60\u597d, Hindi \u0928\u092e\u0938\u094d\u0924\u0947, emoji \ud83d\ude00, done.')), {
      fontDirs: ['/nowhere/that/exists'],
    });
    const page = out.pages[0];
    // With no font to draw them, each becomes a question mark: never an
    // exception, and never the wrong letters.
    expect(page?.text).toContain('Arabic ?????,');
    expect(page?.text).toContain('Chinese ??,');
    expect(page?.text).toContain('emoji ?,');
    expect(page?.text).toContain('done.');
  });

  it('still produces the document when it may look for fonts on the machine', async () => {
    // Whatever this machine has installed, or has not, the export completes
    // and the Latin text around the foreign words is intact.
    const out = await render(doc(para('Before \u0645\u0631\u062d\u0628\u0627 \u4f60\u597d after.')), { systemFonts: true });
    expect(out.pages[0]?.text).toContain('Before');
    expect(out.pages[0]?.text).toContain('after.');
  });

  it('indents a block quotation', async () => {
    const out = await render(doc(para('Said plainly.'), { type: 'blockquote', content: [para('Said by another.')] }, { type: 'horizontalRule' }, para('After the rule.')));
    const page = out.pages[0];
    expect(find(page, 'Said by another').x).toBeCloseTo(72 + 18, 0);
    expect(find(page, 'After the rule').x).toBeCloseTo(72, 0);
  });

  it('does not leave a blank page after a trailing page break', async () => {
    const out = await render(doc(para('Only page.'), { type: 'pageBreak' }));
    expect(out.pages).toHaveLength(1);
  });

  it('does not start with a blank page, or make two from breaks that follow each other', async () => {
    const out = await render(doc({ type: 'pageBreak' }, para('First.'), { type: 'pageBreak' }, { type: 'pageBreak' }, para('Second.'), { type: 'pageBreak' }, { type: 'pageBreak' }));
    expect(out.pages).toHaveLength(2);
    expect(out.pages[0]?.text).toContain('First.');
    expect(out.pages[1]?.text).toContain('Second.');
  });

  it('draws what Word holds that the editor has no node for', async () => {
    const out = await render(
      doc(
        para([
          text('A claim'),
          { type: 'wordInline', attrs: { kind: 'footnote', label: '1' } },
          { type: 'wordInline', attrs: { kind: 'bookmark', label: 'hidden-bookmark' } },
          { type: 'wordInline', attrs: { kind: 'comment', label: 'hidden-comment' } },
          text(' dated '),
          { type: 'wordInline', attrs: { kind: 'field', label: '1 March 2024' } },
        ]),
        { type: 'wordBlock', attrs: { kind: 'chart', label: 'Chart: revenue\nby quarter' } },
        { type: 'wordBlock', attrs: { kind: 'toc', label: 'Introduction 1\nFindings and recommendations 12' } },
      ),
    );
    const page = out.pages[0];
    expect(page?.text).toContain('1 March 2024');
    expect(page?.text).not.toContain('hidden');
    const mark = page?.words.find((word) => word.text === '1');
    expect(mark?.size).toBeLessThan(11);
    expect(mark?.y).toBeLessThan(find(page, 'A claim').y);
    expect(find(page, 'by quarter').y).toBeGreaterThan(find(page, 'Chart: revenue').y);
    // A contents line: the title at the left margin, its page number at the right.
    const title = find(page, 'Findings and recommendations');
    const number = page?.words.find((word) => word.text === '12');
    expect(number?.y).toBeCloseTo(title.y, 1);
    expect(number?.x).toBeGreaterThan(480);
  });

  it('records the title and the author, and says DocForge made it', async () => {
    const out = await render(doc(para('Body.')), { title: 'Annual report \u2013 2024', author: 'J. Okafor' });
    expect(out.info['Title']).toBe('Annual report \u2013 2024');
    expect(out.info['Author']).toBe('J. Okafor');
    expect(out.info['Creator']).toBe('DocForge');
  });

  it('exports the same document to the same bytes when the date is fixed', async () => {
    const source = doc(heading(1, 'Same'), para(SENTENCE));
    const first = await exportPdf(source, { title: 'Same', ...FIXED });
    const second = await exportPdf(source, { title: 'Same', ...FIXED });
    expect(first.equals(second)).toBe(true);
  });

  it('never throws on a node it has not heard of', async () => {
    const out = await render(
      doc(
        { type: 'callout', attrs: { tone: 'warning' }, content: [para('Inside an unknown block.')] },
        { type: 'mystery', text: 'Bare text on an unknown node.' },
        para([{ type: 'mention', attrs: { id: 7 }, content: [text('inline unknown')] }, text(' tail')]),
        { type: 'listItem', content: [para('An item with no list.')] },
        { type: 'tableRow', content: [cell('A row with no table.')] },
        { type: 'table', content: [] },
        { type: 'table', content: [{ type: 'tableRow', content: [] }] },
        { type: 'bulletList' },
        { type: 'paragraph', attrs: { textAlign: 'sideways', indentLeft: 'wide', lineHeight: -4, styleId: 'constructor' } },
        para([text('Odd marks', [{ type: 'sparkle' }, { type: 'textStyle', attrs: { color: 'not-a-colour', fontSize: 'huge' } }])]),
      ),
      { styles: { defaults: {}, paragraph: {}, character: {} } },
    );
    const all = out.pages.map((page) => page.text).join(' ');
    for (const expected of ['Inside an unknown block.', 'Bare text on an unknown node.', 'inline unknown', 'An item with no list.', 'A row with no table.', 'Odd marks']) {
      expect(all).toContain(expected);
    }
  });

  it('copes with a document that is not a document', async () => {
    for (const hostile of [{ type: 'doc' }, { type: 'paragraph', content: [text('Loose paragraph.')] }, { type: 'doc', content: [] }, {} as PMNode]) {
      const data = await exportPdf(hostile, { title: '', ...FIXED });
      expect((await read(data)).pages).toHaveLength(1);
    }
  });

  it('stops nesting from running away', async () => {
    let nested: PMNode = para('At the bottom.');
    for (let depth = 0; depth < 400; depth += 1) nested = { type: 'blockquote', content: [nested] };
    const out = await render(doc(nested));
    expect(out.pages[0]?.text).toContain('At the bottom.');
  });

  it('stops at two thousand pages, and says so on the last one', async () => {
    const breaks = Array.from({ length: 2100 }, (_, index) => [para(`p${index}`), { type: 'pageBreak' }]).flat();
    const data = await exportPdf(doc(...breaks), { title: 'Long', ...FIXED });
    const task = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(2000);
    const last = await (await pdf.getPage(2000)).getTextContent();
    expect(last.items.map((entry) => ('str' in entry ? entry.str : '')).join(' ')).toContain('This export stops here');
    await task.destroy();
  }, 120_000);
});
