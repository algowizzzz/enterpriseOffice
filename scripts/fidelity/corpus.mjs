/**
 * A corpus of Word documents covering the rich content a real one carries.
 *
 * These are generated rather than downloaded. An air-gapped build cannot fetch
 * anything, the licence of a document found on the web is rarely clear, and a
 * generated corpus can be made to cover every feature deliberately rather than
 * by luck. Each document is written with the same library the exporter uses, so
 * what comes out is a genuine .docx that Word opens.
 *
 * Every document declares which features it contains. The comparison uses that
 * declaration to say what was expected to survive, so a feature nobody tested
 * cannot be scored as preserved.
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

/** A one-pixel PNG, stretched by the size given at each use. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A small JPEG, so the corpus is not all one format. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

const FONTS = ['Calibri', 'Times New Roman', 'Arial', 'Georgia', 'Courier New'];
const COLOURS = ['1F4E79', 'C00000', '375623', '7030A0', 'BF8F00'];
const FILLS = ['D9E2F3', 'FBE4D5', 'E2EFD9', 'FFF2CC', 'DEEAF6'];

const image = (data, width, height) =>
  new ImageRun({
    data,
    transformation: { width, height },
    type: data === JPEG ? 'jpg' : 'png',
  });

/** A run carrying every character-level property we care about. */
const run = (text, options = {}) => new TextRun({ text, ...options });

const heading = (text, level) => new Paragraph({ text, heading: level });

const shadedCell = (text, fill, options = {}) =>
  new TableCell({
    children: [new Paragraph({ children: [run(text)] })],
    shading: { type: ShadingType.CLEAR, color: 'auto', fill },
    ...options,
  });

const plainCell = (text, options = {}) =>
  new TableCell({ children: [new Paragraph({ children: [run(text)] })], ...options });

/** A table with a coloured header band and plain body rows. */
function colouredTable(rows, columns, fill) {
  const header = new TableRow({
    tableHeader: true,
    children: Array.from({ length: columns }, (_, c) => shadedCell(`Column ${c + 1}`, fill)),
  });
  const body = Array.from(
    { length: rows },
    (_, r) =>
      new TableRow({
        children: Array.from({ length: columns }, (_, c) => plainCell(`R${r + 1}C${c + 1}`)),
      }),
  );
  return new Table({
    rows: [header, ...body],
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 6, color: '808080' },
      bottom: { style: BorderStyle.SINGLE, size: 6, color: '808080' },
      left: { style: BorderStyle.SINGLE, size: 6, color: '808080' },
      right: { style: BorderStyle.SINGLE, size: 6, color: '808080' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' },
    },
  });
}

/** A table with a cell spanning columns and a cell spanning rows. */
function mergedTable(fill) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [shadedCell('Merged across three columns', fill, { columnSpan: 3 })],
      }),
      new TableRow({
        children: [
          plainCell('Spans two rows', { rowSpan: 2 }),
          plainCell('Body B1'),
          plainCell('Body C1'),
        ],
      }),
      // No cell is written for the first column: the row span above covers it,
      // and the library writes the continuation itself.
      new TableRow({ children: [plainCell('Body B2'), plainCell('Body C2')] }),
    ],
  });
}

const FEATURES = {
  headings: 'headings H1 to H4',
  characterFormatting: 'bold, italic, underline and strikethrough',
  fonts: 'named fonts and sizes',
  colour: 'text colour and highlighting',
  alignment: 'left, centre, right and justified paragraphs',
  lists: 'bulleted and numbered lists',
  table: 'tables',
  tableShading: 'coloured table cells',
  tableMerge: 'merged table cells',
  image: 'inline images',
  fullPageImage: 'a full-width image',
  header: 'page headers',
  footer: 'page footers',
  landscape: 'landscape orientation',
  quote: 'block quotes',
  rule: 'horizontal rules',
  pageBreak: 'page breaks',
};

/**
 * The corpus. Each entry names the features it is testing, so nothing is scored
 * on a document that never contained it.
 */
export function buildCorpus() {
  const documents = [];

  const add = (name, features, sections, options = {}) =>
    documents.push({ name, features, sections, options });

  const body = (extra = []) => [
    heading('Quarterly report', HeadingLevel.HEADING_1),
    new Paragraph({
      children: [
        run('This paragraph carries '),
        run('bold', { bold: true }),
        run(', '),
        run('italic', { italics: true }),
        run(', '),
        run('underlined', { underline: {} }),
        run(' and '),
        run('struck through', { strike: true }),
        run(' text.'),
      ],
    }),
    ...extra,
  ];

  // 1-5: headings and character formatting, one per font.
  FONTS.forEach((font, index) => {
    add(`${String(index + 1).padStart(2, '0')}-headings-${font.replace(/\s+/gu, '-').toLowerCase()}`,
      ['headings', 'characterFormatting', 'fonts'],
      [
        {
          children: [
            heading('Heading one', HeadingLevel.HEADING_1),
            new Paragraph({ children: [run('Body text in ' + font, { font, size: 24 })] }),
            heading('Heading two', HeadingLevel.HEADING_2),
            new Paragraph({ children: [run('Bold in ' + font, { font, bold: true, size: 28 })] }),
            heading('Heading three', HeadingLevel.HEADING_3),
            new Paragraph({ children: [run('Italic in ' + font, { font, italics: true, size: 20 })] }),
            heading('Heading four', HeadingLevel.HEADING_4),
            new Paragraph({ children: [run('Small print in ' + font, { font, size: 16 })] }),
          ],
        },
      ]);
  });

  // 6-10: colour and highlighting.
  COLOURS.forEach((colour, index) => {
    add(`${String(index + 6).padStart(2, '0')}-colour-${colour}`,
      ['colour', 'characterFormatting', 'headings'],
      [
        {
          children: [
            heading('Coloured text', HeadingLevel.HEADING_1),
            new Paragraph({ children: [run('Coloured body text', { color: colour })] }),
            new Paragraph({
              children: [run('Highlighted body text', { highlight: 'yellow' })],
            }),
            new Paragraph({
              children: [run('Coloured and bold', { color: colour, bold: true, size: 26 })],
            }),
          ],
        },
      ]);
  });

  // 11-15: alignment.
  const alignments = [
    ['left', AlignmentType.LEFT],
    ['centre', AlignmentType.CENTER],
    ['right', AlignmentType.RIGHT],
    ['justified', AlignmentType.JUSTIFIED],
    ['mixed', null],
  ];
  alignments.forEach(([label, alignment], index) => {
    const children =
      alignment === null
        ? [
            new Paragraph({ text: 'Left aligned', alignment: AlignmentType.LEFT }),
            new Paragraph({ text: 'Centred', alignment: AlignmentType.CENTER }),
            new Paragraph({ text: 'Right aligned', alignment: AlignmentType.RIGHT }),
            new Paragraph({ text: 'Justified '.repeat(20), alignment: AlignmentType.JUSTIFIED }),
          ]
        : [
            new Paragraph({ text: `A ${label} heading`, heading: HeadingLevel.HEADING_2, alignment }),
            new Paragraph({ text: `${label} body text. `.repeat(8), alignment }),
          ];
    add(`${String(index + 11).padStart(2, '0')}-align-${label}`, ['alignment', 'headings'], [{ children }]);
  });

  // 16-20: lists.
  for (let i = 0; i < 5; i += 1) {
    add(`${String(i + 16).padStart(2, '0')}-lists-${i + 1}`, ['lists', 'headings'], [
      {
        children: [
          heading('A list of things', HeadingLevel.HEADING_2),
          ...Array.from({ length: 3 + i }, (_, n) =>
            new Paragraph({ text: `Bullet ${n + 1}`, bullet: { level: 0 } }),
          ),
          new Paragraph({ text: 'Nested bullet', bullet: { level: 1 } }),
          ...Array.from({ length: 3 }, (_, n) =>
            new Paragraph({ text: `Numbered ${n + 1}`, numbering: { reference: 'numbers', level: 0 } }),
          ),
        ],
      },
    ]);
  }

  // 21-28: tables, plain, coloured and merged.
  for (let i = 0; i < 4; i += 1) {
    add(`${String(i + 21).padStart(2, '0')}-table-plain-${i + 1}`, ['table', 'tableShading', 'headings'], [
      {
        children: [
          heading('A table', HeadingLevel.HEADING_2),
          colouredTable(2 + i, 3 + (i % 2), FILLS[i % FILLS.length]),
          new Paragraph('Text after the table.'),
        ],
      },
    ]);
  }
  for (let i = 0; i < 4; i += 1) {
    add(`${String(i + 25).padStart(2, '0')}-table-merged-${i + 1}`,
      ['table', 'tableShading', 'tableMerge', 'headings'],
      [
        {
          children: [
            heading('A table with merged cells', HeadingLevel.HEADING_2),
            mergedTable(FILLS[i % FILLS.length]),
            new Paragraph('Text after the table.'),
          ],
        },
      ]);
  }

  // 29-36: images, inline and full width, PNG and JPEG.
  for (let i = 0; i < 4; i += 1) {
    add(`${String(i + 29).padStart(2, '0')}-image-inline-${i + 1}`, ['image', 'headings'], [
      {
        children: [
          heading('A document with pictures', HeadingLevel.HEADING_2),
          new Paragraph({ children: [image(i % 2 === 0 ? PNG : JPEG, 120 + i * 40, 90 + i * 30)] }),
          new Paragraph('A caption under the picture.'),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [image(PNG, 200, 120)],
          }),
        ],
      },
    ]);
  }
  for (let i = 0; i < 4; i += 1) {
    add(`${String(i + 33).padStart(2, '0')}-image-fullpage-${i + 1}`,
      ['image', 'fullPageImage', 'headings'],
      [
        {
          children: [
            heading('A full page picture', HeadingLevel.HEADING_1),
            new Paragraph({ children: [image(PNG, 620, 800)] }),
          ],
        },
      ]);
  }

  // 37-42: headers and footers.
  for (let i = 0; i < 6; i += 1) {
    add(`${String(i + 37).padStart(2, '0')}-header-footer-${i + 1}`,
      ['header', 'footer', 'headings', 'characterFormatting'],
      [
        {
          headers: {
            default: new Header({
              children: [
                new Paragraph({
                  alignment: AlignmentType.RIGHT,
                  children: [run(`Company handbook ${i + 1}`, { bold: true })],
                }),
              ],
            }),
          },
          footers: {
            default: new Footer({
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [run('Confidential — page footer', { italics: true, size: 18 })],
                }),
              ],
            }),
          },
          children: body(),
        },
      ]);
  }

  // 43-45: landscape and page breaks.
  for (let i = 0; i < 3; i += 1) {
    add(`${String(i + 43).padStart(2, '0')}-layout-${i + 1}`,
      ['landscape', 'pageBreak', 'headings', 'table'],
      [
        {
          properties: { page: { size: { orientation: PageOrientation.LANDSCAPE } } },
          children: [
            heading('Wide layout', HeadingLevel.HEADING_1),
            colouredTable(3, 5, FILLS[i % FILLS.length]),
            new Paragraph({ text: 'After the break', pageBreakBefore: true }),
          ],
        },
      ]);
  }

  // 46-47: quotes and rules.
  for (let i = 0; i < 2; i += 1) {
    add(`${String(i + 46).padStart(2, '0')}-quote-rule-${i + 1}`, ['quote', 'rule', 'headings'], [
      {
        children: [
          heading('A quotation', HeadingLevel.HEADING_2),
          new Paragraph({ text: 'Quoted text that somebody else wrote.', style: 'IntenseQuote' }),
          new Paragraph({
            text: '',
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000' } },
          }),
          new Paragraph('Text after the rule.'),
        ],
      },
    ]);
  }

  // 48-50: everything at once, which is what a real document looks like.
  for (let i = 0; i < 3; i += 1) {
    add(`${String(i + 48).padStart(2, '0')}-everything-${i + 1}`,
      [
        'headings',
        'characterFormatting',
        'fonts',
        'colour',
        'alignment',
        'lists',
        'table',
        'tableShading',
        'tableMerge',
        'image',
        'header',
        'footer',
        'quote',
      ],
      [
        {
          headers: {
            default: new Header({ children: [new Paragraph('Annual review')] }),
          },
          footers: {
            default: new Footer({ children: [new Paragraph('Page footer')] }),
          },
          children: [
            heading('Annual review', HeadingLevel.HEADING_1),
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [run('A centred subtitle', { italics: true, color: COLOURS[i], size: 28 })],
            }),
            heading('Summary', HeadingLevel.HEADING_2),
            ...body().slice(1),
            heading('Detail', HeadingLevel.HEADING_3),
            new Paragraph({ text: 'First point', bullet: { level: 0 } }),
            new Paragraph({ text: 'Second point', bullet: { level: 0 } }),
            new Paragraph({ text: 'A nested point', bullet: { level: 1 } }),
            heading('Figures', HeadingLevel.HEADING_4),
            colouredTable(3, 4, FILLS[i]),
            new Paragraph({ children: [image(PNG, 240, 160)] }),
            mergedTable(FILLS[(i + 1) % FILLS.length]),
            new Paragraph({ text: 'A closing quotation.', style: 'IntenseQuote' }),
            new Paragraph({
              children: [run('Set in ' + FONTS[i], { font: FONTS[i], size: 22 })],
            }),
          ],
        },
      ]);
  }

  return documents;
}

const NUMBERING = {
  config: [
    {
      reference: 'numbers',
      levels: [
        { level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START },
        { level: 1, format: 'lowerLetter', text: '%2.', alignment: AlignmentType.START },
      ],
    },
  ],
};

/** Pack one corpus entry into .docx bytes. */
export async function packDocument(entry) {
  const document = new Document({
    numbering: NUMBERING,
    sections: entry.sections,
    ...entry.options,
  });
  return Packer.toBuffer(document);
}

export { FEATURES };
