import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import type { PMNode } from '@docforge/model';
import { exportDocx } from '../src/docx/export.js';
import { defaultExportTemplate } from '../src/services/exportTemplate.js';

const doc: PMNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Purpose' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Ordinary body text.' }] },
  ],
};

describe('Standardized export', () => {
  it('writes real Heading1..6 and default styles from the admin template', async () => {
    const template = { ...defaultExportTemplate(), updatedBy: null };
    const buffer = await exportDocx(doc, {
      title: 'Quarterly report',
      standardTemplate: { template, documentType: 'Policy' },
    });
    const parts = unzipSync(new Uint8Array(buffer));
    const styles = strFromU8(parts['word/styles.xml']!);
    const document = strFromU8(parts['word/document.xml']!);

    // The heading paragraph references the named style, not direct formatting.
    expect(document).toMatch(/<w:pStyle w:val="Heading1"\/>/u);
    // The style itself carries the admin's font, size (half-points) and colour.
    const heading1 = /<w:style[^>]*w:styleId="Heading1"[^>]*>.*?<\/w:style>/su.exec(styles)?.[0] ?? '';
    expect(heading1).toContain(template.headings[0]!.color.replace('#', ''));
    expect(heading1).toContain(`w:val="${Math.round(template.headings[0]!.fontSize * 2)}"`);
    // Body text carries the admin's default font/size/colour via document defaults.
    expect(styles).toContain(template.body.color.replace('#', ''));
    expect(styles).toContain(template.body.fontFamily);
  });

  it('writes header and footer content, resolving document tokens', async () => {
    const template = defaultExportTemplate();
    template.header.left.content = '{{document.title}}';
    template.header.right.content = '{{document.type}}';
    const buffer = await exportDocx(doc, {
      title: 'Quarterly report',
      standardTemplate: { template, documentType: 'Policy' },
    });
    const parts = unzipSync(new Uint8Array(buffer));
    const headerFile = Object.keys(parts).find((name) => /^word\/header\d+\.xml$/u.test(name));
    expect(headerFile).toBeDefined();
    const header = strFromU8(parts[headerFile as string]!);
    expect(header).toContain('Quarterly report');
    expect(header).toContain('Policy');
  });

  it('writes {{page}} and {{pageCount}} as real Word fields, not literal text', async () => {
    const template = defaultExportTemplate();
    // The default footer already carries "{{page}} of {{pageCount}}".
    const buffer = await exportDocx(doc, {
      title: 'Quarterly report',
      standardTemplate: { template, documentType: null },
    });
    const parts = unzipSync(new Uint8Array(buffer));
    const footerFile = Object.keys(parts).find((name) => /^word\/footer\d+\.xml$/u.test(name));
    const footer = strFromU8(parts[footerFile as string]!);
    expect(footer).not.toContain('{{page}}');
    expect(footer).toMatch(/PAGE/u);
    expect(footer).toMatch(/NUMPAGES/u);
  });

  it('overrides the document’s own formatting rather than preserving it, unlike plain docx export', async () => {
    // A document with its own page setup and no uploaded source still gets
    // the admin's header/footer, not its own.
    const template = defaultExportTemplate();
    template.footer.left.content = 'House style footer';
    const buffer = await exportDocx(doc, {
      title: 'Quarterly report',
      pageSetup: { header: 'The document’s own header', footer: 'The document’s own footer', orientation: 'portrait' },
      standardTemplate: { template, documentType: null },
    });
    const parts = unzipSync(new Uint8Array(buffer));
    const footerFile = Object.keys(parts).find((name) => /^word\/footer\d+\.xml$/u.test(name));
    const footer = strFromU8(parts[footerFile as string]!);
    expect(footer).toContain('House style footer');
    expect(footer).not.toContain('own footer');
  });

  it('embeds the footer’s logo as a real image part', async () => {
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const template = defaultExportTemplate();
    template.logo = { mediaType: 'image/png', dataUrl: `data:image/png;base64,${tinyPng.toString('base64')}` };
    const buffer = await exportDocx(doc, {
      title: 'Quarterly report',
      standardTemplate: { template, documentType: null },
    });
    const parts = unzipSync(new Uint8Array(buffer));
    const imageFile = Object.keys(parts).find((name) => /^word\/media\/.+\.png$/u.test(name));
    expect(imageFile).toBeDefined();
    expect(Buffer.from(parts[imageFile as string]!)).toEqual(tinyPng);

    const footerFile = Object.keys(parts).find((name) => /^word\/footer\d+\.xml$/u.test(name));
    const footer = strFromU8(parts[footerFile as string]!);
    expect(footer).toContain('<w:drawing>');
  });

  it('produces no footer image part when no logo is set', async () => {
    const template = defaultExportTemplate();
    const buffer = await exportDocx(doc, {
      title: 'Quarterly report',
      standardTemplate: { template, documentType: null },
    });
    const parts = unzipSync(new Uint8Array(buffer));
    expect(Object.keys(parts).some((name) => /^word\/media\//u.test(name))).toBe(false);
  });
});
