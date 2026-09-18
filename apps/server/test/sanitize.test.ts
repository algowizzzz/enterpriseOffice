import { describe, expect, it } from 'vitest';
import { emptyDoc, sanitizeDocument, validateDoc, toPlainText, type PMNode } from '@docforge/model';

const repaired = (doc: unknown): PMNode => sanitizeDocument(doc as PMNode);
const valid = (doc: unknown): boolean => validateDoc(repaired(doc)).ok;

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
