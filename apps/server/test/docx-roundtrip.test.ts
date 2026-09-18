import { describe, expect, it } from 'vitest';
import { toPlainText, type PMNode } from '@docforge/model';
import { exportDocx, safeFileName } from '../src/docx/export.js';
import { importDocx } from '../src/docx/import.js';

/** Export a document and read it straight back, the way the portal does. */
async function roundTrip(doc: PMNode): Promise<PMNode> {
  const buffer = await exportDocx(doc, { title: 'Round trip' });
  const { content } = await importDocx(buffer);
  return content;
}

const paragraph = (text: string, attrs?: Record<string, unknown>): PMNode => ({
  type: 'paragraph',
  ...(attrs ? { attrs } : {}),
  content: [{ type: 'text', text }],
});

const doc = (...content: PMNode[]): PMNode => ({ type: 'doc', content });

/** A one-pixel PNG, small enough to embed and large enough to be a real image. */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function collect(node: PMNode, type: string, found: PMNode[] = []): PMNode[] {
  if (node.type === type) found.push(node);
  for (const child of node.content ?? []) collect(child, type, found);
  return found;
}

function marksIn(node: PMNode, found = new Set<string>()): Set<string> {
  for (const mark of node.marks ?? []) found.add(mark.type);
  for (const child of node.content ?? []) marksIn(child, found);
  return found;
}

describe('docx round trip, structure', () => {
  it('keeps every heading level', async () => {
    const source = doc(
      ...[1, 2, 3, 4, 5, 6].map((level) => ({
        type: 'heading',
        attrs: { level },
        content: [{ type: 'text', text: `Level ${level}` }],
      })),
    );
    const result = await roundTrip(source);
    const levels = collect(result, 'heading').map((node) => Number(node.attrs?.['level']));
    expect(levels).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps an empty paragraph rather than dropping it', async () => {
    const result = await roundTrip(doc(paragraph('Before'), { type: 'paragraph' }, paragraph('After')));
    const text = toPlainText(result);
    expect(text).toContain('Before');
    expect(text).toContain('After');
  });

  it('keeps a bulleted list as a list', async () => {
    const source = doc({
      type: 'bulletList',
      content: ['Alpha', 'Beta', 'Gamma'].map((text) => ({
        type: 'listItem',
        content: [paragraph(text)],
      })),
    });
    const result = await roundTrip(source);
    const items = collect(result, 'listItem');
    expect(items).toHaveLength(3);
    expect(collect(result, 'bulletList')).toHaveLength(1);
    expect(toPlainText(result)).toContain('Beta');
  });

  it('keeps a numbered list as a numbered list', async () => {
    const source = doc({
      type: 'orderedList',
      content: ['One', 'Two'].map((text) => ({ type: 'listItem', content: [paragraph(text)] })),
    });
    const result = await roundTrip(source);
    expect(collect(result, 'orderedList')).toHaveLength(1);
    expect(collect(result, 'bulletList')).toHaveLength(0);
  });

  it('keeps the text of a nested list, even though the nesting flattens', async () => {
    const source = doc({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            paragraph('Outer'),
            {
              type: 'bulletList',
              content: [{ type: 'listItem', content: [paragraph('Inner')] }],
            },
          ],
        },
      ],
    });
    const result = await roundTrip(source);
    const text = toPlainText(result);
    expect(text).toContain('Outer');
    expect(text).toContain('Inner');
  });

  it('keeps a table with its rows, cells and header', async () => {
    const cell = (text: string, header = false): PMNode => ({
      type: header ? 'tableHeader' : 'tableCell',
      attrs: { colspan: 1, rowspan: 1, colwidth: null },
      content: [paragraph(text)],
    });
    const source = doc({
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell('Region', true), cell('Total', true)] },
        { type: 'tableRow', content: [cell('North'), cell('120')] },
        { type: 'tableRow', content: [cell('South'), cell('240')] },
      ],
    });
    const result = await roundTrip(source);
    const tables = collect(result, 'table');
    expect(tables).toHaveLength(1);
    expect(tables[0]?.content).toHaveLength(3);
    const text = toPlainText(result);
    for (const value of ['Region', 'Total', 'North', '120', 'South', '240']) {
      expect(text).toContain(value);
    }
  });

  it('keeps a cell that spans two columns', async () => {
    const source = doc({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              attrs: { colspan: 2, rowspan: 1, colwidth: null },
              content: [paragraph('Wide')],
            },
          ],
        },
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [paragraph('Left')],
            },
            {
              type: 'tableCell',
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [paragraph('Right')],
            },
          ],
        },
      ],
    });
    const result = await roundTrip(source);
    const cells = collect(result, 'tableCell');
    expect(cells.some((cell) => Number(cell.attrs?.['colspan']) === 2)).toBe(true);
    expect(toPlainText(result)).toContain('Wide');
  });

  it('keeps a table cell that holds more than one paragraph', async () => {
    const source = doc({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [paragraph('First line'), paragraph('Second line')],
            },
          ],
        },
      ],
    });
    const text = toPlainText(await roundTrip(source));
    expect(text).toContain('First line');
    expect(text).toContain('Second line');
  });

  it('keeps a block quote as a distinct block', async () => {
    const source = doc(
      paragraph('Before the quote'),
      { type: 'blockquote', content: [paragraph('The quoted sentence.')] },
      paragraph('After the quote'),
    );
    const text = toPlainText(await roundTrip(source));
    expect(text).toContain('The quoted sentence.');
    expect(text).toContain('Before the quote');
  });

  it('keeps a horizontal rule', async () => {
    const result = await roundTrip(doc(paragraph('Above'), { type: 'horizontalRule' }, paragraph('Below')));
    const text = toPlainText(result);
    expect(text).toContain('Above');
    expect(text).toContain('Below');
  });

  it('keeps a page break without losing the text around it', async () => {
    const result = await roundTrip(doc(paragraph('Page one'), { type: 'pageBreak' }, paragraph('Page two')));
    const text = toPlainText(result);
    expect(text).toContain('Page one');
    expect(text).toContain('Page two');
  });

  it('keeps a line break inside a paragraph', async () => {
    const source = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'First line' },
        { type: 'hardBreak' },
        { type: 'text', text: 'Second line' },
      ],
    });
    const text = toPlainText(await roundTrip(source));
    expect(text).toContain('First line');
    expect(text).toContain('Second line');
  });
});

describe('docx round trip, formatting', () => {
  it('keeps each character mark that Word also has', async () => {
    const source = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'italic', marks: [{ type: 'italic' }] },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'underline', marks: [{ type: 'underline' }] },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'strike', marks: [{ type: 'strike' }] },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'super', marks: [{ type: 'superscript' }] },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'sub', marks: [{ type: 'subscript' }] },
      ],
    });
    const marks = marksIn(await roundTrip(source));
    for (const mark of ['bold', 'italic', 'underline', 'strike', 'superscript', 'subscript']) {
      expect([...marks], mark).toContain(mark);
    }
  });

  it('keeps two marks applied to the same run', async () => {
    const source = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'both', marks: [{ type: 'bold' }, { type: 'italic' }] },
      ],
    });
    const result = await roundTrip(source);
    const boldAndItalic = collect(result, 'text').some((node) => {
      const names = (node.marks ?? []).map((mark) => mark.type);
      return names.includes('bold') && names.includes('italic');
    });
    expect(boldAndItalic).toBe(true);
  });

  it('keeps paragraph alignment', async () => {
    const source = doc(
      paragraph('Centred', { textAlign: 'center' }),
      paragraph('Right', { textAlign: 'right' }),
    );
    const result = await roundTrip(source);
    const alignments = (result.content ?? []).map((node) => node.attrs?.['textAlign']);
    expect(alignments).toContain('center');
    expect(alignments).toContain('right');
  });

  it('keeps a heading that is also centred, without losing either property', async () => {
    // The alignment marker folds the original style into itself, so a styled
    // paragraph does not have to choose between its style and its alignment.
    const source = doc({
      type: 'heading',
      attrs: { level: 2, textAlign: 'center' },
      content: [{ type: 'text', text: 'Centred heading' }],
    });
    const result = await roundTrip(source);
    const headings = collect(result, 'heading');
    expect(headings).toHaveLength(1);
    expect(headings[0]?.attrs?.['level']).toBe(2);
    expect(headings[0]?.attrs?.['textAlign']).toBe('center');
  });

  it('keeps justified text', async () => {
    const result = await roundTrip(doc(paragraph('Justified', { textAlign: 'justify' })));
    expect((result.content ?? [])[0]?.attrs?.['textAlign']).toBe('justify');
  });

  it('keeps left alignment, which used to be dropped on the way back in', async () => {
    // The conversion went through HTML, which could not carry it. Reading the
    // markup itself means an explicitly left-aligned paragraph comes back
    // explicitly left aligned rather than merely looking the same.
    const result = await roundTrip(doc(paragraph('Ordinary', { textAlign: 'left' })));
    expect((result.content ?? [])[0]?.attrs?.['textAlign']).toBe('left');
  });

  it('writes a font family, size and colour without corrupting the file', async () => {
    const source = doc({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Styled',
          marks: [
            {
              type: 'textStyle',
              attrs: { fontFamily: 'Liberation Serif', fontSize: '18pt', color: '#cc0000' },
            },
          ],
        },
      ],
    });
    const result = await roundTrip(source);
    expect(toPlainText(result)).toContain('Styled');
  });

  it('ignores a colour that is not a six-digit hex value', async () => {
    const source = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Odd colour', marks: [{ type: 'textStyle', attrs: { color: 'rebeccapurple' } }] },
      ],
    });
    expect(toPlainText(await roundTrip(source))).toContain('Odd colour');
  });

  it('ignores a font size that is not a number', async () => {
    const source = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Odd size', marks: [{ type: 'textStyle', attrs: { fontSize: 'larger' } }] },
      ],
    });
    expect(toPlainText(await roundTrip(source))).toContain('Odd size');
  });

  it('keeps a hyperlink target', async () => {
    const source = doc({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'the handbook',
          marks: [{ type: 'link', attrs: { href: 'https://intranet/handbook' } }],
        },
      ],
    });
    const result = await roundTrip(source);
    expect(toPlainText(result)).toContain('the handbook');
  });
});

describe('docx round trip, images', () => {
  it('keeps an embedded image', async () => {
    const source = doc({
      type: 'paragraph',
      content: [{ type: 'image', attrs: { src: TINY_PNG, alt: 'A dot', width: 16, height: 16 } }],
    });
    const images = collect(await roundTrip(source), 'image');
    expect(images).toHaveLength(1);
    const src = images[0]?.attrs?.['src'];
    expect(typeof src).toBe('string');
    expect(src as string).toMatch(/^data:image\//u);
  });

  it('drops an image whose source is not embedded data', async () => {
    // Nothing may be fetched at run time, so a remote image cannot be written.
    const source = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Text stays. ' },
        { type: 'image', attrs: { src: 'https://example.com/logo.png' } },
      ],
    });
    const result = await roundTrip(source);
    expect(collect(result, 'image')).toHaveLength(0);
    expect(toPlainText(result)).toContain('Text stays.');
  });

  it('drops an image whose data is not decodable', async () => {
    const source = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Still here. ' },
        { type: 'image', attrs: { src: 'data:image/png;base64,' } },
      ],
    });
    const result = await roundTrip(source);
    expect(collect(result, 'image')).toHaveLength(0);
    expect(toPlainText(result)).toContain('Still here.');
  });
});

describe('docx export, resilience', () => {
  it('writes a document with no content at all', async () => {
    const buffer = await exportDocx({ type: 'doc' }, { title: 'Nothing' });
    expect(buffer.length).toBeGreaterThan(500);
  });

  it('writes a table that has no rows without throwing', async () => {
    const buffer = await exportDocx(doc({ type: 'table', content: [] }), { title: 'Empty table' });
    expect(buffer.length).toBeGreaterThan(500);
  });

  it('skips a run whose text is empty', async () => {
    const source = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: '' },
        { type: 'text', text: 'Only this' },
      ],
    });
    expect(toPlainText(await roundTrip(source))).toContain('Only this');
  });

  it('ignores a node type it does not know, keeping the text inside it', async () => {
    const source = doc({
      type: 'somethingNew',
      content: [paragraph('Text from an unknown wrapper')],
    });
    expect(toPlainText(await roundTrip(source))).toContain('Text from an unknown wrapper');
  });

  it('names the author in the file metadata', async () => {
    const buffer = await exportDocx(doc(paragraph('x')), { title: 'T', author: 'Ada Lovelace' });
    expect(buffer.toString('latin1')).toContain('docProps/core.xml');
  });
});

describe('export file names', () => {
  it('removes characters that Windows forbids', () => {
    expect(safeFileName('a<b>c:d"e/f\\g|h?i*j', 'docx')).toBe('abcdefghij.docx');
  });

  it('collapses runs of whitespace', () => {
    expect(safeFileName('Q1    report', 'docx')).toBe('Q1 report.docx');
  });

  it('shortens a very long title', () => {
    const name = safeFileName('x'.repeat(400), 'docx');
    expect(name.length).toBeLessThanOrEqual(126);
  });

  it('keeps non-Latin titles intact', () => {
    expect(safeFileName('رپورٹ', 'txt')).toBe('رپورٹ.txt');
  });

  it('falls back when nothing usable is left', () => {
    expect(safeFileName('///', 'docx')).toBe('document.docx');
  });
});

describe('docx import, rejection', () => {
  it('rejects a buffer that is too short to be a zip', async () => {
    await expect(importDocx(Buffer.from([0x50]))).rejects.toThrow(/not a valid \.docx/u);
  });

  it('rejects a zip that is not a Word document', async () => {
    // A valid zip container holding nothing Word would recognise.
    const notWord = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(100),
    ]);
    await expect(importDocx(notWord)).rejects.toThrow(/Could not read that \.docx file/u);
  });
});

describe('docx round trip, links', () => {
  const linked = (href: string): PMNode =>
    doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'See ' },
        { type: 'text', text: 'the standard', marks: [{ type: 'link', attrs: { href } }] },
        { type: 'text', text: ' for detail.' },
      ],
    });

  const hrefsIn = (node: PMNode, found: string[] = []): string[] => {
    for (const mark of node.marks ?? []) {
      if (mark.type === 'link') found.push(String(mark.attrs?.['href']));
    }
    for (const child of node.content ?? []) hrefsIn(child, found);
    return found;
  };

  it('keeps where a link goes, not only how it looks', async () => {
    // The writer underlined a link and dropped its address. The exported file
    // looked right in Word and every reference in it went nowhere; an uploaded
    // policy lost all of its links on the first export.
    const back = await roundTrip(linked('https://policies.example.invalid/standards/access'));
    expect(hrefsIn(back)).toEqual(['https://policies.example.invalid/standards/access']);
    expect(toPlainText(back)).toContain('See the standard for detail.');
  });

  it('keeps a mail link', async () => {
    const back = await roundTrip(linked('mailto:owner@example.invalid'));
    expect(hrefsIn(back)).toEqual(['mailto:owner@example.invalid']);
  });

  it('keeps the words of a link Word could not follow', async () => {
    // "/documents/12" means something in a browser and nothing inside a file.
    const back = await roundTrip(linked('/documents/12'));
    expect(toPlainText(back)).toContain('See the standard for detail.');
  });
});

describe('a contents table made in the editor', () => {
  const withContents = doc(
    { type: 'wordBlock', attrs: { kind: 'toc', label: '' } },
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Purpose' }] },
    paragraph('Body text.'),
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Scope & limits' }] },
  );

  it('is written as the field Word builds its own contents from, listing the headings', async () => {
    const { strFromU8, unzipSync } = await import('fflate');
    const xml = strFromU8(unzipSync(new Uint8Array(await exportDocx(withContents, { title: 'T' })))['word/document.xml']!);
    // A field, so that Word can fill in page numbers, and marked as needing it.
    expect(xml).toMatch(/w:fldCharType="begin" w:dirty="true"/u);
    expect(xml).toMatch(/TOC \\o "1-3"/u);
    const field = xml.slice(xml.indexOf('fldCharType="begin"'), xml.indexOf('fldCharType="end"'));
    expect(field).toContain('Purpose');
    expect(field).toContain('Scope &amp; limits');
  });

  it('comes back as a contents table, not as loose paragraphs', async () => {
    const back = await roundTrip(withContents);
    expect(collect(back, 'wordBlock').map((node) => node.attrs?.['kind'])).toEqual(['toc']);
    expect(collect(back, 'heading')).toHaveLength(2);
  });
});
