import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { MAX_RUNNING_TEXT, NODE, type PMNode } from '@docforge/model';
import { badRequest, HttpError } from '../errors.js';
import { assemble, bodySizeOf } from './assemble.js';
import { extractPage, type FontInfo, type PageData, type Picture, type PictureBudget } from './extract.js';
import { buildRows, layoutPage, type Block, type Row } from './layout.js';

export interface PdfImportResult {
  content: PMNode;
  /** Plain-language notes for the person who uploaded the file. */
  messages: string[];
  pages: number;
  meta: { header: string; footer: string; orientation: 'portrait' | 'landscape' };
}

const MAX_PAGES = 500;
const MAX_TEXT_ITEMS = 2_000_000;
const MAX_PICTURES = 40;
const MAX_PICTURE_TOTAL_BYTES = 24 * 1024 * 1024;
/** How much of the top and of the bottom of a page a running header or footer may occupy. */
const MARGIN_BAND = 0.08;

/**
 * pdf.js starts its worker by importing a file path it works out at run time.
 * The server ships as one bundled file, so there is no such path to import and
 * every upload failed with "Setting up fake worker failed". pdf.js looks for
 * an already loaded worker here before it tries the path, so the worker is
 * imported statically, which also makes the bundler carry it, and left where
 * pdf.js will find it. With no real Worker in Node it then runs the same code
 * on the main thread.
 */
function exposeWorker(): void {
  const scope = globalThis as { pdfjsWorker?: unknown };
  scope.pdfjsWorker ??= pdfjsWorker;
}

const PAGE_NUMBER_ONLY =
  /^(?:page\s*)?[-\u2013\u2014\s]*(?:\d{1,4}|[ivxlc]{1,7})[-\u2013\u2014\s]*(?:(?:of|\/)\s*\d{1,4})?$/iu;

const rowText = (row: Row): string => row.segments.map((segment) => segment.text).join(' ').trim();

/** The same running text on every page, whatever the page number in it says. */
const runningKey = (text: string): string => text.replace(/\d+/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase();

/** A header or footer as the page setup stores it: the words, without the page number. */
function runningText(text: string): string {
  return text
    .replace(/\bpage\s*\d+(?:\s*(?:of|\/)\s*\d+)?/giu, ' ')
    .replace(/\b\d+\s*(?:of|\/)\s*\d+\b/gu, ' ')
    .replace(/(^|\s)\d{1,4}(?=\s|$)/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^[\s|,;:\u00b7\u2013\u2014-]+|[\s|,;:\u00b7\u2013\u2014-]+$/gu, '')
    .slice(0, MAX_RUNNING_TEXT);
}

interface Running {
  header: string;
  footer: string;
  removed: number;
}

/**
 * Take running headers, footers and page numbers out of the rows of each page.
 *
 * Left in, they land in the middle of whichever sentence happens to cross the
 * page boundary, once per page, and the person has to hunt every one down. A
 * line counts as running text when the same words sit at the same height in
 * the top or bottom margin of at least half the pages.
 */
function removeRunningText(pages: { data: PageData; rows: Row[] }[]): Running {
  const seen = new Map<string, number>();
  const keyOf = (page: PageData, row: Row): string | null => {
    const top = row.y < page.height * MARGIN_BAND;
    const bottom = row.y > page.height * (1 - MARGIN_BAND);
    if (!top && !bottom) return null;
    // Heights are compared in steps of four points, so a footer that moves by
    // a fraction between odd and even pages is still one footer.
    return `${top ? 'T' : 'B'}${Math.round((top ? row.y : page.height - row.y) / 4)}|${runningKey(rowText(row))}`;
  };
  for (const page of pages) {
    const keys = new Set<string>();
    for (const row of page.rows) {
      const key = keyOf(page.data, row);
      if (key) keys.add(key);
    }
    for (const key of keys) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const needed = Math.max(2, Math.ceil(pages.length / 2));
  const running: Running = { header: '', footer: '', removed: 0 };
  for (const page of pages) {
    page.rows = page.rows.filter((row) => {
      const key = keyOf(page.data, row);
      if (!key) return true;
      const text = rowText(row);
      const repeats = (seen.get(key) ?? 0) >= needed;
      if (!repeats && !PAGE_NUMBER_ONLY.test(text)) return true;
      const words = runningText(text);
      if (key.startsWith('T') && !running.header) running.header = words;
      if (key.startsWith('B') && !running.footer) running.footer = words;
      running.removed += 1;
      return false;
    });
  }
  return running;
}

/** A logo in the same place on most pages is part of the page furniture, not of the text. */
function removeRunningPictures(pages: PageData[]): number {
  if (pages.length < 2) return 0;
  const keyOf = (picture: Picture): string =>
    `${picture.src.length}|${Math.round(picture.x / 4)}|${Math.round(picture.y / 4)}|${picture.src.slice(-32)}`;
  const seen = new Map<string, number>();
  for (const page of pages) {
    for (const key of new Set(page.pictures.map(keyOf))) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const needed = Math.max(2, Math.ceil(pages.length / 2));
  let removed = 0;
  for (const page of pages) {
    const kept = page.pictures.filter((picture) => (seen.get(keyOf(picture)) ?? 0) < needed);
    removed += page.pictures.length - kept.length;
    page.pictures = kept;
  }
  return removed;
}

async function open(buffer: Buffer): Promise<{ pdf: PDFDocumentProxy; close: () => Promise<void> }> {
  exposeWorker();
  // pdf.js takes ownership of the bytes it is given, so it gets its own copy
  // and the caller's buffer is still whole afterwards.
  const task = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    return { pdf, close: () => task.destroy() };
  } catch (error) {
    await task.destroy().catch(() => undefined);
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'PasswordException') {
      throw badRequest(
        'This PDF is protected with a password. Remove the password and upload it again.',
      );
    }
    throw badRequest('That PDF could not be read: the file is damaged or incomplete.');
  }
}

/**
 * Convert an uploaded PDF into the editor's document model.
 *
 * A PDF records where ink goes and nothing about what the ink means, so the
 * structure that comes back is reconstructed, and the messages say so. What
 * cannot be recovered honestly is left as plain paragraphs rather than guessed.
 */
export async function importPdf(buffer: Buffer): Promise<PdfImportResult> {
  // The marker may be preceded by a little junk: readers allow it within the
  // first kilobyte, and files that have been through a mail gateway have it.
  if (buffer.length < 8 || !buffer.subarray(0, 1024).includes('%PDF-')) {
    throw badRequest('That file is not a PDF.');
  }

  const { pdf, close } = await open(buffer);
  try {
    return await convert(pdf);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw badRequest('That PDF could not be read: the file is damaged or incomplete.');
  } finally {
    await close().catch(() => undefined);
  }
}

async function convert(pdf: PDFDocumentProxy): Promise<PdfImportResult> {
  const pageCount = pdf.numPages;
  if (pageCount > MAX_PAGES) {
    throw badRequest(
      `This PDF has ${pageCount} pages. The most that can be converted is ${MAX_PAGES}.`,
    );
  }

  const messages: string[] = [
    'This document was converted from a PDF. A PDF does not record paragraphs, headings or tables, so the layout was reconstructed and may need tidying.',
  ];
  const fonts = new Map<string, FontInfo>();
  const budget: PictureBudget = { remaining: MAX_PICTURES, bytes: MAX_PICTURE_TOTAL_BYTES };
  const pages: { data: PageData; rows: Row[] }[] = [];
  let itemsLeft = MAX_TEXT_ITEMS;
  let unreadable = 0;
  let truncated = false;

  for (let number = 1; number <= pageCount; number += 1) {
    if (itemsLeft <= 0) {
      truncated = true;
      break;
    }
    try {
      const page = await pdf.getPage(number);
      const data = await extractPage(page, number - 1, fonts, budget, itemsLeft);
      itemsLeft -= data.items.length + data.rotated.length;
      pages.push({ data, rows: buildRows(data.items) });
      page.cleanup();
    } catch {
      // One damaged page should not cost the person the other ninety-nine.
      unreadable += 1;
    }
  }

  const characters = pages.reduce(
    (sum, page) =>
      sum + [...page.data.items, ...page.data.rotated].reduce((n, item) => n + item.text.trim().length, 0),
    0,
  );
  if (characters === 0) {
    if (pages.length === 0 && unreadable > 0) {
      throw badRequest('That PDF could not be read: the file is damaged or incomplete.');
    }
    throw badRequest(
      pages.some((page) => page.data.paintsImages)
        ? 'This PDF is a scan: it holds pictures of pages and no text. Scanned PDFs cannot be converted.'
        : 'This PDF has no text in it, so there is nothing to convert.',
    );
  }

  const running = removeRunningText(pages);
  const logos = removeRunningPictures(pages.map((page) => page.data));

  const blocks: Block[] = [];
  const nextStream = { value: 0 };
  let rotatedLines = 0;
  for (const page of pages) {
    blocks.push(...layoutPage(page.rows, page.data.pictures, page.data.rules, nextStream));
    // Text set at an angle (a watermark, a label up the side of a chart) has
    // no place in the flow of the page. It is kept, after the page it was on,
    // because dropping it would be losing words without saying so.
    for (const row of buildRows(page.data.rotated.map((piece) => ({ ...piece, y: piece.x, x: piece.y })))) {
      const stream = nextStream.value;
      nextStream.value += 1;
      for (const segment of row.segments) {
        rotatedLines += 1;
        blocks.push({
          kind: 'line',
          line: {
            x0: 0,
            x1: 0,
            y: 0,
            size: segment.size,
            spans: segment.spans,
            text: segment.text,
            marker: null,
            stream,
            colLeft: 0,
            colRight: 0,
            pitch: 0,
          },
        });
      }
    }
  }

  const bodySize = bodySizeOf(blocks);
  const nodes = assemble(blocks, bodySize);
  const content: PMNode = {
    type: NODE.doc,
    content: nodes.length > 0 ? nodes : [{ type: NODE.paragraph }],
  };

  const skipped = pages.reduce((sum, page) => sum + page.data.picturesSkipped, 0);
  if (running.removed > 0) {
    messages.push(
      'Text that repeated at the top or bottom of the pages, and the page numbers, were taken out of the body. The first header and footer are kept in the page setup.',
    );
  }
  if (logos > 0) messages.push('A picture repeated on most pages, such as a logo, was left out.');
  if (skipped > 0) {
    messages.push(
      `${skipped === 1 ? 'One picture was' : `${skipped} pictures were`} not carried over: a document takes at most ${MAX_PICTURES} pictures from a PDF, none larger than 4 MB, and some kinds of picture cannot be read.`,
    );
  }
  if (blocks.some((block) => block.kind === 'table')) {
    messages.push('Tables were rebuilt from the position of the text. Merged cells, borders and shading are not carried over, so check each table.');
  }
  if (rotatedLines > 0) messages.push('Text set at an angle was placed after the page it was on.');
  if (unreadable > 0) {
    messages.push(`${unreadable === 1 ? 'One page' : `${unreadable} pages`} could not be read and ${unreadable === 1 ? 'was' : 'were'} left out.`);
  }
  if (truncated) messages.push('The PDF holds more text than can be converted at once, so the document stops early.');

  const first = pages[0]?.data;
  return {
    content,
    messages,
    pages: pageCount,
    meta: {
      header: running.header,
      footer: running.footer,
      orientation: first && first.width > first.height ? 'landscape' : 'portrait',
    },
  };
}
