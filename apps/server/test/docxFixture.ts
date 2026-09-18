import { zipSync, strToU8 } from 'fflate';

/**
 * Build a .docx from raw parts.
 *
 * The importer reads the markup itself now, so hostile or merely unusual input
 * has to be written as markup rather than as HTML. This keeps the tests honest:
 * what they hand the reader is the shape a real file has.
 */
export interface FixtureParts {
  /** The contents of `w:body`, without the body element itself. */
  body?: string;
  styles?: string;
  numbering?: string;
  /** Relationship entries, as id to target. */
  relationships?: Record<string, { target: string; external?: boolean }>;
  /** Picture parts, keyed by name inside `word/media`. */
  media?: Record<string, Uint8Array>;
  headers?: string[];
  footers?: string[];
  /** Replaces the whole document part, for markup that is not a body at all. */
  documentXml?: string;
}

const NAMESPACES =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

export function docxFixture(parts: FixtureParts): Buffer {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    ),
    'word/document.xml': strToU8(
      parts.documentXml ??
        `<?xml version="1.0"?><w:document ${NAMESPACES}><w:body>${parts.body ?? ''}</w:body></w:document>`,
    ),
  };

  if (parts.styles) files['word/styles.xml'] = strToU8(parts.styles);
  if (parts.numbering) files['word/numbering.xml'] = strToU8(parts.numbering);

  const relationships = Object.entries(parts.relationships ?? {})
    .map(
      ([id, entry]) =>
        `<Relationship Id="${id}" Target="${entry.target}"${entry.external ? ' TargetMode="External"' : ''}/>`,
    )
    .join('');
  files['word/_rels/document.xml.rels'] = strToU8(
    `<?xml version="1.0"?><Relationships>${relationships}</Relationships>`,
  );

  for (const [name, bytes] of Object.entries(parts.media ?? {})) {
    files[`word/media/${name}`] = bytes;
  }
  (parts.headers ?? []).forEach((xml, index) => {
    files[`word/header${index + 1}.xml`] = strToU8(xml);
  });
  (parts.footers ?? []).forEach((xml, index) => {
    files[`word/footer${index + 1}.xml`] = strToU8(xml);
  });

  return Buffer.from(zipSync(files));
}

/** A paragraph of plain text, with optional paragraph properties. */
export const p = (text: string, properties = ''): string =>
  `<w:p>${properties}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

/** A picture of the given part, shown at the given size in pixels. */
export const drawing = (id: string, width = 100, height = 100): string =>
  `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="${width * 9525}" cy="${height * 9525}"/>` +
  `<wp:docPr id="1" name="Picture"/><a:graphic><a:graphicData><a:blip r:embed="${id}"/>` +
  `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

/** A one-pixel PNG, as bytes. */
export const PNG_BYTES = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);
