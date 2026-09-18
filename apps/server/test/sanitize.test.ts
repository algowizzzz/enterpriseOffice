import { describe, expect, it } from 'vitest';
import { emptyDoc, sanitizeDocument, validateDoc, toPlainText, type PMNode } from '@docforge/model';

const repaired = (doc: unknown): PMNode => sanitizeDocument(doc as PMNode);
const valid = (doc: unknown): boolean => validateDoc(repaired(doc)).ok;

/**
 * Documents that are already valid. The repair runs on every document as it is
 * opened, so anything it changes here would be content quietly lost from
 * somebody's file.
 */
const UNTOUCHED: Record<string, PMNode> = {
  'an empty document': emptyDoc(),
  'headings at every level': {
    type: 'doc',
    content: [1, 2, 3, 4, 5, 6].map((level) => ({
      type: 'heading',
      attrs: { level },
      content: [{ type: 'text', text: `Level ${level}` }],
    })),
  },
  'every character mark': {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a', marks: [{ type: 'bold' }] },
          { type: 'text', text: 'b', marks: [{ type: 'italic' }] },
          { type: 'text', text: 'c', marks: [{ type: 'underline' }] },
          { type: 'text', text: 'd', marks: [{ type: 'strike' }] },
          { type: 'text', text: 'e', marks: [{ type: 'superscript' }] },
          { type: 'text', text: 'f', marks: [{ type: 'subscript' }] },
          { type: 'text', text: 'g', marks: [{ type: 'highlight' }] },
          {
            type: 'text',
            text: 'h',
            marks: [
              { type: 'textStyle', attrs: { fontFamily: 'Carlito', fontSize: '14pt', color: '#123456' } },
            ],
          },
          {
            type: 'text',
            text: 'i',
            marks: [
              { type: 'link', attrs: { href: 'https://intranet/page', target: '_blank', rel: 'noopener' } },
            ],
          },
        ],
      },
    ],
  },
  'lists, quotes and rules': {
    type: 'doc',
    content: [
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
        ],
      },
      {
        type: 'orderedList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
        ],
      },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }] },
      { type: 'horizontalRule' },
      { type: 'pageBreak' },
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] },
    ],
  },
  'a table with spans and widths': {
    type: 'doc',
    content: [
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableHeader',
                attrs: { colspan: 2, rowspan: 1, colwidth: [180, 240] },
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Region' }] }],
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
            ],
          },
        ],
      },
    ],
  },
  'an embedded image with its size': {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { textAlign: 'center' },
        content: [
          {
            type: 'image',
            attrs: { src: 'data:image/png;base64,AAAA', alt: 'A dot', title: null, width: 2, height: 2 },
          },
        ],
      },
    ],
  },
  'alignment on everything that takes it': {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { textAlign: 'justify' }, content: [{ type: 'text', text: 'j' }] },
      { type: 'heading', attrs: { level: 3, textAlign: 'right' }, content: [{ type: 'text', text: 'r' }] },
    ],
  },
  'attributes the rules do not know': {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { indent: 2, custom: 'note', flag: true }, content: [{ type: 'text', text: 'x' }] }],
  },
};

describe('a document that is already valid', () => {
  for (const [name, doc] of Object.entries(UNTOUCHED)) {
    it(`is returned unchanged: ${name}`, () => {
      expect(validateDoc(doc), name).toEqual({ ok: true, errors: [] });
      // Deep equality, not merely "still valid": the repair runs on open, so
      // anything it drops here is content lost from somebody's document.
      expect(sanitizeDocument(doc), name).toEqual(doc);
    });
  }

  it('changes nothing about a document that has been through it once', () => {
    for (const doc of Object.values(UNTOUCHED)) {
      const once = sanitizeDocument(doc);
      expect(sanitizeDocument(once)).toEqual(once);
    }
  });
});

describe('repairing a document', () => {
  it('leaves a document that is already valid alone', () => {
    const doc: PMNode = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'link',
              marks: [{ type: 'link', attrs: { href: 'https://intranet/page' } }],
            },
          ],
        },
      ],
    };
    expect(sanitizeDocument(doc)).toEqual(doc);
  });

  it('drops an image that points somewhere it may not', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Words stay' },
            { type: 'image', attrs: { src: 'https://example.com/a.png' } },
          ],
        },
      ],
    };
    expect(valid(doc)).toBe(true);
    expect(toPlainText(repaired(doc))).toBe('Words stay');
    expect(JSON.stringify(repaired(doc))).not.toContain('example.com');
  });

  it('drops an image with no source at all', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image' }] }] };
    expect(valid(doc)).toBe(true);
  });

  it('drops a hyperlink but keeps the words it was on', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'click here', marks: [{ type: 'link', attrs: { href: 'javascript:x' } }] },
          ],
        },
      ],
    };
    const result = repaired(doc);
    expect(validateDoc(result).ok).toBe(true);
    expect(toPlainText(result)).toBe('click here');
    expect(JSON.stringify(result)).not.toContain('javascript');
  });

  it('removes a bad optional attribute and keeps the node', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 99 }, content: [{ type: 'text', text: 'Title' }] }],
    };
    const result = repaired(doc);
    expect(validateDoc(result).ok).toBe(true);
    expect(result.content?.[0]?.type).toBe('heading');
    expect(result.content?.[0]?.attrs?.['level']).toBeUndefined();
    expect(toPlainText(result)).toBe('Title');
  });

  it('removes a span that would produce a broken file', () => {
    const doc = {
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
                  attrs: { colspan: 1000000000, rowspan: 1 },
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Wide' }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = repaired(doc);
    expect(validateDoc(result).ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('1000000000');
    expect(toPlainText(result)).toBe('Wide');
  });

  it('removes an unknown node and keeps its siblings', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
        { type: 'iframe', attrs: { src: 'http://x' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'Two' }] },
      ],
    };
    const result = repaired(doc);
    expect(validateDoc(result).ok).toBe(true);
    expect(toPlainText(result)).toBe('One\nTwo');
  });

  it('removes an unknown mark and keeps the text', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'onclick' }] }] },
      ],
    };
    const result = repaired(doc);
    expect(validateDoc(result).ok).toBe(true);
    expect(toPlainText(result)).toBe('x');
  });

  it('gives back an empty document when there is nothing usable left', () => {
    expect(sanitizeDocument({ type: 'iframe' })).toEqual(emptyDoc());
    expect(sanitizeDocument(null as unknown as PMNode)).toEqual(emptyDoc());
  });

  it('stops at a depth no real document reaches', () => {
    let node: PMNode = { type: 'paragraph' };
    for (let i = 0; i < 200; i += 1) node = { type: 'blockquote', content: [node] };
    const result = sanitizeDocument({ type: 'doc', content: [node] });
    expect(validateDoc(result).ok).toBe(true);
  });

  it('repairs anything validation would refuse', () => {
    // The two have to agree: whatever the rules reject, the repair must fix,
    // or a document becomes impossible to save.
    const hostile: unknown[] = [
      { type: 'doc', content: [{ type: 'paragraph', attrs: { textAlign: 'middle' } }] },
      { type: 'doc', content: [{ type: 'paragraph', attrs: { nested: { deep: true } } }] },
      { type: 'doc', content: [{ type: 'paragraph', attrs: { note: 'x'.repeat(9000) } }] },
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text' }] }] },
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'image', attrs: { src: 'data:image/png;base64,AAAA', width: 1e9 } }],
          },
        ],
      },
    ];
    for (const doc of hostile) {
      expect(validateDoc(doc).ok, JSON.stringify(doc).slice(0, 60)).toBe(false);
      const result = validateDoc(sanitizeDocument(doc as PMNode));
      expect(result.errors, JSON.stringify(doc).slice(0, 60)).toEqual([]);
    }
  });
});
