/**
 * Builds the seed package for "Standardized" export
 * (docs/17-standardized-export.md): a package whose `styles.xml` carries
 * real `Heading1`-`Heading6` and default (`Normal`) styles from the admin's
 * template, and whose header/footer parts carry its content. This is fed
 * into `writeDocx()` as `base`, exactly the way `templatePackage()` in
 * `export.ts` seeds a blank document's export -- there remains one writer;
 * this only supplies it a different starting point, deliberately not the
 * document's own uploaded styling, which is the whole point of this export
 * mode (see `export.ts`'s `exportDocx` and its `standardTemplate` option).
 */
import {
  Document,
  Footer,
  Header,
  PageNumber,
  PageOrientation,
  Packer,
  Paragraph,
  TabStopType,
  TextRun,
  type IRunOptions,
} from 'docx';
import { defaultPageSetup, type PageSetup } from '@docforge/model';
import type { ExportTemplate, HeaderFooterSide } from '../services/exportTemplate.js';

export interface StandardTemplateContext {
  documentTitle: string;
  /** Framework, Policy, Standard, etc, or null when the document has none stated. */
  documentType: string | null;
}

const TOKEN_PATTERN = /\{\{\s*([a-zA-Z.]+)\s*\}\}/gu;
const PT_TO_TWIPS = 20;
/** Roughly the right margin of a portrait letter/A4 page at default margins, in twips. */
const RIGHT_TAB_STOP = 9026;

type RunChild = NonNullable<IRunOptions['children']>[number];

/**
 * Splits a header/footer's content on its tokens. `{{page}}` and
 * `{{pageCount}}` become real Word fields (`PageNumber.CURRENT`/
 * `TOTAL_PAGES`), recalculated by Word itself once the document is
 * paginated -- nothing on this server knows how many pages a document will
 * be. The other known tokens are resolved to plain text now, since this
 * server does know a document's own title, type and today's date. A token
 * outside the known vocabulary cannot reach here: the admin route already
 * refuses it at save time (`services/exportTemplate.ts`'s
 * `unknownTokensIn`), so it is left literal here only as a last resort.
 */
function contentChildren(content: string, ctx: StandardTemplateContext): RunChild[] {
  const pieces: RunChild[] = [];
  let lastIndex = 0;
  for (const match of content.matchAll(TOKEN_PATTERN)) {
    const full = match[0];
    const token = match[1] ?? '';
    const index = match.index ?? 0;
    if (index > lastIndex) pieces.push(content.slice(lastIndex, index));
    if (token === 'page') pieces.push(PageNumber.CURRENT);
    else if (token === 'pageCount') pieces.push(PageNumber.TOTAL_PAGES);
    else if (token === 'document.title') pieces.push(ctx.documentTitle);
    else if (token === 'document.type') pieces.push(ctx.documentType ?? '');
    else if (token === 'date') pieces.push(new Date().toLocaleDateString('en-GB'));
    else pieces.push(full);
    lastIndex = index + full.length;
  }
  if (lastIndex < content.length) pieces.push(content.slice(lastIndex));
  return pieces;
}

function sideRun(side: HeaderFooterSide, ctx: StandardTemplateContext): TextRun {
  return new TextRun({
    children: contentChildren(side.content, ctx),
    font: side.fontFamily,
    size: Math.round(side.fontSize * 2),
    color: side.color.replace('#', ''),
    bold: side.bold,
    italics: side.italic,
  });
}

/** Left content, a tab, then right content pushed to the page's right margin. Empty if neither side has content. */
function runningLine(config: { left: HeaderFooterSide; right: HeaderFooterSide }, ctx: StandardTemplateContext): Paragraph[] {
  if (!config.left.content && !config.right.content) return [];
  return [
    new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB_STOP }],
      children: [sideRun(config.left, ctx), new TextRun({ text: '\t' }), sideRun(config.right, ctx)],
    }),
  ];
}

function headingDefault(style: ExportTemplate['headings'][number] | undefined) {
  if (!style) return undefined;
  return {
    run: {
      font: style.fontFamily,
      size: Math.round(style.fontSize * 2),
      color: style.color.replace('#', ''),
      bold: style.bold,
      italics: style.italic,
    },
    paragraph: {
      spacing: { before: style.spacingBeforePt * PT_TO_TWIPS, after: style.spacingAfterPt * PT_TO_TWIPS },
    },
  };
}

export async function buildStandardTemplatePackage(
  template: ExportTemplate,
  ctx: StandardTemplateContext,
  pageSetup: PageSetup = defaultPageSetup(),
): Promise<Buffer> {
  const document = new Document({
    title: ctx.documentTitle,
    creator: 'DocForge',
    description: 'Created with DocForge (Standardized export)',
    styles: {
      default: {
        document: {
          run: {
            font: template.body.fontFamily,
            size: Math.round(template.body.fontSize * 2),
            color: template.body.color.replace('#', ''),
          },
        },
        heading1: headingDefault(template.headings[0]),
        heading2: headingDefault(template.headings[1]),
        heading3: headingDefault(template.headings[2]),
        heading4: headingDefault(template.headings[3]),
        heading5: headingDefault(template.headings[4]),
        heading6: headingDefault(template.headings[5]),
      },
    },
    sections: [
      {
        properties: {
          ...(pageSetup.orientation === 'landscape'
            ? { page: { size: { orientation: PageOrientation.LANDSCAPE } } }
            : {}),
        },
        headers: { default: new Header({ children: runningLine(template.header, ctx) }) },
        footers: { default: new Footer({ children: runningLine(template.footer, ctx) }) },
        children: [new Paragraph({})],
      },
    ],
  });
  return Packer.toBuffer(document);
}
