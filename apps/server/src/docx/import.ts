import { type PMNode, type StyleTable } from '@docforge/model';
import { badRequest } from '../errors.js';
import { readPackage } from './ooxml/package.js';
import {
  documentFromPackage,
  type DocumentMeta,
  type ImportedComment,
} from './ooxml/toDocument.js';
import { archiveIsReasonable } from './zipGuard.js';

export interface ImportResult {
  content: PMNode;
  /** Non-fatal notes from the conversion, surfaced to the user after upload. */
  messages: string[];
  /** What sits outside the body: the header, the footer and the page setup. */
  meta?: DocumentMeta;
  /** Markup the writer puts back, keyed by the reference the model carries. */
  fragments?: Record<string, string>;
  /** The document's own styles, resolved for drawing. */
  styles?: StyleTable;
  /** Review comments the file carried. */
  comments?: ImportedComment[];
}

/**
 * What an uploaded archive may expand to. The reader holds the parts it needs
 * in memory, so a small upload declaring an enormous payload would otherwise
 * take the process down.
 */
const MAX_EXPANDED_BYTES = 200 * 1024 * 1024;

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Convert an uploaded .docx into the editor's document model.
 *
 * The markup is read directly. Going through HTML lost everything HTML cannot
 * say: the size a picture is shown at, the font, size and colour of a run, the
 * shading of a table cell, a page break, the orientation of the page, the
 * header and the footer. All of it arrived and was discarded before anything
 * could store it.
 */
export async function importDocx(buffer: Buffer): Promise<ImportResult> {
  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw badRequest(
      'That file is not a valid .docx. Older .doc files must be converted to .docx first.',
    );
  }
  const reasonable = archiveIsReasonable(buffer, MAX_EXPANDED_BYTES);
  if (!reasonable.ok) throw badRequest(reasonable.reason);

  try {
    const result = documentFromPackage(readPackage(buffer));
    return {
      content: result.content,
      messages: result.messages,
      meta: result.meta,
      fragments: result.fragments,
      styles: result.styles,
      comments: result.comments,
    };
  } catch (error) {
    throw badRequest(`Could not read that .docx file: ${(error as Error).message}`);
  }
}

/** Strip the extension from an uploaded file name to use as a document title. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/u).pop() ?? fileName;
  return base.replace(/\.docx$/iu, '').trim() || 'Imported document';
}
