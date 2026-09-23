/**
 * The house style for "Standardized" export (docs/17-standardized-export.md):
 * one admin-authored template -- header, footer, six heading levels, body
 * text -- applied uniformly to any document exported this way, regardless
 * of what that document's own formatting is. This is configuration only:
 * phase 1 (this file) reads and writes it; a later phase feeds it into the
 * export writer. Header and footer content may carry a small, fixed set of
 * tokens (`{{document.title}}`, `{{document.type}}`, `{{date}}`, `{{page}}`,
 * `{{pageCount}}`), resolved when the document is actually exported, not
 * here -- this module only validates that a token, if present, is one of
 * these five, so a typo is caught at save time rather than silently
 * producing literal braces in someone's export.
 */
import type { Database } from '../db.js';
import { now } from '../lib/ids.js';

const SINGLETON_ID = 'singleton';
const MAX_CONTENT_LENGTH = 300; // Matches PageSetup's MAX_RUNNING_TEXT.
const MAX_FONT_NAME_LENGTH = 100;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/u;
export const KNOWN_TOKENS = ['document.title', 'document.type', 'date', 'page', 'pageCount'] as const;
const TOKEN_PATTERN = /\{\{\s*([a-zA-Z.]+)\s*\}\}/gu;

export interface HeaderFooterSide {
  content: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
}

export interface HeaderFooterConfig {
  left: HeaderFooterSide;
  right: HeaderFooterSide;
}

export interface HeadingStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  spacingBeforePt: number;
  spacingAfterPt: number;
}

export interface BodyStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
}

/** Applied to every table in the document, overriding its own formatting (docs/17 §4.5) -- the same "override, do not preserve" rule the rest of this template follows. */
export interface TableStyle {
  borderColor: string;
  borderWidthPt: number;
  headerRowBackground: string;
  bandedRows: boolean;
  bandedRowBackground: string;
}

/** One heading level's own look within the table of contents (docs/17 §4.6). Index 0 is TOC1. */
export interface TocLevelStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  indentPt: number;
}

/** Raster only (PNG/JPEG), never SVG -- see migration 0019's comment for why. */
export interface ExportLogo {
  mediaType: 'image/png' | 'image/jpeg';
  dataUrl: string;
}

export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MAX_DIMENSION = 2000;

/** Checks the file's own bytes, not the declared upload mimetype, the same discipline `.docx` import applies to a zip signature. */
export function sniffImageMediaType(bytes: Buffer): ExportLogo['mediaType'] | null {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (bytes.length >= 3 && bytes.readUInt16BE(0) === 0xffd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

export interface ExportTemplate {
  header: HeaderFooterConfig;
  footer: HeaderFooterConfig;
  /** Index 0 is Heading 1, ... index 5 is Heading 6. */
  headings: HeadingStyle[];
  body: BodyStyle;
  /** Footer, left side (docs/17 §4.2). Set and cleared through its own upload route, not the JSON patch. */
  logo: ExportLogo | null;
  table: TableStyle;
  /** Index 0 is TOC1, index 1 is TOC2, index 2 is TOC3. */
  toc: TocLevelStyle[];
  updatedAt: string;
  updatedBy: string | null;
}

const defaultSide = (content = ''): HeaderFooterSide => ({
  content,
  fontFamily: 'Carlito',
  fontSize: 10,
  color: '#000000',
  bold: false,
  italic: false,
});

const defaultHeading = (fontSize: number, extra: Partial<HeadingStyle> = {}): HeadingStyle => ({
  fontFamily: 'Carlito',
  fontSize,
  color: '#4472C4',
  bold: true,
  italic: false,
  spacingBeforePt: 12,
  spacingAfterPt: 6,
  ...extra,
});

const defaultTableStyle = (): TableStyle => ({
  borderColor: '#BFBFBF',
  borderWidthPt: 0.5,
  headerRowBackground: '#D9E2F3',
  bandedRows: true,
  bandedRowBackground: '#F2F2F2',
});

const defaultTocLevel = (indentPt: number): TocLevelStyle => ({
  fontFamily: 'Carlito',
  fontSize: 11,
  color: '#000000',
  indentPt,
});

/**
 * A reasonable, considered starting point rather than placeholder values
 * nobody would choose: Carlito throughout (the metric-compatible, freely
 * licensed stand-in for Calibri -- see `CLAUDE.md`'s licence invariant), a
 * light blue for headings, black body text, sizes in the 10-20pt range.
 */
export function defaultExportTemplate(): ExportTemplate {
  return {
    header: { left: defaultSide(), right: defaultSide() },
    footer: { left: defaultSide(), right: defaultSide('{{page}} of {{pageCount}}') },
    headings: [
      defaultHeading(20),
      defaultHeading(16),
      defaultHeading(14),
      defaultHeading(12, { italic: true }),
      defaultHeading(11, { color: '#000000', bold: false }),
      defaultHeading(11, { color: '#000000', bold: false, italic: true }),
    ],
    body: { fontFamily: 'Carlito', fontSize: 11, color: '#000000' },
    logo: null,
    table: defaultTableStyle(),
    toc: [defaultTocLevel(0), defaultTocLevel(12), defaultTocLevel(24)],
    updatedAt: now(),
    updatedBy: null,
  };
}

function asString(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : fallback;
}
function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}
function asColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : fallback;
}
function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function sideFrom(value: unknown, fallback: HeaderFooterSide): HeaderFooterSide {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    content: asString(raw['content'], fallback.content, MAX_CONTENT_LENGTH),
    fontFamily: asString(raw['fontFamily'], fallback.fontFamily, MAX_FONT_NAME_LENGTH),
    fontSize: asNumber(raw['fontSize'], fallback.fontSize, 6, 96),
    color: asColor(raw['color'], fallback.color),
    bold: asBool(raw['bold'], fallback.bold),
    italic: asBool(raw['italic'], fallback.italic),
  };
}

function headerFooterFrom(value: unknown, fallback: HeaderFooterConfig): HeaderFooterConfig {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    left: sideFrom(raw['left'], fallback.left),
    right: sideFrom(raw['right'], fallback.right),
  };
}

function headingFrom(value: unknown, fallback: HeadingStyle): HeadingStyle {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    fontFamily: asString(raw['fontFamily'], fallback.fontFamily, MAX_FONT_NAME_LENGTH),
    fontSize: asNumber(raw['fontSize'], fallback.fontSize, 6, 96),
    color: asColor(raw['color'], fallback.color),
    bold: asBool(raw['bold'], fallback.bold),
    italic: asBool(raw['italic'], fallback.italic),
    spacingBeforePt: asNumber(raw['spacingBeforePt'], fallback.spacingBeforePt, 0, 144),
    spacingAfterPt: asNumber(raw['spacingAfterPt'], fallback.spacingAfterPt, 0, 144),
  };
}

function bodyFrom(value: unknown, fallback: BodyStyle): BodyStyle {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    fontFamily: asString(raw['fontFamily'], fallback.fontFamily, MAX_FONT_NAME_LENGTH),
    fontSize: asNumber(raw['fontSize'], fallback.fontSize, 6, 96),
    color: asColor(raw['color'], fallback.color),
  };
}

function tableStyleFrom(value: unknown, fallback: TableStyle): TableStyle {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    borderColor: asColor(raw['borderColor'], fallback.borderColor),
    borderWidthPt: asNumber(raw['borderWidthPt'], fallback.borderWidthPt, 0.25, 6),
    headerRowBackground: asColor(raw['headerRowBackground'], fallback.headerRowBackground),
    bandedRows: asBool(raw['bandedRows'], fallback.bandedRows),
    bandedRowBackground: asColor(raw['bandedRowBackground'], fallback.bandedRowBackground),
  };
}

function tocLevelFrom(value: unknown, fallback: TocLevelStyle): TocLevelStyle {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    fontFamily: asString(raw['fontFamily'], fallback.fontFamily, MAX_FONT_NAME_LENGTH),
    fontSize: asNumber(raw['fontSize'], fallback.fontSize, 6, 96),
    color: asColor(raw['color'], fallback.color),
    indentPt: asNumber(raw['indentPt'], fallback.indentPt, 0, 144),
  };
}

/**
 * Never throws: an unreadable or missing field falls back to the default
 * rather than refusing the whole row. Parses the text fields only -- the
 * logo is binary, set and cleared through its own route, and every caller
 * here is responsible for carrying the real current `logo` value through
 * afterwards rather than letting it reset to null.
 */
export function exportTemplateFrom(value: unknown, updatedAt: string, updatedBy: string | null): ExportTemplate {
  const raw = (value ?? {}) as Record<string, unknown>;
  const fallback = defaultExportTemplate();
  const headingsRaw = Array.isArray(raw['headings']) ? (raw['headings'] as unknown[]) : [];
  const tocRaw = Array.isArray(raw['toc']) ? (raw['toc'] as unknown[]) : [];
  return {
    header: headerFooterFrom(raw['header'], fallback.header),
    footer: headerFooterFrom(raw['footer'], fallback.footer),
    headings: fallback.headings.map((defaultLevel, index) => headingFrom(headingsRaw[index], defaultLevel)),
    body: bodyFrom(raw['body'], fallback.body),
    logo: fallback.logo,
    table: tableStyleFrom(raw['table'], fallback.table),
    toc: fallback.toc.map((defaultLevel, index) => tocLevelFrom(tocRaw[index], defaultLevel)),
    updatedAt,
    updatedBy,
  };
}

/** Every token in `content` must be one this codebase actually resolves, caught here rather than at export time. */
export function unknownTokensIn(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(TOKEN_PATTERN)) {
    const token = match[1] ?? '';
    if (!(KNOWN_TOKENS as readonly string[]).includes(token)) found.add(token);
  }
  return [...found];
}

interface ExportTemplateRow {
  header: string;
  footer: string;
  headings: string;
  body: string;
  logo_media_type: string | null;
  logo_bytes: Uint8Array | null;
  table_style: string;
  toc: string;
  updated_at: string;
  updated_by: string | null;
}

function getRow(db: Database): ExportTemplateRow | undefined {
  return db.prepare('SELECT * FROM export_template WHERE id = ?').get(SINGLETON_ID) as
    | ExportTemplateRow
    | undefined;
}

function logoFrom(row: Pick<ExportTemplateRow, 'logo_media_type' | 'logo_bytes'> | undefined): ExportLogo | null {
  if (!row?.logo_bytes || !row.logo_media_type) return null;
  const mediaType = row.logo_media_type === 'image/png' || row.logo_media_type === 'image/jpeg' ? row.logo_media_type : null;
  if (!mediaType) return null;
  return { mediaType, dataUrl: `data:${mediaType};base64,${Buffer.from(row.logo_bytes).toString('base64')}` };
}

export function getExportTemplate(db: Database): ExportTemplate {
  const row = getRow(db);
  if (!row) return defaultExportTemplate();
  return {
    ...exportTemplateFrom(
      {
        header: JSON.parse(row.header),
        footer: JSON.parse(row.footer),
        headings: JSON.parse(row.headings),
        body: JSON.parse(row.body),
        table: JSON.parse(row.table_style),
        toc: JSON.parse(row.toc),
      },
      row.updated_at,
      row.updated_by,
    ),
    logo: logoFrom(row),
  };
}

export type ExportTemplatePatch = Partial<
  Pick<ExportTemplate, 'header' | 'footer' | 'headings' | 'body' | 'table' | 'toc'>
>;

export function updateExportTemplate(db: Database, patch: ExportTemplatePatch, actorId: string): ExportTemplate {
  const current = getExportTemplate(db);
  const merged = exportTemplateFrom({ ...current, ...patch }, now(), actorId);
  db.prepare(
    `INSERT INTO export_template (id, header, footer, headings, body, table_style, toc, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       header = excluded.header, footer = excluded.footer, headings = excluded.headings,
       body = excluded.body, table_style = excluded.table_style, toc = excluded.toc,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(
    SINGLETON_ID,
    JSON.stringify(merged.header),
    JSON.stringify(merged.footer),
    JSON.stringify(merged.headings),
    JSON.stringify(merged.body),
    JSON.stringify(merged.table),
    JSON.stringify(merged.toc),
    merged.updatedAt,
    merged.updatedBy,
  );
  // This route never touches the logo; carry the real one through rather
  // than the `null` `exportTemplateFrom` had to fill in to satisfy the type.
  return { ...merged, logo: current.logo };
}

/** Sets the footer's logo, leaving every text field as it was. Bootstraps the row with defaults if nobody has saved one yet. */
export function setExportTemplateLogo(
  db: Database,
  mediaType: ExportLogo['mediaType'],
  bytes: Buffer,
  actorId: string,
): ExportTemplate {
  const current = getExportTemplate(db);
  db.prepare(
    `INSERT INTO export_template (id, header, footer, headings, body, logo_media_type, logo_bytes, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       logo_media_type = excluded.logo_media_type, logo_bytes = excluded.logo_bytes,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(
    SINGLETON_ID,
    JSON.stringify(current.header),
    JSON.stringify(current.footer),
    JSON.stringify(current.headings),
    JSON.stringify(current.body),
    mediaType,
    bytes,
    now(),
    actorId,
  );
  return getExportTemplate(db);
}

export function clearExportTemplateLogo(db: Database, actorId: string): ExportTemplate {
  const current = getExportTemplate(db);
  db.prepare(
    `INSERT INTO export_template (id, header, footer, headings, body, logo_media_type, logo_bytes, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       logo_media_type = NULL, logo_bytes = NULL, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(
    SINGLETON_ID,
    JSON.stringify(current.header),
    JSON.stringify(current.footer),
    JSON.stringify(current.headings),
    JSON.stringify(current.body),
    now(),
    actorId,
  );
  return getExportTemplate(db);
}
