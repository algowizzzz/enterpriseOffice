/**
 * What a .docx contains, read straight out of the OOXML.
 *
 * Both sides of the round trip are read the same way, so the comparison is
 * between two profiles rather than between a document and a hope. Nothing here
 * knows about the importer or the exporter: it reads the file Word would read.
 */
import { unzipSync, strFromU8 } from 'fflate';

const textOf = (xml) =>
  [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)]
    .map((m) => decode(m[1]))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();

const decode = (value) =>
  value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');

const attr = (xml, tag, name) => {
  const match = new RegExp(`<${tag}[^>]*\\sw:${name}="([^"]*)"`, 'u').exec(xml);
  return match?.[1] ?? null;
};

const has = (xml, tag) => new RegExp(`<${tag}(?:\\s[^>]*)?/?>`, 'u').test(xml);

/** A run's character properties, as far as they are visible in the markup. */
function runsOf(paragraphXml) {
  return [...paragraphXml.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/gu)].map((match) => {
    const xml = match[1];
    const properties = /<w:rPr>([\s\S]*?)<\/w:rPr>/u.exec(xml)?.[1] ?? '';
    const onOff = (tag) => {
      const found = new RegExp(`<w:${tag}(?:\\s([^>]*))?/?>`, 'u').exec(properties);
      if (!found) return false;
      const value = /w:val="([^"]*)"/u.exec(found[1] ?? '')?.[1];
      return value !== '0' && value !== 'false' && value !== 'none';
    };
    return {
      text: textOf(xml),
      bold: onOff('b'),
      italic: onOff('i'),
      underline: onOff('u'),
      strike: onOff('strike'),
      superscript: /w:val="superscript"/u.test(properties),
      subscript: /w:val="subscript"/u.test(properties),
      colour: attr(properties, 'w:color', 'val'),
      highlight: attr(properties, 'w:highlight', 'val'),
      size: attr(properties, 'w:sz', 'val'),
      font: attr(properties, 'w:rFonts', 'ascii'),
    };
  });
}

const HEADING_STYLE = /^(?:Heading|heading)([1-6])$/u;

function paragraphsOf(xml) {
  return [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/gu)].map((match) => {
    const inner = match[1];
    const properties = /<w:pPr>([\s\S]*?)<\/w:pPr>/u.exec(inner)?.[1] ?? '';
    const style = attr(properties, 'w:pStyle', 'val');
    const headingMatch = style ? HEADING_STYLE.exec(style) : null;
    return {
      text: textOf(inner),
      style,
      heading: headingMatch ? Number(headingMatch[1]) : null,
      alignment: attr(properties, 'w:jc', 'val'),
      numbered: /<w:numPr>/u.test(properties),
      listLevel: Number(attr(properties, 'w:ilvl', 'val') ?? -1),
      pageBreak: has(properties, 'w:pageBreakBefore') || /<w:br[^>]*w:type="page"/u.test(inner),
      bottomBorder: /<w:pBdr>[\s\S]*?<w:bottom/u.test(properties),
      indented: /<w:ind[^>]*w:left="([1-9]\d*)"/u.test(properties),
      runs: runsOf(inner),
    };
  });
}

function tablesOf(xml) {
  return [...xml.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/gu)].map((match) => {
    const inner = match[1];
    const rows = [...inner.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/gu)].map((row) => {
      const cells = [...row[1].matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/gu)].map((cell) => ({
        text: textOf(cell[1]),
        fill: attr(cell[1], 'w:shd', 'fill'),
        gridSpan: Number(attr(cell[1], 'w:gridSpan', 'val') ?? 1),
        verticalMerge: /<w:vMerge/u.test(cell[1]),
      }));
      return cells;
    });
    return {
      rows: rows.length,
      columns: rows[0]?.length ?? 0,
      cells: rows.flat(),
      borders: /<w:tblBorders>/u.test(inner),
    };
  });
}

function imagesOf(xml) {
  return [...xml.matchAll(/<wp:extent\s+cx="(\d+)"\s+cy="(\d+)"/gu)].map((match) => ({
    width: Number(match[1]),
    height: Number(match[2]),
  }));
}

/** Read a .docx into a profile of what it holds. */
export function profileDocx(buffer) {
  const parts = unzipSync(new Uint8Array(buffer));
  const read = (name) => (parts[name] ? strFromU8(parts[name]) : '');
  const documentXml = read('word/document.xml');

  const headerNames = Object.keys(parts).filter((name) => /^word\/header\d*\.xml$/u.test(name));
  const footerNames = Object.keys(parts).filter((name) => /^word\/footer\d*\.xml$/u.test(name));

  const media = Object.keys(parts).filter((name) => name.startsWith('word/media/'));

  return {
    paragraphs: paragraphsOf(documentXml),
    tables: tablesOf(documentXml),
    images: imagesOf(documentXml),
    mediaFiles: media.length,
    headerText: headerNames.map((name) => textOf(read(name))).filter(Boolean),
    footerText: footerNames.map((name) => textOf(read(name))).filter(Boolean),
    landscape: /w:orient="landscape"/u.test(documentXml),
    text: textOf(documentXml),
  };
}
