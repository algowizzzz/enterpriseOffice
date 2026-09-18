import { describe, expect, it } from 'vitest';
import {
  docFromParagraphs,
  emptyDoc,
  outline,
  toPlainText,
  validateDoc,
  wordCount,
} from '@docforge/model';
import { hashPassword, passwordProblems, verifyPassword } from '../src/lib/password.js';

describe('document model', () => {
  it('builds a valid empty document', () => {
    expect(validateDoc(emptyDoc()).ok).toBe(true);
  });

  it('counts words across blocks', () => {
    expect(wordCount(docFromParagraphs(['one two', 'three']))).toBe(3);
    expect(wordCount(emptyDoc())).toBe(0);
    expect(wordCount(docFromParagraphs(['  spaced   out  ']))).toBe(2);
  });

  it('extracts plain text with one line per block', () => {
    expect(toPlainText(docFromParagraphs(['first', 'second']))).toBe('first\nsecond');
  });

  it('gives every list item its own line', () => {
    // A list is one top-level block, so walking only the top level ran the
    // items together and the plain-text export read "AlphaBeta".
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: ['Alpha', 'Beta'].map((text) => ({
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
          })),
        },
      ],
    };
    expect(toPlainText(doc)).toBe('Alpha\nBeta');
  });

  it('gives every table cell its own line', () => {
    const cell = (text: string) => ({
      type: 'tableCell',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const doc = {
      type: 'doc',
      content: [{ type: 'table', content: [{ type: 'tableRow', content: [cell('One'), cell('Two')] }] }],
    };
    expect(toPlainText(doc)).toBe('One\nTwo');
  });

  it('breaks a line where the document does', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'first' },
            { type: 'hardBreak' },
            { type: 'text', text: 'second' },
          ],
        },
      ],
    };
    expect(toPlainText(doc)).toBe('first\nsecond');
  });

  it('reads the paragraphs inside a quote as separate lines', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Two' }] },
          ],
        },
      ],
    };
    expect(toPlainText(doc)).toBe('One\nTwo');
  });

  it('builds a heading outline', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Top' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Sub' }] },
      ],
    };
    expect(outline(doc)).toEqual([
      { level: 1, text: 'Top' },
      { level: 2, text: 'Sub' },
    ]);
  });

  it('rejects an unknown node type', () => {
    const result = validateDoc({ type: 'doc', content: [{ type: 'iframe' }] });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/unknown node type/u);
  });

  it('rejects an unknown mark', () => {
    const result = validateDoc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'onclick' }] }] },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a text node without text', () => {
    const result = validateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text' }] }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a root that is not a doc', () => {
    expect(validateDoc({ type: 'paragraph' }).ok).toBe(false);
  });

  it('rejects primitives and arrays', () => {
    expect(validateDoc(null).ok).toBe(false);
    expect(validateDoc('doc').ok).toBe(false);
    expect(validateDoc([]).ok).toBe(false);
  });

  it('rejects a document nested beyond the depth limit', () => {
    let node: Record<string, unknown> = { type: 'paragraph' };
    for (let i = 0; i < 150; i += 1) node = { type: 'blockquote', content: [node] };
    expect(validateDoc({ type: 'doc', content: [node] }).ok).toBe(false);
  });

  it('accepts a realistic document', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'paragraph',
          attrs: { textAlign: 'center' },
          content: [{ type: 'text', text: 'Bold', marks: [{ type: 'bold' }] }],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }],
            },
          ],
        },
        { type: 'horizontalRule' },
      ],
    };
    expect(validateDoc(doc)).toEqual({ ok: true, errors: [] });
  });
});

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const encoded = await hashPassword('Correct-Horse-9');
    expect(await verifyPassword('Correct-Horse-9', encoded)).toBe(true);
    expect(await verifyPassword('Wrong-Horse-9', encoded)).toBe(false);
  });

  it('produces a different hash each time', async () => {
    const a = await hashPassword('Correct-Horse-9');
    const b = await hashPassword('Correct-Horse-9');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
  });

  it('treats a malformed hash as a failed verification', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', 'scrypt$1$2$3$$')).toBe(false);
  });

  it('normalises unicode before hashing', async () => {
    const composed = 'Passwörd-Test-1';
    const decomposed = composed.normalize('NFD');
    const encoded = await hashPassword(composed);
    expect(await verifyPassword(decomposed, encoded)).toBe(true);
  });

  it('states every problem with a weak password', () => {
    expect(passwordProblems('short')).toHaveLength(3);
    expect(passwordProblems('Correct-Horse-9')).toEqual([]);
  });
});
