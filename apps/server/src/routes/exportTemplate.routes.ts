import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../errors.js';
import { recordAudit } from '../services/audit.js';
import { KNOWN_TOKENS, getExportTemplate, unknownTokensIn, updateExportTemplate } from '../services/exportTemplate.js';

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

const patchSchema = z.object({
  header: headerFooterSchema.optional(),
  footer: headerFooterSchema.optional(),
  headings: z.array(headingSchema).length(6).optional(),
  body: bodySchema.optional(),
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
 * `workflow_groups`: this is configuration, not a document, and nothing
 * here calls the export writer yet -- that is a later phase.
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
}
