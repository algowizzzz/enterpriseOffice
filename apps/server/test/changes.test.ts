import { describe, expect, it } from 'vitest';
import {
  CHANGE_NAMES,
  MARK,
  NODE,
  acceptAllChanges,
  compareDocuments,
  countChanges,
  rejectAllChanges,
  toPlainText,
  validateDoc,
  type PMNode,
} from '@docforge/model';

const p = (...content: (string | PMNode)[]): PMNode => ({
  type: 'paragraph',
  content: content.map((item) => (typeof item === 'string' ? { type: 'text', text: item } : item)),
});
const doc = (...content: PMNode[]): PMNode => ({ type: 'doc', content });
const who = { author: 'Rae Reviewer', date: '2026-09-18T10:00:00.000Z' };
const changed = (text: string, type: 'insertion' | 'deletion'): PMNode => ({
  type: 'text',
  text,
  marks: [{ type, attrs: who }],
});

describe('the names the change tracker uses', () => {
  it('are the names in the vocabulary', () => {
    // changes.ts states them again rather than importing them, to stay out of
    // an import cycle. This is what stops the two drifting apart.
    for (const [key, value] of Object.entries(CHANGE_NAMES.NODE)) expect(NODE[key as keyof typeof NODE]).toBe(value);
    for (const [key, value] of Object.entries(CHANGE_NAMES.MARK)) expect(MARK[key as keyof typeof MARK]).toBe(value);
  });
});

describe('settling tracked changes', () => {
  const tracked = doc(
    p('Records are kept for ', changed('seven', 'deletion'), changed('ten', 'insertion'), ' years.'),
    p(changed('A whole new paragraph.', 'insertion')),
    p(changed('A paragraph that was removed.', 'deletion')),
  );

  it('accepting keeps what was put in and drops what was taken out', () => {
    expect(toPlainText(acceptAllChanges(tracked))).toBe('Records are kept for ten years.\nA whole new paragraph.');
  });

  it('rejecting puts it back the way it was, without leaving an empty line where a paragraph was added', () => {
    expect(toPlainText(rejectAllChanges(tracked))).toBe('Records are kept for seven years.\nA paragraph that was removed.');
  });

  it('leaves no change marks behind either way, and a document that still saves', () => {
    for (const settled of [acceptAllChanges(tracked), rejectAllChanges(tracked)]) {
      expect(JSON.stringify(settled)).not.toMatch(/insertion|deletion/u);
      expect(validateDoc(settled).ok).toBe(true);
    }
  });

  it('never leaves a document, a cell or a list item empty', () => {
    const onlyAdded = doc(p(changed('Everything here was added.', 'insertion')));
    expect(validateDoc(rejectAllChanges(onlyAdded))).toEqual({ ok: true, errors: [] });
    const cell = doc({
      type: 'table',
      content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p(changed('gone', 'deletion'))] }] }],
    });
    expect(validateDoc(acceptAllChanges(cell))).toEqual({ ok: true, errors: [] });
  });

  it('counts a replacement as two changes and a run of one author as one', () => {
    expect(countChanges(tracked)).toBe(4);
  });
});

describe('comparing two versions', () => {
  const before = doc(
    p('Purpose'),
    p('Records are kept for seven years from the end of the financial year.'),
    p('This paragraph is removed in the new version.'),
    p('Unchanged closing paragraph.'),
  );
  const after = doc(
    p('Purpose'),
    p('Records are kept for ten years from the end of the financial year.'),
    p('Unchanged closing paragraph.'),
    p('This paragraph is new.'),
  );

  it('accepting everything in the redline gives the new version, rejecting gives the old', () => {
    const redline = compareDocuments(before, after, who);
    expect(toPlainText(acceptAllChanges(redline))).toBe(toPlainText(after));
    expect(toPlainText(rejectAllChanges(redline))).toBe(toPlainText(before));
  });

  it('marks one word, not the whole paragraph, when one word changed', () => {
    const redline = compareDocuments(before, after, who);
    const edited = redline.content?.[1]?.content ?? [];
    const marked = edited.filter((node) => (node.marks ?? []).length > 0).map((node) => `${node.marks?.[0]?.type}:${node.text}`);
    expect(marked).toEqual(['deletion:seven', 'insertion:ten']);
  });

  it('signs every change', () => {
    const redline = JSON.stringify(compareDocuments(before, after, who));
    expect(redline).toContain('"author":"Rae Reviewer"');
  });

  it('says nothing when nothing changed', () => {
    expect(countChanges(compareDocuments(before, before, who))).toBe(0);
  });

  it('keeps the formatting of the words on both sides', () => {
    const bold = (text: string): PMNode => ({ type: 'text', text, marks: [{ type: 'bold' }] });
    const redline = compareDocuments(doc(p('A ', bold('firm'), ' rule applies.')), doc(p('A ', bold('strict'), ' rule applies.')), who);
    const kinds = (redline.content?.[0]?.content ?? []).filter((n) => n.text === 'firm' || n.text === 'strict').map((n) => n.marks?.map((m) => m.type));
    expect(kinds).toEqual([['bold', 'deletion'], ['bold', 'insertion']]);
  });

  it('looks inside a table rather than replacing it for one changed cell', () => {
    const table = (value: string): PMNode => ({
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableCell', content: [p('Finance')] }, { type: 'tableCell', content: [p(value)] }] },
      ],
    });
    const redline = compareDocuments(doc(table('7 years')), doc(table('10 years')), who);
    expect(toPlainText(acceptAllChanges(redline))).toContain('10 years');
    expect(JSON.stringify(redline)).toContain('"text":"Finance"}');
    expect(countChanges(redline)).toBe(2);
  });

  it('produces a document the rules accept', () => {
    expect(validateDoc(compareDocuments(before, after, who))).toEqual({ ok: true, errors: [] });
  });

  it('copes with a long document changed in the middle', () => {
    const many = (mid: string): PMNode => doc(...Array.from({ length: 3000 }, (_, i) => p(i === 1500 ? mid : `Paragraph number ${i} of the policy.`)));
    const started = Date.now();
    const redline = compareDocuments(many('The middle says one thing.'), many('The middle says another thing.'), who);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(countChanges(redline)).toBe(2);
  });
});

describe('tracked changes through Word', () => {
  const tracked = doc(p('Kept for ', changed('seven', 'deletion'), changed('ten', 'insertion'), ' years.'));

  it('writes them as the revision marks Word shows in its margin', async () => {
    const { exportDocx } = await import('../src/docx/export.js');
    const { strFromU8, unzipSync } = await import('fflate');
    const xml = strFromU8(unzipSync(new Uint8Array(await exportDocx(tracked, { title: 'T' })))['word/document.xml']!);
    expect(xml).toMatch(/<w:del [^>]*w:author="Rae Reviewer"[^>]*>.*<w:delText[^>]*>seven<\/w:delText>.*<\/w:del>/su);
    expect(xml).toMatch(/<w:ins [^>]*w:author="Rae Reviewer"[^>]*>.*<w:t[^>]*>ten<\/w:t>.*<\/w:ins>/su);
    // Struck out, not shown twice: a deletion's text must not also be plain text.
    expect(xml).not.toMatch(/<w:t[^>]*>seven<\/w:t>/u);
  });

  it('reads them back as the same changes by the same person', async () => {
    const { exportDocx } = await import('../src/docx/export.js');
    const { importDocx } = await import('../src/docx/import.js');
    const back = await importDocx(await exportDocx(tracked, { title: 'T' }));
    // Reviewers' decisions are theirs. Reading an insertion as accepted and
    // dropping a deletion made every one of them on the reviewer's behalf.
    expect(toPlainText(rejectAllChanges(back.content))).toBe('Kept for seven years.');
    expect(toPlainText(acceptAllChanges(back.content))).toBe('Kept for ten years.');
    expect(JSON.stringify(back.content)).toContain('"author":"Rae Reviewer"');
  });
});
