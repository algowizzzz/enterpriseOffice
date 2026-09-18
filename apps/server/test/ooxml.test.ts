import { describe, expect, it } from 'vitest';
import { parseXml, child, descendants, textOf } from '../src/docx/ooxml/xml.js';
import { exportDocx } from '../src/docx/export.js';
import { importDocx } from '../src/docx/import.js';
import type { PMNode } from '@docforge/model';

/** A document that has been through the exporter and back. */
async function roundTrip(
  doc: PMNode,
  pageSetup?: { header: string; footer: string; orientation: 'portrait' | 'landscape' },
): Promise<Awaited<ReturnType<typeof importDocx>>> {
  const buffer = await exportDocx(doc, { title: 'Round trip', ...(pageSetup ? { pageSetup } : {}) });
  return importDocx(Buffer.from(buffer));
}

const para = (text: string, attrs?: Record<string, unknown>): PMNode => ({
  type: 'paragraph',
  ...(attrs ? { attrs } : {}),
  content: [{ type: 'text', text }],
});

describe('the XML reader', () => {
  it('reads elements, attributes, text and entities', () => {
    const root = parseXml('<?xml version="1.0"?><w:p w:id="3"><w:t>a &amp; b &#65;</w:t></w:p>');
    expect(root.name).toBe('w:p');
    expect(root.attrs['w:id']).toBe('3');
    expect(textOf(root)).toBe('a & b A');
  });

  it('reads a self-closing element and a comment', () => {
    const root = parseXml('<a><!-- note --><b/><c x="1"/></a>');
    expect(descendants(root, 'b')).toHaveLength(1);
    expect(child(root, 'c')?.attrs['x']).toBe('1');
  });

  it('keeps markup inside CDATA as text', () => {
    expect(textOf(parseXml('<a><![CDATA[<b>not markup</b>]]></a>'))).toBe('<b>not markup</b>');
  });

  it('refuses markup it cannot make sense of', () => {
    expect(() => parseXml('<a><b></a>')).toThrow();
    expect(() => parseXml('<a>')).toThrow();
    expect(() => parseXml('nothing at all')).toThrow();
  });

  it('does not act on a doctype', () => {
    // This is where an XML reader is asked to fetch and expand things on behalf
    // of whoever wrote the file.
    const root = parseXml('<!DOCTYPE a SYSTEM "http://example.com/a.dtd"><a>text</a>');
    expect(textOf(root)).toBe('text');
  });

  it('refuses a document nested past any real depth', () => {
    expect(() => parseXml('<a>'.repeat(500) + '</a>'.repeat(500))).toThrow();
  });
});

describe('what a Word file keeps on the way through', () => {
  it('keeps the font, size and colour of a run', async () => {
    const doc: PMNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Set apart',
              marks: [
                { type: 'textStyle', attrs: { fontFamily: 'Georgia', fontSize: '14pt', color: '#c00000' } },
              ],
            },
          ],
        },
      ],
    };
    const back = await roundTrip(doc);
    const style = back.content.content?.[0]?.content?.[0]?.marks?.[0];
    expect(style?.type).toBe('textStyle');
    expect(style?.attrs?.['fontFamily']).toBe('Georgia');
    expect(style?.attrs?.['fontSize']).toBe('14pt');
    expect(style?.attrs?.['color']).toBe('#c00000');
  });

  it('keeps highlighting', async () => {
    const doc: PMNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Marked', marks: [{ type: 'highlight' }] }],
        },
      ],
    };
    const back = await roundTrip(doc);
    expect(JSON.stringify(back.content)).toContain('highlight');
  });

  it('keeps the size a picture is shown at, not the size of the picture', async () => {
    // A one-pixel image shown at 240 by 160 used to come back one pixel square,
    // because the importer measured the file instead of reading the markup.
    const src =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const doc: PMNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'image', attrs: { src, width: 240, height: 160 } }] },
      ],
    };
    const back = await roundTrip(doc);
    const image = back.content.content?.[0]?.content?.[0];
    expect(image?.type).toBe('image');
    expect(Number(image?.attrs?.['width'])).toBeGreaterThan(200);
    expect(Number(image?.attrs?.['height'])).toBeGreaterThan(130);
  });

  it('keeps the colour of a table cell', async () => {
    const doc: PMNode = {
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
                  attrs: { colspan: 1, rowspan: 1, colwidth: null, background: '#d9e2f3' },
                  content: [para('Shaded')],
                },
              ],
            },
          ],
        },
      ],
    };
    const back = await roundTrip(doc);
    const cell = back.content.content?.[0]?.content?.[0]?.content?.[0];
    expect(cell?.attrs?.['background']).toBe('#d9e2f3');
  });

  it('merges the column that was merged, not the one beside it', async () => {
    const doc: PMNode = {
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
                  attrs: { colspan: 1, rowspan: 2, colwidth: null },
                  content: [para('Down two rows')],
                },
                { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [para('B1')] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [para('B2')] },
              ],
            },
          ],
        },
      ],
    };
    const back = await roundTrip(doc);
    const rows = back.content.content?.[0]?.content ?? [];
    const first = rows[0]?.content?.[0];
    expect(first?.content?.[0]?.content?.[0]?.text).toBe('Down two rows');
    expect(first?.attrs?.['rowspan']).toBe(2);
    expect(rows[1]?.content).toHaveLength(1);
  });

  it('keeps a page break without adding a blank line', async () => {
    const doc: PMNode = {
      type: 'doc',
      content: [para('Page one'), { type: 'pageBreak' }, para('Page two')],
    };
    const back = await roundTrip(doc);
    expect(back.content.content?.map((node) => node.type)).toEqual([
      'paragraph',
      'pageBreak',
      'paragraph',
    ]);
  });

  it('keeps the header, the footer and the orientation', async () => {
    const setup = { header: 'Company handbook', footer: 'Confidential', orientation: 'landscape' as const };
    const back = await roundTrip({ type: 'doc', content: [para('Body')] }, setup);
    expect(back.meta).toEqual(setup);
  });

  it('keeps a quotation as a quotation', async () => {
    const doc: PMNode = {
      type: 'doc',
      content: [{ type: 'blockquote', content: [para('Somebody else wrote this.')] }],
    };
    const back = await roundTrip(doc);
    expect(back.content.content?.[0]?.type).toBe('blockquote');
  });

  it('keeps a rule', async () => {
    const back = await roundTrip({ type: 'doc', content: [para('Above'), { type: 'horizontalRule' }] });
    expect(back.content.content?.map((node) => node.type)).toContain('horizontalRule');
  });

  it('refuses a file that is not a Word file, with a message that says so', async () => {
    await expect(importDocx(Buffer.from('not a zip'))).rejects.toThrow(/not a valid \.docx/u);
  });
});

describe('page setup as a document keeps it', () => {
  it('is stored, returned and used when the file is written again', async () => {
    const { makeApp, registerFirstAdmin, authHeader } = await import('./helpers.js');
    const app = await makeApp();
    try {
      const admin = await registerFirstAdmin(app);
      const created = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: authHeader(admin),
        payload: { title: 'With a header', content: { type: 'doc', content: [para('Body')] } },
      });
      const id = created.json().document.id as string;
      expect(created.json().document.pageSetup).toEqual({
        header: '',
        footer: '',
        orientation: 'portrait',
      });

      const saved = await app.inject({
        method: 'PUT',
        url: `/api/documents/${id}`,
        headers: authHeader(admin),
        payload: {
          pageSetup: { header: 'Company handbook', footer: 'Confidential', orientation: 'landscape' },
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().document.pageSetup.header).toBe('Company handbook');

      const exported = await app.inject({
        method: 'GET',
        url: `/api/documents/${id}/export`,
        headers: authHeader(admin),
      });
      const back = await importDocx(Buffer.from(exported.rawPayload));
      expect(back.meta).toEqual({
        header: 'Company handbook',
        footer: 'Confidential',
        orientation: 'landscape',
      });
    } finally {
      await app.close();
    }
  });

  it('refuses a header that is not a line of text, rather than storing it', async () => {
    const { pageSetupFrom } = await import('@docforge/model');
    expect(pageSetupFrom({ header: 'a\nb\tc', orientation: 'sideways' })).toEqual({
      header: 'a b c',
      footer: '',
      orientation: 'portrait',
    });
    expect(pageSetupFrom(null)).toEqual({ header: '', footer: '', orientation: 'portrait' });
    expect(pageSetupFrom({ header: 'x'.repeat(500) }).header).toHaveLength(300);
  });

  it('keeps the page setup of an uploaded file', async () => {
    const { makeApp, registerFirstAdmin, authHeader } = await import('./helpers.js');
    const app = await makeApp();
    try {
      const admin = await registerFirstAdmin(app);
      const source = await exportDocx({ type: 'doc', content: [para('Body')] }, {
        title: 'Source',
        pageSetup: { header: 'From the file', footer: 'Page footer', orientation: 'landscape' },
      });
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(source)]), 'source.docx');
      const uploaded = await app.inject({
        method: 'POST',
        url: '/api/documents/import',
        headers: authHeader(admin),
        payload: form,
      });
      expect(uploaded.statusCode).toBe(201);
      expect(uploaded.json().document.pageSetup).toEqual({
        header: 'From the file',
        footer: 'Page footer',
        orientation: 'landscape',
      });
    } finally {
      await app.close();
    }
  });
});
