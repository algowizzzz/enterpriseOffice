import { createHash } from 'node:crypto';
import { NODE, storedImageHash, storedImageSrc, type PMNode } from '@docforge/model';
import type { Database } from '../db.js';
import { now } from '../lib/ids.js';
import { accessFor } from './documents.js';
import type { Role } from './users.js';

const DATA_URI = /^data:(image\/(?:png|jpe?g|gif|bmp));base64,(.+)$/isu;

/**
 * Pictures smaller than this stay inside the document. Moving a two-kilobyte
 * icon out would cost a request to fetch it and save nothing worth saving.
 */
export const KEEP_INLINE_BELOW = 64 * 1024;

export interface StoredPicture {
  hash: string;
  mediaType: string;
  bytes: Buffer;
}

/**
 * Take the pictures out of a document and leave their addresses behind.
 * Returns the lighter document and the pictures to keep.
 */
export function takePicturesOut(doc: PMNode, threshold = KEEP_INLINE_BELOW): { doc: PMNode; pictures: StoredPicture[] } {
  const pictures = new Map<string, StoredPicture>();
  const visit = (node: PMNode): PMNode => {
    if (node.type === NODE.image && typeof node.attrs?.['src'] === 'string') {
      const match = node.attrs['src'].length > threshold ? DATA_URI.exec(node.attrs['src']) : null;
      if (match) {
        const bytes = Buffer.from(match[2] as string, 'base64');
        const hash = createHash('sha256').update(bytes).digest('hex');
        pictures.set(hash, { hash, mediaType: (match[1] as string).toLowerCase().replace('image/jpg', 'image/jpeg'), bytes });
        return { ...node, attrs: { ...node.attrs, src: storedImageSrc(hash) } };
      }
      return node;
    }
    if (!node.content) return node;
    return { ...node, content: node.content.map(visit) };
  };
  return { doc: visit(doc), pictures: [...pictures.values()] };
}

export function savePictures(db: Database, documentId: string, pictures: StoredPicture[]): void {
  const insert = db.prepare(
    'INSERT INTO document_media (document_id, hash, media_type, bytes, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
  );
  for (const picture of pictures) insert.run(documentId, picture.hash, picture.mediaType, picture.bytes, now());
}

/** A picture, for somebody who can read a document it belongs to. */
export function readPicture(db: Database, user: { id: string; role: Role }, hash: string): StoredPicture | null {
  const rows = db.prepare('SELECT document_id, media_type, bytes FROM document_media WHERE hash = ? LIMIT 50').all(hash) as {
    document_id: string;
    media_type: string;
    bytes: Uint8Array;
  }[];
  const row = rows.find((candidate) => accessFor(db, candidate.document_id, user) !== 'none');
  return row ? { hash, mediaType: row.media_type, bytes: Buffer.from(row.bytes) } : null;
}

/**
 * Put the pictures back into a document, for a writer that wants them to hand.
 * `only` limits it to the pictures the writer cannot get any other way.
 */
export function putPicturesBack(db: Database, documentId: string, doc: PMNode, only?: (node: PMNode) => boolean): PMNode {
  const find = db.prepare('SELECT media_type, bytes FROM document_media WHERE document_id = ? AND hash = ?');
  const visit = (node: PMNode): PMNode => {
    const hash = node.type === NODE.image ? storedImageHash(node.attrs?.['src']) : null;
    if (hash && (!only || only(node))) {
      const row = find.get(documentId, hash) as { media_type: string; bytes: Uint8Array } | undefined;
      if (!row) return node;
      return {
        ...node,
        attrs: { ...node.attrs, src: `data:${row.media_type};base64,${Buffer.from(row.bytes).toString('base64')}` },
      };
    }
    if (!node.content) return node;
    return { ...node, content: node.content.map(visit) };
  };
  return visit(doc);
}
