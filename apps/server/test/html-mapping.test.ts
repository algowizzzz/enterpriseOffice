import { describe, expect, it } from 'vitest';
import { toPlainText, type PMNode } from '@docforge/model';
import { htmlToDocument, titleFromFileName } from '../src/docx/import.js';
import { markParagraph, alignmentTransform } from '../src/docx/mammothOptions.js';

const convert = (html: string): PMNode => htmlToDocument(html).content;
const messages = (html: string): string[] => htmlToDocument(html).messages;

function find(node: PMNode, type: string, found: PMNode[] = []): PMNode[] {
  if (node.type === type) found.push(node);
  for (const child of node.content ?? []) find(child, type, found);
  return found;
}

function markNames(node: PMNode, found = new Set<string>()): Set<string> {
  for (const mark of node.marks ?? []) found.add(mark.type);
  for (const child of node.content ?? []) markNames(child, found);
  return found;
}

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('html to document, blocks', () => {
  it('always produces at least one paragraph', () => {
    expect(convert('')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(convert('   ')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });

  it('maps each heading level', () => {
    const doc = convert('<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>');
    expect(find(doc, 'heading').map((n) => n.attrs?.['level'])).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps an empty heading as a heading', () => {
    const doc = convert('<h2></h2>');
    const headings = find(doc, 'heading');
    expect(headings).toHaveLength(1);
    expect(headings[0]?.content).toBeUndefined();
  });

  it('wraps loose text that sits outside any block', () => {
    const doc = convert('Loose text<p>In a paragraph</p>');
    expect(toPlainText(doc)).toContain('Loose text');
    expect(toPlainText(doc)).toContain('In a paragraph');
  });

  it('discards loose whitespace between blocks', () => {
    const doc = convert('<p>One</p>\n   \n<p>Two</p>');
    expect((doc.content ?? []).filter((n) => n.type === 'paragraph')).toHaveLength(2);
  });

  it('maps a horizontal rule', () => {
    expect(find(convert('<p>a</p><hr /><p>b</p>'), 'horizontalRule')).toHaveLength(1);
  });

  it('maps a line break', () => {
    expect(find(convert('<p>one<br />two</p>'), 'hardBreak')).toHaveLength(1);
  });

  it('maps a block quote and gives an empty one a paragraph', () => {
    expect(find(convert('<blockquote><p>Quoted</p></blockquote>'), 'blockquote')).toHaveLength(1);
    const empty = find(convert('<blockquote></blockquote>'), 'blockquote');
    expect(empty[0]?.content).toEqual([{ type: 'paragraph' }]);
  });

  it('unwraps a container it does not model, keeping the blocks inside', () => {
    const doc = convert('<section><div><p>Still here</p></div></section>');
    expect(toPlainText(doc)).toContain('Still here');
  });
});

describe('html to document, lists', () => {
  it('maps bulleted and numbered lists', () => {
    expect(find(convert('<ul><li>a</li><li>b</li></ul>'), 'listItem')).toHaveLength(2);
    expect(find(convert('<ol><li>a</li></ol>'), 'orderedList')).toHaveLength(1);
  });

  it('gives a list with no items one empty item, so the node stays valid', () => {
    const list = find(convert('<ul></ul>'), 'bulletList');
    expect(list[0]?.content).toHaveLength(1);
  });

  it('gives an empty list item a paragraph', () => {
    const items = find(convert('<ul><li></li></ul>'), 'listItem');
    expect(items[0]?.content).toEqual([{ type: 'paragraph' }]);
  });

  it('ignores anything in a list that is not a list item', () => {
    const items = find(convert('<ul><li>real</li><span>stray</span></ul>'), 'listItem');
    expect(items).toHaveLength(1);
  });

  it('keeps a list nested inside an item', () => {
    const doc = convert('<ul><li>Outer<ul><li>Inner</li></ul></li></ul>');
    expect(find(doc, 'bulletList')).toHaveLength(2);
    expect(toPlainText(doc)).toContain('Inner');
  });
});

describe('html to document, tables', () => {
  it('maps rows, cells and header cells', () => {
    const doc = convert(
      '<table><tr><th>H</th></tr><tr><td>C</td></tr></table>',
    );
    expect(find(doc, 'table')).toHaveLength(1);
    expect(find(doc, 'tableRow')).toHaveLength(2);
    expect(find(doc, 'tableHeader')).toHaveLength(1);
    expect(find(doc, 'tableCell')).toHaveLength(1);
  });

  it('reads a column and row span', () => {
    const cells = find(
      convert('<table><tr><td colspan="3" rowspan="2">Wide and tall</td></tr></table>'),
      'tableCell',
    );
    expect(cells[0]?.attrs).toMatchObject({ colspan: 3, rowspan: 2 });
  });

  it('falls back to a single span when the value is nonsense', () => {
    const cells = find(
      convert('<table><tr><td colspan="many" rowspan="-4">Odd</td></tr></table>'),
      'tableCell',
    );
    expect(cells[0]?.attrs).toMatchObject({ colspan: 1, rowspan: 1 });
  });

  it('gives an empty cell a paragraph', () => {
    const cells = find(convert('<table><tr><td></td></tr></table>'), 'tableCell');
    expect(cells[0]?.content).toEqual([{ type: 'paragraph' }]);
  });

  it('drops a table with no usable rows rather than emitting an invalid node', () => {
    const doc = convert('<table></table>');
    expect(find(doc, 'table')).toHaveLength(0);
  });

  it('ignores cells that are not table cells', () => {
    const cells = find(convert('<table><tr><td>a</td><div>b</div></tr></table>'), 'tableCell');
    expect(cells).toHaveLength(1);
  });
});

describe('html to document, marks', () => {
  it('maps every emphasis element to its mark', () => {
    const marks = markNames(
      convert(
        '<p><strong>a</strong><b>b</b><em>c</em><i>d</i><u>e</u><s>f</s><strike>g</strike><del>h</del><sup>i</sup><sub>j</sub><mark>k</mark></p>',
      ),
    );
    for (const mark of ['bold', 'italic', 'underline', 'strike', 'superscript', 'subscript', 'highlight']) {
      expect([...marks], mark).toContain(mark);
    }
  });

  it('nests marks on the same run', () => {
    const doc = convert('<p><strong><em>both</em></strong></p>');
    const text = find(doc, 'text')[0];
    const names = (text?.marks ?? []).map((m) => m.type);
    expect(names).toContain('bold');
    expect(names).toContain('italic');
  });

  it('keeps a safe link', () => {
    for (const href of ['https://intranet/page', 'http://intranet/page', 'mailto:a@b', '#anchor', '/local']) {
      const marks = markNames(convert(`<p><a href="${href}">link</a></p>`));
      expect([...marks], href).toContain('link');
    }
  });

  it('drops a link whose protocol could run script, keeping the text', () => {
    // A hostile .docx can carry any hyperlink target, so the check here is the
    // one that matters, not the one in the editor.
    for (const href of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd']) {
      const doc = convert(`<p><a href="${href}">click me</a></p>`);
      expect([...markNames(doc)], href).not.toContain('link');
      expect(toPlainText(doc)).toContain('click me');
    }
  });

  it('drops a link with no target at all', () => {
    expect([...markNames(convert('<p><a>no target</a></p>'))]).not.toContain('link');
  });

  it('decodes the entities mammoth emits', () => {
    expect(toPlainText(convert('<p>a &amp; b &lt; c &gt; d &quot;e&quot;</p>'))).toBe('a & b < c > d "e"');
  });

  it('decodes a non-breaking space to a real one', () => {
    expect(toPlainText(convert('<p>a&nbsp;b</p>'))).toBe('a\u00a0b');
  });

  it('decodes numeric character references', () => {
    expect(toPlainText(convert('<p>&#65;&#x42;</p>'))).toBe('AB');
  });

  it('drops an empty text node rather than storing it', () => {
    const doc = convert('<p><strong></strong>text</p>');
    expect(find(doc, 'text')).toHaveLength(1);
  });
});

describe('html to document, alignment', () => {
  it('reads an inline text alignment', () => {
    const doc = convert('<p style="text-align: center">Centred</p>');
    expect((doc.content ?? [])[0]?.attrs).toMatchObject({ textAlign: 'center' });
  });

  it('reads the alignment class the style map produces', () => {
    for (const alignment of ['left', 'center', 'right', 'justify']) {
      const doc = convert(`<p class="align-${alignment}">Text</p>`);
      expect((doc.content ?? [])[0]?.attrs, alignment).toMatchObject({ textAlign: alignment });
    }
  });

  it('reads alignment on a heading', () => {
    const doc = convert('<h2 class="align-right">Heading</h2>');
    expect((doc.content ?? [])[0]?.attrs).toMatchObject({ level: 2, textAlign: 'right' });
  });

  it('passes a quote alignment down to the paragraphs inside it', () => {
    const doc = convert('<blockquote class="align-center">Quoted text</blockquote>');
    const quote = find(doc, 'blockquote')[0];
    expect(quote?.content?.[0]?.attrs).toMatchObject({ textAlign: 'center' });
  });

  it('does not overwrite an alignment a paragraph already carries', () => {
    const doc = convert(
      '<blockquote class="align-center"><p style="text-align: right">Own</p></blockquote>',
    );
    const quote = find(doc, 'blockquote')[0];
    expect(quote?.content?.[0]?.attrs).toMatchObject({ textAlign: 'right' });
  });

  it('records no alignment when a class says something else', () => {
    const doc = convert('<p class="MsoNormal">Text</p>');
    expect((doc.content ?? [])[0]?.attrs).toBeUndefined();
  });
});

describe('html to document, images', () => {
  it('keeps an embedded image with its alternative text', () => {
    const images = find(convert(`<p><img src="${TINY_PNG}" alt="A dot" /></p>`), 'image');
    expect(images).toHaveLength(1);
    expect(images[0]?.attrs?.['alt']).toBe('A dot');
  });

  it('records no alternative text when the file carried none', () => {
    const images = find(convert(`<p><img src="${TINY_PNG}" /></p>`), 'image');
    expect(images[0]?.attrs?.['alt']).toBeNull();
  });

  it('removes an image that points at a remote address, and says so', () => {
    const html = '<p><img src="https://example.com/logo.png" /></p>';
    expect(find(convert(html), 'image')).toHaveLength(0);
    expect(messages(html).join(' ')).toMatch(/unsupported source/u);
  });

  it('removes an image larger than the embedding limit, and says so', () => {
    const big = `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`;
    const html = `<p><img src="${big}" /></p>`;
    expect(find(convert(html), 'image')).toHaveLength(0);
    expect(messages(html).join(' ')).toMatch(/larger than 2 MB/u);
  });

  it('stops after the image limit and says how many it took', () => {
    const html = `<p>${`<img src="${TINY_PNG}" />`.repeat(120)}</p>`;
    expect(find(convert(html), 'image')).toHaveLength(100);
    expect(messages(html).join(' ')).toMatch(/first 100 images/u);
  });
});

describe('uploaded file names', () => {
  it('strips the extension whatever its case', () => {
    expect(titleFromFileName('Report.docx')).toBe('Report');
    expect(titleFromFileName('Report.DOCX')).toBe('Report');
  });

  it('keeps only the last path segment', () => {
    expect(titleFromFileName('C:\\Users\\ada\\Notes.docx')).toBe('Notes');
    expect(titleFromFileName('/home/ada/Notes.docx')).toBe('Notes');
  });

  it('falls back when nothing usable is left', () => {
    expect(titleFromFileName('.docx')).toBe('Imported document');
    expect(titleFromFileName('   .docx')).toBe('Imported document');
  });

  it('leaves a name that has no extension alone', () => {
    expect(titleFromFileName('Plain name')).toBe('Plain name');
  });
});

describe('alignment transform', () => {
  it('folds alignment into the style name', () => {
    expect(markParagraph({ alignment: 'center', styleName: null })).toMatchObject({
      styleName: 'DocForgeAligned-center-body',
      styleId: null,
    });
    expect(markParagraph({ alignment: 'both', styleName: 'Heading 3' })).toMatchObject({
      styleName: 'DocForgeAligned-justify-h3',
    });
  });

  it('leaves an unaligned paragraph exactly as it was', () => {
    const paragraph = { alignment: null, styleName: 'Heading 1', styleId: 'Heading1' };
    expect(markParagraph(paragraph)).toBe(paragraph);
  });

  it('leaves a paragraph with an unmodelled style alone', () => {
    const paragraph = { alignment: 'center', styleName: 'Company Letterhead' };
    expect(markParagraph(paragraph)).toBe(paragraph);
  });

  it('leaves left-aligned text alone, since that is the default', () => {
    const paragraph = { alignment: 'left', styleName: null };
    expect(markParagraph(paragraph)).toBe(paragraph);
  });

  it('gives up quietly if mammoth ever stops exposing its transforms', () => {
    // Losing alignment is acceptable. Failing every upload is not.
    expect(alignmentTransform({})).toBeUndefined();
    expect(alignmentTransform(null)).toBeUndefined();
    expect(alignmentTransform({ transforms: {} })).toBeUndefined();
  });

  it('returns a usable transform when they are present', () => {
    const fake = { transforms: { paragraph: (fn: unknown) => fn } };
    expect(typeof alignmentTransform(fake)).toBe('function');
  });
});
