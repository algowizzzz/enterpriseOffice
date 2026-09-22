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

export interface ExportTemplate {
  header: HeaderFooterConfig;
  footer: HeaderFooterConfig;
  /** Index 0 is Heading 1, ... index 5 is Heading 6. */
  headings: HeadingStyle[];
  body: BodyStyle;
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

/** Never throws: an unreadable or missing field falls back to the default rather than refusing the whole row. */
export function exportTemplateFrom(value: unknown, updatedAt: string, updatedBy: string | null): ExportTemplate {
  const raw = (value ?? {}) as Record<string, unknown>;
  const fallback = defaultExportTemplate();
  const headingsRaw = Array.isArray(raw['headings']) ? (raw['headings'] as unknown[]) : [];
  return {
    header: headerFooterFrom(raw['header'], fallback.header),
    footer: headerFooterFrom(raw['footer'], fallback.footer),
    headings: fallback.headings.map((defaultLevel, index) => headingFrom(headingsRaw[index], defaultLevel)),
    body: bodyFrom(raw['body'], fallback.body),
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
  updated_at: string;
  updated_by: string | null;
}

export function getExportTemplate(db: Database): ExportTemplate {
  const row = db.prepare('SELECT * FROM export_template WHERE id = ?').get(SINGLETON_ID) as
    | ExportTemplateRow
    | undefined;
  if (!row) return defaultExportTemplate();
  return exportTemplateFrom(
    {
      header: JSON.parse(row.header),
      footer: JSON.parse(row.footer),
      headings: JSON.parse(row.headings),
      body: JSON.parse(row.body),
    },
    row.updated_at,
    row.updated_by,
  );
}

export type ExportTemplatePatch = Partial<Pick<ExportTemplate, 'header' | 'footer' | 'headings' | 'body'>>;

export function updateExportTemplate(db: Database, patch: ExportTemplatePatch, actorId: string): ExportTemplate {
  const current = getExportTemplate(db);
  const next = exportTemplateFrom({ ...current, ...patch }, now(), actorId);
  db.prepare(
    `INSERT INTO export_template (id, header, footer, headings, body, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       header = excluded.header, footer = excluded.footer, headings = excluded.headings,
       body = excluded.body, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(
    SINGLETON_ID,
    JSON.stringify(next.header),
    JSON.stringify(next.footer),
    JSON.stringify(next.headings),
    JSON.stringify(next.body),
    next.updatedAt,
    next.updatedBy,
  );
  return next;
}
