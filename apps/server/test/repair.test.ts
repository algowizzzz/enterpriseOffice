import { describe, expect, it } from 'vitest';
import {
  emptyDoc,
  repairDocument,
  sanitizeDocument,
  toPlainText,
  validateDoc,
  type PMNode,
} from '@docforge/model';

/**
 * The repair and the rules are two halves of one thing. Every document the
 * repair produces must pass the rules, and no document may be repaired into
 * something the editor shows as blank: that is silent data loss, which is worse
 * than the refusal it replaced.
 */
const repaired = (value: unknown): PMNode => sanitizeDocument(value);
const passes = (value: unknown): boolean => validateDoc(repaired(value)).ok;

describe('a node that cannot be empty', () => {
  it('keeps a paragraph when everything inside it was removed', () => {
    // Regression: an image with a remote source was the only thing in the
    // document. The repair removed it and left a document with no content at
    // all, which the editor opened as a blank page with nowhere to put the
    // cursor, and the first save wrote that blankness over the stored work.
    const doc = { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://x/y.png' } }] };
    const result = repaired(doc);
    expect(result.content).toEqual([{ type: 'paragraph' }]);
    expect(validateDoc(result)).toEqual({ ok: true, errors: [] });
  });

  it('does the same inside a quote, a list item and a table cell', () => {
    const bad = { type: 'image', attrs: { src: 'https://x/y.png' } };
    const cases: PMNode[] = [
      { type: 'doc', content: [{ type: 'blockquote', content: [bad] }] },
      {
        type: 'doc',
        content: [
          { type: 'bulletList', content: [{ type: 'listItem', content: [bad] }] },
        ],
      },
      {
        type: 'doc',
        content: [
          {
            type: 'table',
            content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [bad] }] }],
          },
        ],
      },
    ];
    for (const doc of cases) {
      const result = repaired(doc);
      expect(validateDoc(result).errors, JSON.stringify(result)).toEqual([]);
      expect(JSON.stringify(result)).toContain('paragraph');
    }
  });

  it('is refused by the rules as well, so the two cannot drift apart', () => {
    expect(validateDoc({ type: 'doc' }).ok).toBe(false);
    expect(validateDoc({ type: 'doc', content: [] }).ok).toBe(false);
    expect(validateDoc({ type: 'doc', content: [{ type: 'text', text: 'loose' }] }).ok).toBe(false);
  });

  it('drops a container that means nothing once it is empty', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] },
        { type: 'table', content: [{ type: 'tableRow', content: [] }] },
      ],
    };
    const result = repaired(doc);
    expect(JSON.stringify(result)).not.toContain('table');
    expect(toPlainText(result)).toBe('kept');
  });
});

describe('a document whose shape is wrong rather than its values', () => {
  it('does not throw when content or marks is not a list', () => {
    // Regression: this threw inside the editor's start-up, which took the whole
    // page down with no message and no way back to the document.
    const cases: unknown[] = [
      { type: 'doc', content: 'not a list' },
      { type: 'doc', content: [{ type: 'paragraph', content: { nope: true } }] },
      { type: 'doc', content: [{ type: 'paragraph', marks: 'bold' }] },
      { type: 'doc', content: [{ type: 'paragraph', content: [null, 7, 'x'] }] },
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a', marks: [null] }] }] },
    ];
    for (const value of cases) {
      expect(() => repaired(value), JSON.stringify(value)).not.toThrow();
      expect(passes(value), JSON.stringify(value)).toBe(true);
    }
  });

  it('forces a document root', () => {
    expect(repaired({ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] })).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    });
    expect(repaired({ type: 'text', text: 'hello' })).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    });
  });

  it('never leaves children on a text node', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a', content: [{ type: 'text', text: 'b' }] }] },
      ],
    };
    expect(JSON.stringify(repaired(doc))).not.toContain('"content":[{"type":"text","text":"b"');
    expect(passes(doc)).toBe(true);
  });

  it('keeps the words when the value is too broken to walk', () => {
    // Nothing here is a node the editor knows, but somebody wrote those words.
    const junk = {
      type: 'unknown-thing',
      content: [{ type: 'also-unknown', content: [{ text: 'do not lose this' }] }],
    };
    const result = repaired(junk);
    expect(validateDoc(result)).toEqual({ ok: true, errors: [] });
    expect(toPlainText(result)).toContain('do not lose this');
  });

  it('falls back to a blank document only when there is nothing to keep', () => {
    expect(repaired(null)).toEqual(emptyDoc());
    expect(repaired([])).toEqual(emptyDoc());
    expect(repaired('a string')).toEqual(emptyDoc());
  });
});

describe('an attribute a node cannot do without', () => {
  it('is kept even when the node carries more attributes than are allowed', () => {
    // Regression: the list was truncated before the required attribute was
    // read, so an image with many attributes lost its source and became
    // unrepairable although it had one all along.
    const attrs: Record<string, unknown> = { src: 'data:image/png;base64,AAAA' };
    for (let i = 0; i < 100; i += 1) attrs[`zz${i}`] = 'x';
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image', attrs }] }] };
    const result = repaired(doc);
    expect(JSON.stringify(result)).toContain('data:image/png');
    expect(validateDoc(result)).toEqual({ ok: true, errors: [] });
  });
});

describe('a document larger than the model will store', () => {
  it('is cut to the budget rather than repaired into another unsavable one', () => {
    const content = Array.from({ length: 600_000 }, () => ({ type: 'paragraph' }));
    const result = repaired({ type: 'doc', content });
    expect(validateDoc(result)).toEqual({ ok: true, errors: [] });
    expect(result.content?.length).toBeLessThan(600_000);
  });

  it('counts the paragraphs it adds against the same budget', () => {
    // Regression: a substituted paragraph was free, so a document just over the
    // limit was repaired into one still over it, and every save was refused
    // with a message about the document's size and no way to act on it.
    const content = Array.from({ length: 500_100 }, () => ({ type: 'listItem' }));
    const result = repaired({ type: 'doc', content: [{ type: 'bulletList', content }] });
    expect(validateDoc(result)).toEqual({ ok: true, errors: [] });
  });
});

describe('what the repair reports', () => {
  it('says nothing changed when nothing needed to', () => {
    const doc: PMNode = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Body', marks: [{ type: 'bold' }] }],
        },
      ],
    };
    expect(repairDocument(doc)).toEqual({ doc, changed: false, removed: false });
  });

  it('says something changed when it removed anything', () => {
    const result = repairDocument({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { src: 'https://x/y.png' } }] }],
    });
    expect(result.changed).toBe(true);
    expect(result.removed).toBe(true);
  });

  it('does not claim content was left out when it only filled a gap', () => {
    // Regression: putting a paragraph into an empty quote is not a loss, and
    // saying content had been removed was simply untrue.
    const result = repairDocument({
      type: 'doc',
      content: [{ type: 'blockquote', content: [] }],
    });
    expect(result.changed).toBe(true);
    expect(result.removed).toBe(false);
  });

  it('agrees with the rules about a container that cannot be empty', () => {
    // Regression: the repair dropped an empty table while the rules accepted
    // one, so opening a valid document removed the table and said so.
    for (const type of ['bulletList', 'orderedList', 'table', 'tableRow']) {
      const doc = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }, { type }],
      };
      expect(validateDoc(doc).ok, type).toBe(false);
      expect(repairDocument(doc).removed, type).toBe(true);
    }
  });

  it('keeps text as deep as the rules allow', () => {
    // Regression: the repair stopped one level earlier than the rules, so the
    // innermost line of a deeply nested document was removed although it could
    // have been stored.
    const build = (levels: number): PMNode => {
      let node: PMNode = { type: 'paragraph', content: [{ type: 'text', text: 'the deepest line' }] };
      for (let i = 0; i < levels; i += 1) node = { type: 'blockquote', content: [node] };
      return { type: 'doc', content: [node] };
    };
    for (const levels of [96, 97, 98]) {
      const doc = build(levels);
      if (!validateDoc(doc).ok) continue;
      const result = repairDocument(doc);
      expect(toPlainText(result.doc), `${levels} levels`).toContain('the deepest line');
      expect(result.changed, `${levels} levels`).toBe(false);
    }
  });
});

/**
 * The property that matters, checked against documents nobody thought to write
 * by hand: whatever goes in, the repair returns without throwing, and what
 * comes out satisfies the rules. Three separate outages came from a rule and a
 * repair that disagreed about one shape, so the agreement is checked as a
 * property rather than case by case.
 */
describe('the repair against arbitrary rubbish', () => {
  const PIECES: unknown[] = [
    'text',
    7,
    null,
    undefined,
    true,
    [],
    {},
    { type: 'text' },
    { type: 'text', text: 'word' },
    { type: 'text', text: '' },
    { type: 'paragraph' },
    { type: 'paragraph', content: 'oops' },
    { type: 'heading', attrs: { level: 99 } },
    { type: 'heading', attrs: null },
    { type: 'image' },
    { type: 'image', attrs: { src: 'https://example.com/a.png' } },
    { type: 'image', attrs: { src: 'data:image/png;base64,AAAA', width: '100%' } },
    { type: 'bulletList', content: [] },
    { type: 'listItem' },
    { type: 'table', content: [{ type: 'tableRow' }] },
    { type: 'tableCell', attrs: { colspan: -1 } },
    { type: 'blockquote' },
    { type: 'not-a-node' },
    { type: 'hardBreak', marks: 'bold' },
    { type: 'text', text: 'x', marks: [{ type: 'link' }] },
    { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
    { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: '/ok' } }] },
  ];

  // A fixed sequence, so a failure can be reproduced from the seed alone.
  let seed = 20260918;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;

  const grow = (depth: number): unknown => {
    const piece = pick(PIECES);
    if (depth > 4 || typeof piece !== 'object' || piece === null || Array.isArray(piece)) {
      return piece;
    }
    const children = Array.from({ length: Math.floor(next() * 3) }, () => grow(depth + 1));
    return children.length > 0 ? { ...piece, content: children } : piece;
  };

  it('always returns a document that satisfies the rules', () => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const value = { type: 'doc', content: Array.from({ length: 4 }, () => grow(0)) };
      let result: PMNode;
      try {
        result = sanitizeDocument(value);
      } catch (error) {
        throw new Error(`threw on ${JSON.stringify(value)}: ${String(error)}`);
      }
      const check = validateDoc(result);
      expect(check.errors, `${JSON.stringify(value)} -> ${JSON.stringify(result)}`).toEqual([]);
    }
  });

  it('is settled after one pass, so saving twice cannot keep changing a document', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = { type: 'doc', content: Array.from({ length: 3 }, () => grow(0)) };
      const once = sanitizeDocument(value);
      expect(repairDocument(once)).toEqual({ doc: once, changed: false, removed: false });
    }
  });
});
