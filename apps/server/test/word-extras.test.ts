import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { toPlainText, type PMNode } from '@docforge/model';
import { exportDocx } from '../src/docx/export.js';
import { importDocx } from '../src/docx/import.js';
import { docxFixture, p } from './docxFixture.js';

const collect = (node: PMNode, type: string, found: PMNode[] = []): PMNode[] => {
  if (node.type === type) found.push(node);
  for (const inner of node.content ?? []) collect(inner, type, found);
  return found;
};

/** Add a part to a fixture, which the fixture builder has no option for. */
const withPart = (file: Buffer, name: string, xml: string): Buffer => {
  const parts = unzipSync(new Uint8Array(file));
  parts[name] = strToU8(xml);
  return Buffer.from(zipSync(parts));
};

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

describe('footnotes', () => {
  const body =
    '<w:p><w:r><w:t>Records are kept</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="2"/></w:r><w:r><w:t> for ten years.</w:t></w:r></w:p>';
  const footnotes = `<?xml version="1.0"?><w:footnotes ${W}><w:footnote w:type="separator" w:id="0"><w:p/></w:footnote><w:footnote w:id="2"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Records includes paper and electronic media.</w:t></w:r></w:p></w:footnote></w:footnotes>`;
  const file = withPart(docxFixture({ body }), 'word/footnotes.xml', footnotes);

  it('are numbered as a reader sees them and can be read where they are marked', async () => {
    // The mark used to show the file's internal id, "2", for the first note,
    // and the words of the note could not be read anywhere.
    const { content } = await importDocx(file);
    const [mark] = collect(content, 'wordInline');
    expect(mark?.attrs).toMatchObject({ kind: 'footnote', label: '1', note: 'Records includes paper and electronic media.' });
    expect(toPlainText(content)).toBe('Records are kept for ten years.');
  });

  it('leave with the mark and the note they arrived with', async () => {
    const imported = await importDocx(file);
    const parts = unzipSync(new Uint8Array(await exportDocx(imported.content, { title: 'T', source: file, fragments: imported.fragments })));
    expect(strFromU8(parts['word/document.xml']!)).toContain('<w:footnoteReference w:id="2"/>');
    expect(strFromU8(parts['word/footnotes.xml']!)).toBe(footnotes);
  });
});

describe('form controls', () => {
  const dropdown =
    '<w:p><w:r><w:t xml:space="preserve">Classification: </w:t></w:r><w:sdt><w:sdtPr><w:alias w:val="Classification"/><w:dropDownList><w:listItem w:displayText="Internal" w:value="int"/><w:listItem w:displayText="Public" w:value="pub"/></w:dropDownList></w:sdtPr><w:sdtContent><w:r><w:t>Internal</w:t></w:r></w:sdtContent></w:sdt></w:p>';
  const plain =
    '<w:p><w:sdt><w:sdtPr><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Owner name here</w:t></w:r></w:sdtContent></w:sdt></w:p>';

  it('keeps a drop-down as a drop-down, showing what is chosen', async () => {
    // Read as its text, a form came back from an export with its controls
    // taken out: the choices were gone and so was the list they came from.
    const file = docxFixture({ body: dropdown });
    const imported = await importDocx(file);
    expect(collect(imported.content, 'wordInline')[0]?.attrs).toMatchObject({ kind: 'control', label: 'Internal' });
    const xml = strFromU8(
      unzipSync(new Uint8Array(await exportDocx(imported.content, { title: 'T', source: file, fragments: imported.fragments })))['word/document.xml']!,
    );
    expect(xml).toContain('<w:dropDownList>');
    expect(xml).toContain('w:displayText="Public"');
  });

  it('reads a box of text as text, so that it can be typed into', async () => {
    const { content } = await importDocx(docxFixture({ body: plain }));
    expect(collect(content, 'wordInline')).toHaveLength(0);
    expect(toPlainText(content)).toBe('Owner name here');
  });
});

describe('a file that cannot be opened', () => {
  it('says so in terms somebody can act on when it is password protected or an old .doc', async () => {
    const sealed = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
    await expect(importDocx(sealed)).rejects.toThrow(/password|\.doc format/u);
  });

  it('still says what it always said about something that is not a Word file at all', async () => {
    await expect(importDocx(Buffer.from('plain text'))).rejects.toThrow(/not a valid \.docx/u);
    expect(p('x')).toContain('x');
  });
});
