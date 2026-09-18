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

describe('filling in a form', () => {
  const W14 = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
  const documentXml = `<?xml version="1.0"?><w:document ${W} ${W14}><w:body><w:p>
    <w:sdt><w:sdtPr><w:alias w:val="Classification"/><w:tag w:val="cls"/><w:showingPlcHdr/><w:dropDownList><w:listItem w:displayText="Internal" w:value="int"/><w:listItem w:displayText="Public" w:value="pub"/></w:dropDownList></w:sdtPr><w:sdtContent><w:r><w:rPr><w:b/></w:rPr><w:t>Choose an item.</w:t></w:r></w:sdtContent></w:sdt>
    <w:sdt><w:sdtPr><w:date w:fullDate="2026-01-31T00:00:00Z"><w:dateFormat w:val="dd/MM/yyyy"/></w:date></w:sdtPr><w:sdtContent><w:r><w:t>31/01/2026</w:t></w:r></w:sdtContent></w:sdt>
    <w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="0"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>&#9744;</w:t></w:r></w:sdtContent></w:sdt>
  </w:p></w:body></w:document>`;
  const file = docxFixture({ documentXml });

  it('says what each control is, what it offers and what it holds', async () => {
    const { content } = await importDocx(file);
    const controls = collect(content, 'wordInline').map((node) => node.attrs);
    expect(controls[0]).toMatchObject({ controlType: 'dropdown', options: 'Internal\nPublic' });
    expect(controls[1]).toMatchObject({ controlType: 'date', value: '2026-01-31' });
    expect(controls[2]).toMatchObject({ controlType: 'checkbox', value: 'false' });
  });

  it('writes what was chosen into the control, and leaves the control a control', async () => {
    const imported = await importDocx(file);
    const fill = (node: PMNode): PMNode => {
      if (node.type === 'wordInline') {
        const next = { dropdown: 'Public', date: '2026-10-01', checkbox: 'true' }[String(node.attrs?.['controlType'])];
        return { ...node, attrs: { ...node.attrs, value: next } };
      }
      return node.content ? { ...node, content: node.content.map(fill) } : node;
    };
    const xml = strFromU8(
      unzipSync(new Uint8Array(await exportDocx(fill(imported.content), { title: 'T', source: file, fragments: imported.fragments })))['word/document.xml']!,
    );
    expect(xml).toMatch(/<w:tag w:val="cls"\/>.*<w:dropDownList>.*<w:t[^>]*>Public<\/w:t>/su);
    // Its formatting stays, and Word is no longer told it is showing a placeholder.
    expect(xml).toMatch(/<w:rPr><w:b\/><\/w:rPr><w:t[^>]*>Public/u);
    expect(xml).not.toContain('showingPlcHdr');
    expect(xml).toContain('w:fullDate="2026-10-01T00:00:00Z"');
    expect(xml).toContain('01/10/2026');
    expect(xml).toContain('<w14:checked w14:val="1"/>');
    expect(xml).toContain(String.fromCodePoint(0x2612));
  });

  it('will not put something into a drop-down that is not on its list', async () => {
    const imported = await importDocx(file);
    const forge = (node: PMNode): PMNode =>
      node.type === 'wordInline' && node.attrs?.['controlType'] === 'dropdown'
        ? { ...node, attrs: { ...node.attrs, value: 'Top secret' } }
        : node.content ? { ...node, content: node.content.map(forge) } : node;
    const xml = strFromU8(
      unzipSync(new Uint8Array(await exportDocx(forge(imported.content), { title: 'T', source: file, fragments: imported.fragments })))['word/document.xml']!,
    );
    expect(xml).not.toContain('Top secret');
  });
});

describe('editing and adding footnotes', () => {
  const body =
    '<w:p><w:r><w:t>Records are kept</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r><w:r><w:t> for ten years.</w:t></w:r></w:p>';
  const footnotes = `<?xml version="1.0"?><w:footnotes ${W}><w:footnote w:type="separator" w:id="0"><w:p/></w:footnote><w:footnote w:id="2"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve"> Includes paper and electronic media.</w:t></w:r></w:p></w:footnote></w:footnotes>`;
  const file = withPart(docxFixture({ body }), 'word/footnotes.xml', footnotes);
  const edit = (doc: PMNode, change: (node: PMNode) => PMNode): PMNode =>
    doc.type === 'wordInline' ? change(doc) : doc.content ? { ...doc, content: doc.content.map((inner) => edit(inner, change)) } : doc;

  it('leaves a note nobody touched exactly as it was, formatting and all', async () => {
    const imported = await importDocx(file);
    const parts = unzipSync(new Uint8Array(await exportDocx(imported.content, { title: 'T', source: file, fragments: imported.fragments })));
    expect(strFromU8(parts['word/footnotes.xml']!)).toBe(footnotes);
  });

  it('writes new wording into the note it belongs to', async () => {
    const imported = await importDocx(file);
    const changed = edit(imported.content, (node) => ({ ...node, attrs: { ...node.attrs, note: 'Includes recorded media too.' } }));
    const parts = unzipSync(new Uint8Array(await exportDocx(changed, { title: 'T', source: file, fragments: imported.fragments })));
    const notes = strFromU8(parts['word/footnotes.xml']!);
    expect(notes).toContain('Includes recorded media too.');
    expect(notes).not.toContain('paper and electronic');
    expect(notes).toContain('<w:footnoteRef/>');
    expect(strFromU8(parts['word/document.xml']!)).toContain('<w:footnoteReference w:id="2"/>');
  });

  it('adds a footnote made here to a file that had none, and reads it back', async () => {
    const made: PMNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Kept for ten years' },
            { type: 'wordInline', attrs: { kind: 'footnote', label: '', note: 'From the end of the financial year.' } },
            { type: 'text', text: '.' },
          ],
        },
      ],
    };
    const exported = await exportDocx(made, { title: 'T' });
    const parts = unzipSync(new Uint8Array(exported));
    expect(strFromU8(parts['word/footnotes.xml']!)).toContain('From the end of the financial year.');
    expect(strFromU8(parts['[Content_Types].xml']!)).toContain('footnotes+xml');
    const back = await importDocx(exported);
    expect(collect(back.content, 'wordInline')[0]?.attrs).toMatchObject({ kind: 'footnote', label: '1', note: 'From the end of the financial year.' });
  });
});
