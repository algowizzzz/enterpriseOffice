import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  acceptAllChanges,
  compareDocuments,
  rejectAllChanges,
  toPlainText,
  type PMNode,
} from '@docforge/model';
import { badRequest, notFound, payloadTooLarge, unsupportedMedia } from '../errors.js';
import { exportDocx, safeFileName } from '../docx/export.js';
import { importDocx, titleFromFileName } from '../docx/import.js';
import { recordAudit } from '../services/audit.js';
import { addComment, listThreads } from '../services/comments.js';
import { collabEpoch } from '../collab/rooms.js';
import {
  createDocument,
  deleteDocument,
  getDocument,
  getSource,
  getVersionContent,
  listDocuments,
  listShares,
  listVersions,
  restoreVersion,
  saveSource,
  shareDocument,
  unshareDocument,
  updateDocument,
} from '../services/documents.js';

const idParam = z.object({ id: z.string().uuid() });

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * What changed between two revisions, written as tracked changes signed by the
 * person asking. Changes already tracked in either revision are settled first:
 * a comparison is between what each version says, not between their markup.
 */
function redline(
  db: FastifyInstance['db'],
  user: { id: string; role: 'admin' | 'editor' | 'viewer'; name: string },
  id: string,
  from: number,
  to: number | undefined,
  current: { content: PMNode; revision: number },
): PMNode {
  const before = acceptAllChanges(getVersionContent(db, user, id, from));
  const after = acceptAllChanges(
    to === undefined || to === current.revision ? current.content : getVersionContent(db, user, id, to),
  );
  return compareDocuments(before, after, { author: user.name, date: new Date().toISOString() });
}

export async function registerDocumentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/documents', async (request) => {
    const user = await app.authenticate(request);
    return { documents: listDocuments(app.db, user) };
  });

  /** Create a blank document, or one seeded with supplied content. */
  app.post('/documents', async (request, reply) => {
    const user = await app.authenticate(request);
    if (user.role === 'viewer') throw badRequest('Your account cannot create documents');
    const body = z
      .object({
        title: z.string().max(300).optional(),
        content: z.unknown().optional(),
        pageSetup: z.unknown().optional(),
      })
      .parse(request.body ?? {});
    const document = createDocument(app.db, user, {
      title: body.title,
      content: body.content,
      pageSetup: body.pageSetup,
      origin: 'blank',
    });
    recordAudit(app.db, {
      actorId: user.id,
      action: 'document.created',
      targetType: 'document',
      targetId: document.id,
      detail: { title: document.title },
      ip: request.ip,
    });
    return reply.code(201).send({ document });
  });

  /** Upload a .docx and convert it into a new editable document. */
  // Converting a Word file is CPU bound and holds the single-threaded server
  // while it runs, so this route is limited even though the caller is signed in.
  app.post(
    '/documents/import',
    { config: { rateLimit: { max: app.config.importRateLimit, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const user = await app.authenticate(request);
      if (user.role === 'viewer') throw badRequest('Your account cannot create documents');

      const file = await request.file();
      if (!file) throw badRequest('Attach a .docx file to upload');
      const isDocx =
        file.mimetype === DOCX_MIME ||
        file.mimetype === 'application/octet-stream' ||
        /\.docx$/iu.test(file.filename ?? '');
      if (!isDocx) {
        throw unsupportedMedia('Only .docx files can be uploaded. Convert .doc files first.');
      }

      const buffer = await file.toBuffer();
      if (file.file.truncated || buffer.length > app.config.maxUploadBytes) {
        throw payloadTooLarge('That file is larger than the upload limit.');
      }
      if (buffer.length === 0) throw badRequest('That file is empty');

      const { content, messages, meta, fragments, styles, comments } = await importDocx(buffer);
      const created = createDocument(app.db, user, {
        title: titleFromFileName(file.filename ?? 'Imported document'),
        content,
        // The header, the footer and the orientation the file arrived with.
        pageSetup: meta,
        origin: 'import',
        sourceName: file.filename,
      });
      // The file itself, kept so the export can patch it rather than rebuild
      // it, and so the original can be downloaded again.
      saveSource(app.db, created.id, {
        fileName: file.filename ?? 'document.docx',
        mediaType: DOCX_MIME,
        bytes: buffer,
        fragments: fragments ?? {},
        styles: styles ?? null,
        pageSetup: created.pageSetup,
      });
      // The review comments the file carried, signed as Word signed them.
      const imported = new Map<string, string>();
      for (const comment of comments ?? []) {
        const parentId = comment.parentWordId ? imported.get(comment.parentWordId) : undefined;
        if (comment.parentWordId && !parentId) continue;
        const added = addComment(app.db, user, created.id, {
          body: comment.body,
          parentId,
          anchor: comment.anchor ?? undefined,
          authorName: comment.author,
          createdAt: comment.date ?? undefined,
          resolved: comment.resolved,
        });
        imported.set(comment.wordId, added.id);
      }
      const document = { ...created, styles: styles ?? null };
      recordAudit(app.db, {
        actorId: user.id,
        action: 'document.imported',
        targetType: 'document',
        targetId: document.id,
        detail: { sourceName: file.filename, bytes: buffer.length, words: document.wordCount },
        ip: request.ip,
      });
      return reply.code(201).send({ document, messages });
    },
  );

  app.get('/documents/:id', async (request) => {
    const user = await app.authenticate(request);
    const { id } = idParam.parse(request.params);
    const document = getDocument(app.db, user, id);
    // Which shared document to join, for the browser's collaboration socket.
    return { document: { ...document, collab: { epoch: collabEpoch(app.db, id) } } };
  });

  app.put('/documents/:id', async (request) => {
    const user = await app.authenticate(request);
    const { id } = idParam.parse(request.params);
    const body = z
      .object({
        title: z.string().max(300).optional(),
        content: z.unknown().optional(),
        pageSetup: z.unknown().optional(),
        expectedRevision: z.number().int().positive().optional(),
      })
      .parse(request.body ?? {});
    if (body.title === undefined && body.content === undefined && body.pageSetup === undefined) {
      throw badRequest('Nothing to update');
    }
    const document = updateDocument(app.db, user, id, body);
    // Content written here did not come through the shared document, so whoever
    // has it open together is now looking at something else. The editor itself
    // only sends the title and the page setup this way.
    if (body.content !== undefined) app.rooms.reset(id);
    recordAudit(app.db, {
      actorId: user.id,
      action: body.content === undefined ? 'document.renamed' : 'document.updated',
      targetType: 'document',
      targetId: id,
      detail: { revision: document.revision },
      ip: request.ip,
    });
    return { document };
  });

  app.delete('/documents/:id', async (request) => {
    const user = await app.authenticate(request);
    const { id } = idParam.parse(request.params);
    deleteDocument(app.db, user, id);
    recordAudit(app.db, {
      actorId: user.id,
      action: 'document.deleted',
      targetType: 'document',
      targetId: id,
      ip: request.ip,
    });
    return { ok: true };
  });

  /** Download the document as .docx or as plain text. */
  // Writing a Word file costs as much as reading one: the whole document is
  // parsed, every picture is decoded, and the packer runs on the event loop.
  // Leaving this unlimited let anyone with even a view share stall the instance
  // by asking for the same large document over and over.
  app.get(
    '/documents/:id/export',
    { config: { rateLimit: { max: app.config.exportRateLimit, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const user = await app.authenticate(request);
      const { id } = idParam.parse(request.params);
      const { format, changes, compare } = z
        .object({
          format: z.enum(['docx', 'txt', 'original']).default('docx'),
          // Tracked changes as they stand, or the document with all of them
          // accepted (the "final") or all of them rejected.
          changes: z.enum(['markup', 'accepted', 'rejected']).default('markup'),
          // A redline against an earlier revision, as "3" or "3:7".
          compare: z
            .string()
            .regex(/^\d{1,9}(?::\d{1,9})?$/u)
            .optional(),
        })
        .parse(request.query ?? {});
      const stored = getDocument(app.db, user, id);
      let content: PMNode = stored.content;
      if (compare) {
        const [from, to] = compare.split(':').map(Number) as [number, number | undefined];
        content = redline(app.db, user, id, from, to, stored);
      } else if (changes === 'accepted') content = acceptAllChanges(content);
      else if (changes === 'rejected') content = rejectAllChanges(content);
      const document = { ...stored, content };

      recordAudit(app.db, {
        actorId: user.id,
        action: 'document.exported',
        targetType: 'document',
        targetId: id,
        detail: { format, ...(compare ? { compare } : {}), ...(changes !== 'markup' ? { changes } : {}) },
        ip: request.ip,
      });

      if (format === 'txt') {
        const fileName = safeFileName(document.title, 'txt');
        return reply
          .header('Content-Type', 'text/plain; charset=utf-8')
          .header('Content-Disposition', contentDisposition(fileName))
          .send(toPlainText(document.content));
      }

      const source = getSource(app.db, id);
      if (format === 'original') {
        // The upload, byte for byte, under the name it arrived with.
        if (!source) throw notFound('This document was not uploaded, so it has no original file.');
        return reply
          .header('Content-Type', source.mediaType)
          .header('Content-Disposition', contentDisposition(safeFileName(source.fileName.replace(/\.[^.]+$/u, ''), source.fileName.split('.').pop() ?? 'docx')))
          .header('Content-Length', String(source.bytes.length))
          .send(source.bytes);
      }

      const buffer = await exportDocx(document.content, {
        title: document.title,
        author: user.name,
        pageSetup: document.pageSetup,
        source: source?.package,
        fragments: source?.fragments,
        originalSetup: source?.pageSetup,
        comments: listThreads(app.db, user, id).map((thread) => ({
          author: thread.authorName,
          date: thread.createdAt,
          body: thread.body,
          anchor: thread.anchor,
          resolved: thread.resolvedAt !== null,
          replies: thread.replies.map((reply) => ({
            author: reply.authorName,
            date: reply.createdAt,
            body: reply.body,
          })),
        })),
      });
      const fileName = safeFileName(document.title, 'docx');
      return reply
        .header('Content-Type', DOCX_MIME)
        .header('Content-Disposition', contentDisposition(fileName))
        .header('Content-Length', String(buffer.length))
        .send(buffer);
    },
  );

  /** A redline: what changed between two revisions, as tracked changes. */
  app.get(
    '/documents/:id/compare',
    { config: { rateLimit: { max: app.config.exportRateLimit, timeWindow: '1 minute' } } },
    async (request) => {
      const user = await app.authenticate(request);
      const { id } = idParam.parse(request.params);
      const { from, to } = z
        .object({
          from: z.coerce.number().int().positive().default(1),
          to: z.coerce.number().int().positive().optional(),
        })
        .parse(request.query ?? {});
      const stored = getDocument(app.db, user, id);
      return { from, to: to ?? stored.revision, content: redline(app.db, user, id, from, to, stored) };
    },
  );

  app.get('/documents/:id/versions', async (request) => {
    const user = await app.authenticate(request);
    const { id } = idParam.parse(request.params);
    return { versions: listVersions(app.db, user, id) };
  });

  app.get('/documents/:id/versions/:revision', async (request) => {
    const user = await app.authenticate(request);
    const params = z
      .object({ id: z.string().uuid(), revision: z.coerce.number().int().positive() })
      .parse(request.params);
    return { content: getVersionContent(app.db, user, params.id, params.revision) };
  });

  app.post('/documents/:id/versions/:revision/restore', async (request) => {
    const user = await app.authenticate(request);
    const params = z
      .object({ id: z.string().uuid(), revision: z.coerce.number().int().positive() })
      .parse(request.params);
    const document = restoreVersion(app.db, user, params.id, params.revision);
    app.rooms.reset(params.id);
    recordAudit(app.db, {
      actorId: user.id,
      action: 'document.restored',
      targetType: 'document',
      targetId: params.id,
      detail: { restoredFrom: params.revision, revision: document.revision },
      ip: request.ip,
    });
    return { document };
  });

  app.get('/documents/:id/shares', async (request) => {
    const user = await app.authenticate(request);
    const { id } = idParam.parse(request.params);
    return { shares: listShares(app.db, user, id) };
  });

  app.put('/documents/:id/shares', async (request) => {
    const user = await app.authenticate(request);
    const { id } = idParam.parse(request.params);
    const body = z
      .object({ userId: z.string().uuid(), permission: z.enum(['view', 'edit']) })
      .parse(request.body);
    shareDocument(app.db, user, id, body.userId, body.permission);
    recordAudit(app.db, {
      actorId: user.id,
      action: 'document.shared',
      targetType: 'document',
      targetId: id,
      detail: body,
      ip: request.ip,
    });
    return { shares: listShares(app.db, user, id) };
  });

  app.delete('/documents/:id/shares/:userId', async (request) => {
    const user = await app.authenticate(request);
    const params = z
      .object({ id: z.string().uuid(), userId: z.string().uuid() })
      .parse(request.params);
    unshareDocument(app.db, user, params.id, params.userId);
    recordAudit(app.db, {
      actorId: user.id,
      action: 'document.unshared',
      targetType: 'document',
      targetId: params.id,
      detail: { userId: params.userId },
      ip: request.ip,
    });
    return { shares: listShares(app.db, user, params.id) };
  });
}

/** RFC 6266 disposition with an ASCII fallback for non-Latin titles. */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/gu, '_').replace(/"/gu, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
