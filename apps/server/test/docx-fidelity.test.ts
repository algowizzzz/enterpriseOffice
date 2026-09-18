import { describe, expect, it } from 'vitest';
import { toPlainText, type PMNode } from '@docforge/model';
import { exportDocx } from '../src/docx/export.js';
import { htmlToDocument, importDocx } from '../src/docx/import.js';
import { measureImage } from '../src/docx/imageSize.js';

function collect(node: PMNode, type: string, found: PMNode[] = []): PMNode[] {
  if (node.type === type) found.push(node);
  for (const child of node.content ?? []) collect(child, type, found);
  return found;
}

const roundTrip = async (doc: PMNode): Promise<PMNode> =>
  (await importDocx(await exportDocx(doc, { title: 'Fidelity' }))).content;

const para = (text: string): PMNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

const listOf = (...items: string[]): PMNode => ({
  type: 'bulletList',
  content: items.map((text) => ({ type: 'listItem', content: [para(text)] })),
});

/** A two-by-two red PNG, which has a readable header and real dimensions. */
const PNG_2x2 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFUlEQVR4nGP8z4AATAxQxhBjAgIAIVwBBb6BFR0AAAAASUVORK5CYII=';
const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const GIF_1x1 = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

describe('a table inside a table', () => {
  it('does not duplicate the rows of the inner table', () => {
    // Regression: asking the parser for every `tr` beneath the outer table
    // pulled the inner table's rows up into it, and the cell holding the inner
    // table converted them a second time.
    const doc = htmlToDocument(
      '<table><tr><td>outer<table><tr><td>inner</td></tr></table></td></tr></table>',
    ).content;

    const tables = collect(doc, 'table');
    expect(tables).toHaveLength(2);
    expect(tables[0]?.content).toHaveLength(1);
    expect(toPlainText(doc).match(/inner/gu)).toHaveLength(1);
  });

  it('reads rows through a table body', () => {
    const doc = htmlToDocument(
      '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>A</td></tr><tr><td>B</td></tr></tbody></table>',
    ).content;
    const table = collect(doc, 'table')[0];
    expect(table?.content).toHaveLength(3);
    expect(collect(doc, 'tableHeader')).toHaveLength(1);
  });

  it('ignores a row that belongs to a nested table when counting the outer one', () => {
    const doc = htmlToDocument(
      '<table><tbody><tr><td><table><tbody><tr><td>x</td></tr><tr><td>y</td></tr></tbody></table></td></tr></tbody></table>',
    ).content;
    expect(collect(doc, 'table')[0]?.content).toHaveLength(1);
  });
});

describe('blocks inside a quote', () => {
  it('keeps a quoted list as a list', async () => {
    // Regression: every child of a quote was mapped through the paragraph path,
    // so a quoted list came back as one run-on line with no bullets.
    const source: PMNode = {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [para('Quoted intro'), listOf('Alpha', 'Beta')],
        },
      ],
    };
    const result = await roundTrip(source);
    expect(collect(result, 'bulletList')).toHaveLength(1);
    expect(collect(result, 'listItem')).toHaveLength(2);
    const text = toPlainText(result);
    expect(text).toContain('Alpha');
    expect(text).toContain('Beta');
    expect(text).not.toContain('AlphaBeta');
  });

  it('keeps a quoted table as a table', async () => {
    const cell = (text: string): PMNode => ({
      type: 'tableCell',
      attrs: { colspan: 1, rowspan: 1, colwidth: null },
      content: [para(text)],
    });
    const source: PMNode = {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [
            { type: 'table', content: [{ type: 'tableRow', content: [cell('One'), cell('Two')] }] },
          ],
        },
      ],
    };
    const result = await roundTrip(source);
    expect(collect(result, 'table')).toHaveLength(1);
    expect(collect(result, 'tableCell')).toHaveLength(2);
  });

  it('keeps a quoted heading as a heading', async () => {
    const source: PMNode = {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [
            { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Quoted title' }] },
            para('Body of the quote'),
          ],
        },
      ],
    };
    const result = await roundTrip(source);
    const headings = collect(result, 'heading');
    expect(headings).toHaveLength(1);
    expect(headings[0]?.attrs?.['level']).toBe(3);
  });

  it('writes a document with a quote nested inside a quote', async () => {
    const source: PMNode = {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [
            para('Outer'),
            { type: 'blockquote', content: [para('Inner')] },
          ],
        },
      ],
    };
    const text = toPlainText(await roundTrip(source));
    expect(text).toContain('Outer');
    expect(text).toContain('Inner');
  });
});

describe('image dimensions', () => {
  it('reads the size of a PNG', () => {
    expect(measureImage(PNG_2x2)).toEqual({ width: 2, height: 2 });
    expect(measureImage(PNG_1x1)).toEqual({ width: 1, height: 1 });
  });

  it('reads the size of a GIF', () => {
    expect(measureImage(GIF_1x1)).toEqual({ width: 1, height: 1 });
  });

  it('returns nothing for something that is not an image it can read', () => {
    expect(measureImage('data:image/png;base64,')).toBeNull();
    expect(measureImage('data:image/png;base64,bm90YXBuZw==')).toBeNull();
    expect(measureImage('https://example.com/a.png')).toBeNull();
    expect(measureImage('data:image/x-emf;base64,AAAA')).toBeNull();
    expect(measureImage('not a uri at all')).toBeNull();
  });

  it('carries the real size through an import', () => {
    const doc = htmlToDocument(`<p><img src="${PNG_2x2}" /></p>`).content;
    const image = collect(doc, 'image')[0];
    expect(image?.attrs).toMatchObject({ width: 2, height: 2 });
  });

  it('keeps the size through a full round trip', async () => {
    const source: PMNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { src: PNG_2x2 } }] }],
    };
    const image = collect(await roundTrip(source), 'image')[0];
    expect(image?.attrs).toMatchObject({ width: 2, height: 2 });
  });
});

describe('images in formats Word cannot be given back', () => {
  it('refuses one on import, and says why', () => {
    // Word files often carry EMF, WMF or TIFF pictures. Accepting one and then
    // dropping it silently on export is worse than refusing it with a reason.
    const result = htmlToDocument('<p>Text stays<img src="data:image/x-emf;base64,AAAA" /></p>');
    expect(collect(result.content, 'image')).toHaveLength(0);
    expect(result.messages.join(' ')).toMatch(/cannot be saved back to Word/u);
    expect(toPlainText(result.content)).toContain('Text stays');
  });

  it('accepts each format it can write back', () => {
    for (const src of [PNG_1x1, GIF_1x1]) {
      const result = htmlToDocument(`<p><img src="${src}" /></p>`);
      expect(collect(result.content, 'image'), src.slice(0, 20)).toHaveLength(1);
      expect(result.messages).toEqual([]);
    }
  });
});

describe('spans that would produce a broken file', () => {
  it('ignores an implausible column span rather than writing it out', async () => {
    const source: PMNode = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 1000000000, rowspan: 1, colwidth: null },
                  content: [para('Wide')],
                },
              ],
            },
          ],
        },
      ],
    };
    const buffer = await exportDocx(source, { title: 'Spans' });
    expect(buffer.toString('latin1')).not.toContain('1000000000');

    const result = await importDocx(buffer);
    expect(toPlainText(result.content)).toContain('Wide');
  });

  it('ignores a span that is not a number', async () => {
    const source: PMNode = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 'lots', rowspan: -3, colwidth: null },
                  content: [para('Odd')],
                },
              ],
            },
          ],
        },
      ],
    };
    const text = toPlainText(await roundTrip(source));
    expect(text).toContain('Odd');
  });
});

describe('deeply nested numbered lists', () => {
  it('defines a numbering level for every depth the editor can reach', async () => {
    let list: PMNode = {
      type: 'orderedList',
      content: [{ type: 'listItem', content: [para('Deepest')] }],
    };
    for (let depth = 0; depth < 7; depth += 1) {
      list = {
        type: 'orderedList',
        content: [{ type: 'listItem', content: [para(`Level ${7 - depth}`), list] }],
      };
    }
    const text = toPlainText(await roundTrip({ type: 'doc', content: [list] }));
    expect(text).toContain('Deepest');
  });
});
