import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, payloadTooLarge, unsupportedMedia } from '../errors.js';
import { recordAudit } from '../services/audit.js';
import {
  KNOWN_TOKENS,
  LOGO_MAX_BYTES,
  LOGO_MAX_DIMENSION,
  clearExportTemplateLogo,
  getExportTemplate,
  setExportTemplateLogo,
  sniffImageMediaType,
  unknownTokensIn,
  updateExportTemplate,
} from '../services/exportTemplate.js';
import { measureImage } from '../docx/imageSize.js';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/u, 'Must be a hex colour, e.g. #4472C4');

const sideSchema = z.object({
  content: z.string().max(300),
  fontFamily: z.string().trim().min(1).max(100),
  fontSize: z.number().min(6).max(96),
  color: hexColor,
  bold: z.boolean(),
  italic: z.boolean(),
});
const headerFooterSchema = z.object({ left: sideSchema, right: sideSchema });
const headingSchema = z.object({
  fontFamily: z.string().trim().min(1).max(100),
  fontSize: z.number().min(6).max(96),
  color: hexColor,
  bold: z.boolean(),
  italic: z.boolean(),
  spacingBeforePt: z.number().min(0).max(144),
  spacingAfterPt: z.number().min(0).max(144),
});
const bodySchema = z.object({
  fontFamily: z.string().trim().min(1).max(100),
  fontSize: z.number().min(6).max(96),
  color: hexColor,
});
const tableSchema = z.object({
  borderColor: hexColor,
  borderWidthPt: z.number().min(0.25).max(6),
  headerRowBackground: hexColor,
  bandedRows: z.boolean(),
  bandedRowBackground: hexColor,
});
const tocLevelSchema = z.object({
  fontFamily: z.string().trim().min(1).max(100),
  fontSize: z.number().min(6).max(96),
  color: hexColor,
  indentPt: z.number().min(0).max(144),
});

const patchSchema = z.object({
  header: headerFooterSchema.optional(),
  footer: headerFooterSchema.optional(),
  headings: z.array(headingSchema).length(6).optional(),
  body: bodySchema.optional(),
  table: tableSchema.optional(),
  toc: z.array(tocLevelSchema).length(3).optional(),
});

function checkTokens(...contents: (string | undefined)[]): void {
  const bad = new Set<string>();
  for (const content of contents) {
    if (content === undefined) continue;
    for (const token of unknownTokensIn(content)) bad.add(token);
  }
  if (bad.size > 0) {
    throw badRequest(
      `Unknown token${bad.size > 1 ? 's' : ''} ${[...bad].map((t) => `{{${t}}}`).join(', ')}. ` +
        `Known tokens: ${KNOWN_TOKENS.map((t) => `{{${t}}}`).join(', ')}.`,
    );
  }
}

/**
 * The house style for "Standardized" export (docs/17-standardized-export.md).
 * Admin-only to read and write, the same as `llm_endpoints` and
 * `workflow_groups`: this is configuration, read at export time by
 * `docx/standardTemplate.ts` and `ooxml/write.ts`, not something exported
 * from here.
 */
export async function registerExportTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/export-template', async (request) => {
    await app.requireAdmin(request);
    return { template: getExportTemplate(app.db) };
  });

  app.patch('/export-template', async (request) => {
    const actor = await app.requireAdmin(request);
    const body = patchSchema.parse(request.body);
    checkTokens(
      body.header?.left.content,
      body.header?.right.content,
      body.footer?.left.content,
      body.footer?.right.content,
    );
    const updated = updateExportTemplate(app.db, body, actor.id);
    recordAudit(app.db, {
      actorId: actor.id,
      action: 'export_template.updated',
      targetType: 'export_template',
      detail: { sections: Object.keys(body) },
      ip: request.ip,
    });
    return { template: updated };
  });

  app.post('/export-template/logo', async (request) => {
    const actor = await app.requireAdmin(request);
    const file = await request.file();
    if (!file) throw badRequest('Attach a PNG or JPEG image.');
    const buffer = await file.toBuffer();
    if (file.file.truncated || buffer.length > LOGO_MAX_BYTES) {
      throw payloadTooLarge(`The logo must be under ${Math.round(LOGO_MAX_BYTES / 1024)} KB.`);
    }
    if (buffer.length === 0) throw badRequest('That file is empty.');
    // The file's own bytes decide the type, not the declared upload
    // mimetype or its extension -- the same discipline `.docx` import
    // applies to a zip signature. SVG is refused by construction: it never
    // matches either magic-byte check, so it never needs a special case
    // (docs/17-standardized-export.md §4.2 -- no sanitizer exists for it).
    const mediaType = sniffImageMediaType(buffer);
    if (!mediaType) throw unsupportedMedia('The logo must be a PNG or JPEG image.');
    const size = measureImage(`data:${mediaType};base64,${buffer.toString('base64')}`);
    if (!size || size.width > LOGO_MAX_DIMENSION || size.height > LOGO_MAX_DIMENSION) {
      throw badRequest(`The logo must be ${LOGO_MAX_DIMENSION}×${LOGO_MAX_DIMENSION} pixels or smaller.`);
    }
    const updated = setExportTemplateLogo(app.db, mediaType, buffer, actor.id);
    recordAudit(app.db, {
      actorId: actor.id,
      action: 'export_template.updated',
      targetType: 'export_template',
      detail: { sections: ['logo'] },
      ip: request.ip,
    });
    return { template: updated };
  });

  app.delete('/export-template/logo', async (request) => {
    const actor = await app.requireAdmin(request);
    const updated = clearExportTemplateLogo(app.db, actor.id);
    recordAudit(app.db, {
      actorId: actor.id,
      action: 'export_template.updated',
      targetType: 'export_template',
      detail: { sections: ['logo'], removed: true },
      ip: request.ip,
    });
    return { template: updated };
  });
}
