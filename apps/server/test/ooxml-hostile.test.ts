import { describe, expect, it } from 'vitest';
import { toPlainText } from '@docforge/model';
import { importDocx } from '../src/docx/import.js';
import { docxFixture, drawing, p, PNG_BYTES } from './docxFixture.js';

/**
 * The reader takes a file somebody uploaded, so everything here is written the
 * way a hostile or merely unusual file would be written, not the way this
 * product writes one.
 */
const read = (parts: Parameters<typeof docxFixture>[0]) => importDocx(docxFixture(parts));

describe('markup nested beyond any sensible depth', () => {
  it('is refused with a message rather than overflowing the stack', async () => {
    const body = `${'<w:tbl><w:tr><w:tc>'.repeat(300)}${p('buried')}${'</w:tc></w:tr></w:tbl>'.repeat(300)}`;
    await expect(read({ body })).rejects.toThrow(/Could not read that \.docx/u);
  });

  it('still reads a document nested to an ordinary degree', async () => {
    const body = `${'<w:tbl><w:tr><w:tc>'.repeat(8)}${p('findable')}${'</w:tc></w:tr></w:tbl>'.repeat(8)}`;
    const result = await read({ body });
    expect(toPlainText(result.content)).toContain('findable');
  });
});

describe('text that names markup', () => {
  it('is decoded exactly once, so what somebody wrote is what is stored', async () => {
    // Regression: a decoder that ran its replacements in sequence turned the
    // literal text "&lt;" into "<", replacing what somebody had written.
    const result = await read({ body: p('&amp;lt; and &amp;amp; and &lt;b&gt;') });
    expect(toPlainText(result.content)).toBe('&lt; and &amp; and <b>');
  });

  it('leaves a character reference outside Unicode alone rather than crashing', async () => {
    const result = await read({ body: p('before &#1114112; after') });
    expect(toPlainText(result.content)).toContain('before');
    expect(toPlainText(result.content)).toContain('after');
  });

  it('leaves a lone surrogate as written rather than storing a broken character', async () => {
    // Half a character pair is not a character. Turning it into one would store
    // something no reader can render; leaving the reference as text keeps the
    // file's own claim visible and loses nothing.
    const result = await read({ body: p('a&#55296;b') });
    expect(toPlainText(result.content)).toBe('a&#55296;b');
  });
});

describe('pictures in an uploaded file', () => {
  const withImage = (media: Record<string, Uint8Array>, target: string, external = false) => ({
    body: drawing('rId1', 120, 90),
    relationships: { rId1: { target, external } },
    media,
  });

  it('is kept at the size the file says it is shown at', async () => {
    const result = await read(withImage({ 'image1.png': PNG_BYTES }, 'media/image1.png'));
    const image = result.content.content?.[0]?.content?.[0];
    expect(image?.attrs?.['width']).toBe(120);
    expect(image?.attrs?.['height']).toBe(90);
  });

  it('is removed when it is held outside the file, and the removal is reported', async () => {
    const result = await read(withImage({}, 'https://example.com/a.png', true));
    expect(JSON.stringify(result.content)).not.toContain('example.com');
    expect(result.messages.join(' ')).toMatch(/outside the file/u);
  });

  it('is kept in the file, and said not to be drawn, when a browser cannot show its format', async () => {
    // It used to be removed, because the writer built a new file and could not
    // put an EMF into it. The writer now patches the uploaded file, so the
    // picture stays where it was and only the editor goes without it.
    const result = await read(withImage({ 'image1.emf': PNG_BYTES }, 'media/image1.emf'));
    expect(result.messages.join(' ')).toMatch(/kept in the file but not drawn/u);
    expect(JSON.stringify(result.content)).toContain('"kind":"picture"');
  });

  it('is not shown when it is larger than the limit for one picture, and the message says so', async () => {
    const large = new Uint8Array(26 * 1024 * 1024);
    const result = await read(withImage({ 'image1.png': large }, 'media/image1.png'));
    expect(result.messages.join(' ')).toMatch(/larger than 25 MB/u);
  });

  it('stops once the pictures together would be more than a document may hold', async () => {
    const oneMegabyte = new Uint8Array(1024 * 1024);
    const media: Record<string, Uint8Array> = {};
    const relationships: Record<string, { target: string }> = {};
    let body = '';
    for (let index = 1; index <= 45; index += 1) {
      media[`image${index}.png`] = oneMegabyte;
      relationships[`rId${index}`] = { target: `media/image${index}.png` };
      body += drawing(`rId${index}`);
    }
    const result = await read({ body, relationships, media });
    const kept = JSON.stringify(result.content).split('"type":"image"').length - 1;
    expect(kept).toBeLessThan(45);
    expect(result.messages.join(' ')).toMatch(/too many/u);
  });

  it('keeps alternative text short enough to be stored', async () => {
    const caption = 'A'.repeat(4000);
    const body =
      `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/>` +
      `<wp:docPr id="1" name="Picture" descr="${caption}"/><a:graphic><a:graphicData>` +
      `<a:blip r:embed="rId1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    const result = await read({
      body,
      relationships: { rId1: { target: 'media/image1.png' } },
      media: { 'image1.png': PNG_BYTES },
    });
    const alt = result.content.content?.[0]?.content?.[0]?.attrs?.['alt'];
    expect(String(alt).length).toBeLessThanOrEqual(500);
  });
});

describe('a hyperlink in an uploaded file', () => {
  const linked = (target: string) => ({
    body: `<w:p><w:hyperlink r:id="rId1"><w:r><w:t>click</w:t></w:r></w:hyperlink></w:p>`,
    relationships: { rId1: { target, external: true } },
  });

  it('keeps an ordinary address', async () => {
    const result = await read(linked('https://intranet/page'));
    expect(JSON.stringify(result.content)).toContain('https://intranet/page');
  });

  it('drops one that could execute, keeping the words', async () => {
    for (const target of ['javascript:alert(1)', 'data:text/html,<script>', '//evil.test/page']) {
      const result = await read(linked(target));
      expect(JSON.stringify(result.content), target).not.toContain('"link"');
      expect(toPlainText(result.content), target).toBe('click');
    }
  });

  it('keeps a link to a place in the same document', async () => {
    const result = await read({
      body: `<w:p><w:hyperlink w:anchor="summary"><w:r><w:t>Summary</w:t></w:r></w:hyperlink></w:p>`,
    });
    expect(JSON.stringify(result.content)).toContain('"#summary"');
  });
});

describe('a file whose markup is broken', () => {
  it('is refused with a message, not with a server error', async () => {
    await expect(read({ documentXml: '<w:document><w:body>' })).rejects.toThrow(
      /Could not read that \.docx/u,
    );
  });

  it('is refused when it has no main part at all', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const broken = Buffer.from(zipSync({ 'hello.txt': strToU8('not a document') }));
    await expect(importDocx(broken)).rejects.toThrow(/Could not read that \.docx/u);
  });
});

describe('what a document carries outside its body', () => {
  it('reads the header, the footer and the orientation', async () => {
    const result = await read({
      body: `${p('Body')}<w:sectPr><w:pgSz w:orient="landscape" w:w="16838" w:h="11906"/></w:sectPr>`,
      headers: ['<w:hdr><w:p><w:r><w:t>Company handbook</w:t></w:r></w:p></w:hdr>'],
      footers: ['<w:ftr><w:p><w:r><w:t>Confidential</w:t></w:r></w:p></w:ftr>'],
    });
    expect(result.meta).toEqual({
      header: 'Company handbook',
      footer: 'Confidential',
      orientation: 'landscape',
    });
  });
});

describe('numbering', () => {
  it('tells a bulleted list from a numbered one', async () => {
    const numbering =
      '<w:numbering>' +
      '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>' +
      '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>' +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
      '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
      '</w:numbering>';
    const item = (numId: string, text: string): string =>
      p(text, `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>`);
    const result = await read({ body: `${item('1', 'Bullet')}${item('2', 'Number')}`, numbering });
    const types = result.content.content?.map((node) => node.type);
    expect(types).toEqual(['bulletList', 'orderedList']);
  });
});
