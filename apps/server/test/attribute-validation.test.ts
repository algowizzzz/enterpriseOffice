import { describe, expect, it } from 'vitest';
import { validateDoc, type PMNode } from '@docforge/model';

const wrap = (node: PMNode): unknown => ({ type: 'doc', content: [node] });
const ok = (node: PMNode): boolean => validateDoc(wrap(node)).ok;

const textWithMark = (type: string, attrs: Record<string, unknown>): PMNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text: 'x', marks: [{ type, attrs }] }],
});

describe('node attributes', () => {
  it('accepts a heading level the editor can produce', () => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(ok({ type: 'heading', attrs: { level } }), `level ${level}`).toBe(true);
    }
  });

  it('refuses a heading level that is not one', () => {
    for (const level of [0, 7, -1, 1.5, '2', null, NaN]) {
      expect(ok({ type: 'heading', attrs: { level } }), JSON.stringify(level)).toBe(false);
    }
  });

  it('accepts the four alignments and nothing else', () => {
    for (const textAlign of ['left', 'center', 'right', 'justify', null]) {
      expect(ok({ type: 'paragraph', attrs: { textAlign } }), String(textAlign)).toBe(true);
    }
    for (const textAlign of ['middle', 'start', 1, {}]) {
      expect(ok({ type: 'paragraph', attrs: { textAlign } }), JSON.stringify(textAlign)).toBe(false);
    }
  });

  it('refuses a span that would produce a file Word cannot open', () => {
    // Stored content can come from a client that is not the editor, and the
    // value goes straight into the serializer.
    const cell = (attrs: Record<string, unknown>): PMNode => ({
      type: 'table',
      content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs }] }],
    });
    expect(ok(cell({ colspan: 1, rowspan: 1 }))).toBe(true);
    expect(ok(cell({ colspan: 1000, rowspan: 1000 }))).toBe(true);
    expect(ok(cell({ colspan: 1000000000 }))).toBe(false);
    expect(ok(cell({ rowspan: 0 }))).toBe(false);
    expect(ok(cell({ colspan: -5 }))).toBe(false);
    expect(ok(cell({ colspan: 'many' }))).toBe(false);
  });

  it('accepts the column widths the editor stores', () => {
    const cell = (colwidth: unknown): PMNode => ({
      type: 'table',
      content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colwidth } }] }],
    });
    expect(ok(cell(null))).toBe(true);
    expect(ok(cell([120, 240]))).toBe(true);
    expect(ok(cell(['wide']))).toBe(false);
    expect(ok(cell(new Array(500).fill(10)))).toBe(false);
  });

  it('refuses an image size that is not a sensible number of pixels', () => {
    const image = (attrs: Record<string, unknown>): PMNode => ({
      type: 'paragraph',
      content: [{ type: 'image', attrs: { src: 'data:image/png;base64,AAAA', ...attrs } }],
    });
    expect(ok(image({ width: 640, height: 480 }))).toBe(true);
    expect(ok(image({ width: null, height: null }))).toBe(true);
    expect(ok(image({ width: 0 }))).toBe(false);
    expect(ok(image({ height: 1e9 }))).toBe(false);
    expect(ok(image({ width: 12.5 }))).toBe(false);
  });

  it('refuses an attribute that carries a structure', () => {
    expect(ok({ type: 'paragraph', attrs: { anything: { nested: true } } })).toBe(false);
    expect(ok({ type: 'paragraph', attrs: { anything: ['a', 'b'] } })).toBe(false);
  });

  it('accepts an attribute it does not know, when the value is plain', () => {
    // Extensions add attributes of their own; refusing an unknown name would
    // break a document for no gain.
    expect(ok({ type: 'paragraph', attrs: { indent: 2, custom: 'note', flag: true } })).toBe(true);
  });

  it('refuses an attribute value long enough to be a problem on its own', () => {
    expect(ok({ type: 'paragraph', attrs: { note: 'x'.repeat(5000) } })).toBe(false);
    expect(ok({ type: 'paragraph', attrs: { note: 'x'.repeat(100) } })).toBe(true);
  });

  it('refuses attrs that are not an object', () => {
    expect(validateDoc({ type: 'doc', content: [{ type: 'paragraph', attrs: 'nope' }] }).ok).toBe(false);
    expect(validateDoc({ type: 'doc', content: [{ type: 'paragraph', attrs: [1, 2] }] }).ok).toBe(false);
  });

  it('refuses a node carrying an absurd number of attributes', () => {
    const attrs: Record<string, number> = {};
    for (let i = 0; i < 100; i += 1) attrs[`a${i}`] = i;
    expect(ok({ type: 'paragraph', attrs })).toBe(false);
  });
});

describe('mark attributes', () => {
  it('accepts a link target that cannot execute anything', () => {
    for (const href of ['https://intranet/page', 'http://intranet', 'mailto:a@b', '#anchor', '/local']) {
      expect(ok(textWithMark('link', { href })), href).toBe(true);
    }
  });

  it('refuses a link target that could run script', () => {
    // The editor restricts what can be typed, but stored content can come from
    // an uploaded file or from a client that is not the editor.
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,<script>',
      'vbscript:x',
      'file:///etc/passwd',
      'JAVASCRIPT:alert(1)',
    ]) {
      expect(ok(textWithMark('link', { href })), href).toBe(false);
    }
  });

  it('refuses a link with no target or a target that is not text', () => {
    expect(ok(textWithMark('link', {}))).toBe(false);
    expect(ok(textWithMark('link', { href: null }))).toBe(false);
    expect(ok(textWithMark('link', { href: 42 }))).toBe(false);
  });

  it('accepts the other attributes a link carries', () => {
    expect(
      ok(
        textWithMark('link', {
          href: 'https://intranet/page',
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
          class: null,
        }),
      ),
    ).toBe(true);
  });

  it('accepts the text style attributes the ribbon sets', () => {
    expect(
      ok(
        textWithMark('textStyle', {
          fontFamily: '"Liberation Serif", serif',
          fontSize: '18pt',
          color: '#cc0000',
        }),
      ),
    ).toBe(true);
  });

  it('refuses a mark attribute that carries a structure', () => {
    expect(ok(textWithMark('highlight', { color: { r: 1 } }))).toBe(false);
  });
});

describe('what the rules do not break', () => {
  it('still accepts a realistic document', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1, textAlign: 'center' }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'paragraph',
          attrs: { textAlign: 'justify' },
          content: [
            { type: 'text', text: 'See ' },
            {
              type: 'text',
              text: 'the handbook',
              marks: [{ type: 'link', attrs: { href: 'https://intranet/handbook', target: '_blank' } }],
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
                  attrs: { colspan: 1, rowspan: 1, colwidth: [180] },
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Region' }] }],
                },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'image', attrs: { src: 'data:image/png;base64,AAAA', alt: 'A dot', width: 2, height: 2 } },
          ],
        },
      ],
    };
    expect(validateDoc(doc)).toEqual({ ok: true, errors: [] });
  });
});
