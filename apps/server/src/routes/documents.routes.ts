import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { toPlainText } from '@docforge/model';
import { badRequest, notFound, payloadTooLarge, unsupportedMedia } from '../errors.js';
import { exportDocx, safeFileName } from '../docx/export.js';
import { importDocx, titleFromFileName } from '../docx/import.js';
import { recordAudit } from '../services/audit.js';
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

      const { content, messages, meta, fragments, styles } = await importDocx(buffer);
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
    return { document: getDocument(app.db, user, id) };
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
      const { format } = z
        .object({ format: z.enum(['docx', 'txt', 'original']).default('docx') })
        .parse(request.query ?? {});
      const document = getDocument(app.db, user, id);

      recordAudit(app.db, {
        actorId: user.id,
        action: 'document.exported',
        targetType: 'document',
        targetId: id,
        detail: { format },
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
      });
      const fileName = safeFileName(document.title, 'docx');
      return reply
        .header('Content-Type', DOCX_MIME)
        .header('Content-Disposition', contentDisposition(fileName))
        .header('Content-Length', String(buffer.length))
        .send(buffer);
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
