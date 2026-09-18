/**
 * A document, as a PDF, made here and nowhere else.
 *
 * The usual way to get a PDF out of a word processor is to hand the file to
 * LibreOffice. That is a second program to install, to patch and to start for
 * every export, on a machine that may have no package manager and no network.
 * So the page is laid out in this file instead: text is measured and broken
 * into lines, lines and table rows are stacked into pages, and pdfkit is used
 * only as the pen. The result will not match Word line for line, because the
 * fonts are the PDF built-in ones and not the document's own, but it is a
 * faithful, paginated, searchable rendering that needs nothing but Node.
 *
 * The layout works in two steps. Everything is first turned into a flat list
 * of items, each a strip of known height that must not be cut (a line of
 * text, a table row, a picture). The list is then poured into pages. Tables
 * need the first step to exist at all: a row is as tall as its tallest cell,
 * which cannot be known until the cell's contents have been broken into lines.
 */
import { inflateSync } from 'node:zlib';
import { NODE, toPlainText } from '@docforge/model';
import type { Alignment, PMNode, PageSetup, StyleTable } from '@docforge/model';
import { PDFDocument } from './pdfkitBundled.js';
import type { PdfDoc } from './pdfkitBundled.js';
import {
  breaksAnywhere,
  builtinCanDraw,
  builtinFace,
  builtinTwin,
  fallbackFontFiles,
  readFontFile,
  scriptKeyword,
  isInvisible,
  isJoining,
  isRightToLeft,
} from './fonts.js';
import { paragraphStyle, runStyle } from './styles.js';
import type { ParagraphStyle, RunStyle } from './styles.js';

export interface PdfExportOptions {
  title: string;
  author?: string | undefined;
  pageSetup?: PageSetup | undefined;
  styles?: StyleTable | null | undefined;
  /** Directories to look in for TrueType/OpenType fonts, for text the built-in fonts cannot draw. */
  fontDirs?: string[] | undefined;
  /** The date written into the file. Fixing it makes two exports of one document identical. */
  creationDate?: Date | undefined;
  /** Whether to look in the operating system's font directories too. On unless set to false. */
  systemFonts?: boolean | undefined;
}

const INCH = 72;
const MARGIN = INCH;
const PX = 72 / 96;
const MAX_PAGES = 2000;
const MAX_DEPTH = 12;
const MAX_COLUMNS = 64;
const CELL_PAD = 4;
const BORDER = 0.5;
const LIST_STEP = INCH / 4;
const QUOTE_INDENT = 18;
const RULE_GREY = '#b0b0b0';
const RUNNING_GREY = '#555555';
// Where the baseline sits in a line, as a share of the font size. These are
// Arial's figures, which is what Helvetica is drawn as almost everywhere.
const ASCENT = 0.905;
const DESCENT = 0.212;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_FONTS_OPENED = 10;
const FINISH_TIMEOUT_MS = 60_000;

/** A strip of the page that is placed whole. */
interface Item {
  height: number;
  before: number;
  after: number;
  /** Do not let a page end between this and the item after it. */
  keepWithNext: boolean;
  draw: (originX: number, y: number) => void;
  pageBreak?: boolean;
  /** A table's header rows, to be drawn again when this row starts a page. */
  repeat?: Item[];
  /** For an item taller than a page: a piece that fits in `available`, and the rest. */
  split?: (available: number) => [Item, Item] | null;
  /** Offsets of the blockquote rules that run down beside this item. */
  bars?: number[];
  /** For a line of text, how far below its top the text stands. */
  baseline?: number;
}

interface TextAtom {
  kind: 'text';
  text: string;
  font: string;
  size: number;
  style: RunStyle;
  width: number;
  space: boolean;
  rtl: boolean;
  /** Whether a line may end just before this. */
  breakBefore: boolean;
}

interface BoxAtom {
  kind: 'box';
  width: number;
  height: number;
  image: unknown;
  breakBefore: boolean;
}

interface BreakAtom {
  kind: 'break';
}

type Atom = TextAtom | BoxAtom | BreakAtom;
type Placed = TextAtom | BoxAtom;

interface Line {
  atoms: Placed[];
  width: number;
  /** A line that ends its paragraph, or ends at a line break, is never stretched. */
  last: boolean;
}

/** A string drawn in one go, or a picture, and where on its line it goes. */
interface Run {
  x: number;
  width: number;
  text: string;
  atom: Placed;
}

interface Marker {
  text: string;
  /** Where the marker starts and where the text it labels starts. */
  x: number;
  textX: number;
  style: RunStyle;
}

interface Frame {
  x: number;
  width: number;
  depth: number;
  /** Text in a table's header cells is bold unless it says otherwise. */
  bold: boolean;
  bars: number[];
  /**
   * Inside a list item. A list paragraph read from Word carries the indent
   * Word used to make room for its number. The list does that here, and
   * honouring both would push the text in twice and leave the number behind.
   */
  flat?: boolean;
}

/** The parts of pdfkit this file relies on that its type declarations leave out. */
interface PdfInternals {
  openImage(src: Buffer): { width: number; height: number };
  _font?: { font?: { hasGlyphForCodePoint?(codePoint: number): boolean } };
}

function attrNumber(node: PMNode, name: string): number | null {
  const value = node.attrs?.[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function attrText(node: PMNode, name: string): string {
  const value = node.attrs?.[name];
  return typeof value === 'string' ? value : '';
}

function isInline(node: PMNode): boolean {
  return (
    node.type === NODE.text ||
    node.type === NODE.hardBreak ||
    node.type === NODE.image ||
    node.type === NODE.wordInline ||
    (typeof node.text === 'string' && !node.content)
  );
}

function roman(value: number): string {
  if (value <= 0 || value >= 4000) return String(value);
  const table: Array<[number, string]> = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let left = value;
  let out = '';
  for (const [amount, letters] of table) {
    while (left >= amount) {
      out += letters;
      left -= amount;
    }
  }
  return out;
}

/** a, b ... z, aa, bb, as Word counts past twenty-six. */
function letters(value: number): string {
  if (value <= 0) return String(value);
  const letter = String.fromCharCode(97 + ((value - 1) % 26));
  return letter.repeat(Math.min(8, Math.floor((value - 1) / 26) + 1));
}

function listLabel(format: string, value: number, level: number): string {
  switch (format) {
    case 'lowerLetter':
      return `${letters(value)}.`;
    case 'upperLetter':
      return `${letters(value).toUpperCase()}.`;
    case 'lowerRoman':
      return `${roman(value)}.`;
    case 'upperRoman':
      return `${roman(value).toUpperCase()}.`;
    case 'bullet':
      // Word's own sequence ends in a square, which the built-in fonts lack.
      return ['\u2022', 'o', '\u2013'][level % 3] ?? '\u2022';
    default:
      return `${value}.`;
  }
}

/**
 * Whether a PNG can be given to pdfkit without risk to the process.
 *
 * pdfkit unpacks a PNG that has transparency inside an asynchronous zlib
 * callback, and rethrows a failure from there, where no try/catch of ours can
 * reach it. A damaged picture in one document would take the whole server
 * down. Unpacking it here first, where a failure is only an exception, means
 * pdfkit is never handed data that zlib will refuse.
 */
function pngIsSound(data: Buffer): boolean {
  try {
    if (data.length < 33 || data.readUInt32BE(0) !== 0x89504e47) return false;
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    if (width === 0 || height === 0 || width * height > MAX_IMAGE_PIXELS) return false;
    const parts: Buffer[] = [];
    let at = 8;
    while (at + 12 <= data.length) {
      const length = data.readUInt32BE(at);
      const type = data.toString('latin1', at + 4, at + 8);
      if (at + 12 + length > data.length) return false;
      if (type === 'IDAT') parts.push(data.subarray(at + 8, at + 8 + length));
      if (type === 'IEND') break;
      at += 12 + length;
    }
    if (parts.length === 0) return false;
    inflateSync(Buffer.concat(parts), { maxOutputLength: 512 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

class Renderer {
  private readonly doc: PdfDoc;
  private readonly internals: PdfInternals;
  private readonly styles: StyleTable | null;
  private readonly setup: PageSetup;
  private readonly widths = new Map<string, number>();
  private readonly fontChoice = new Map<number, string | null>();
  private readonly fallbacks: string[] = [];
  private readonly fontFiles: string[];
  private readonly triedFiles = new Set<string>();
  private pages = 1;
  private truncated = false;

  constructor(private readonly options: PdfExportOptions) {
    this.styles = options.styles ?? null;
    this.setup = options.pageSetup ?? { header: '', footer: '', orientation: 'portrait' };
    this.doc = new PDFDocument({
      size: 'A4',
      layout: this.setup.orientation === 'landscape' ? 'landscape' : 'portrait',
      // pdfkit starts a new page by itself when text nears its bottom margin.
      // Pagination is decided here, so it is given no margin to defend.
      margin: 0,
      bufferPages: true,
      displayTitle: true,
      info: {
        Title: options.title,
        Author: options.author ?? '',
        Creator: 'DocForge',
        Producer: 'DocForge',
        CreationDate: options.creationDate ?? new Date(),
      },
    });
    this.internals = this.doc as unknown as PdfInternals;
    let files: string[] = [];
    try {
      files = fallbackFontFiles(options.fontDirs ?? [], options.systemFonts !== false);
    } catch {
      files = [];
    }
    this.fontFiles = files;
  }

  private get textWidth(): number {
    return this.doc.page.width - 2 * MARGIN;
  }

  private get top(): number {
    return MARGIN;
  }

  private get bottom(): number {
    return this.doc.page.height - MARGIN;
  }

  // ---------------------------------------------------------------- fonts

  /** The name of a registered font that can draw this character, if any file on the machine can. */
  private fallbackFor(codePoint: number): string | null {
    const known = this.fontChoice.get(codePoint);
    if (known !== undefined) return known;
    let chosen: string | null = null;
    for (const name of this.fallbacks) {
      if (this.hasGlyph(name, codePoint)) {
        chosen = name;
        break;
      }
    }
    if (!chosen) {
      const word = scriptKeyword(codePoint);
      const named = word ? this.fontFiles.filter((path) => path.toLowerCase().includes(word)).slice(0, 3) : [];
      for (const path of [...named, ...this.fontFiles.slice(0, 5)]) {
        // Opening a font means reading and parsing megabytes. A document full
        // of characters nothing can draw must not open every font on the disk.
        if (this.triedFiles.size >= MAX_FONTS_OPENED) break;
        if (this.triedFiles.has(path)) continue;
        this.triedFiles.add(path);
        const data = readFontFile(path);
        if (!data) continue;
        const name = `fallback-${this.fallbacks.length + 1}`;
        try {
          this.doc.registerFont(name, data);
          // Selecting the font is what parses it. A file that is not really a
          // font fails here, and the next candidate gets its turn.
          this.doc.font(name);
          this.fallbacks.push(name);
        } catch {
          continue;
        }
        if (this.hasGlyph(name, codePoint)) {
          chosen = name;
          break;
        }
      }
    }
    this.fontChoice.set(codePoint, chosen);
    return chosen;
  }

  private hasGlyph(name: string, codePoint: number): boolean {
    try {
      this.doc.font(name);
      return this.internals._font?.font?.hasGlyphForCodePoint?.(codePoint) ?? true;
    } catch {
      return false;
    }
  }

  private measure(text: string, font: string, size: number): number {
    const key = `${font}|${size}|${text}`;
    const cached = this.widths.get(key);
    if (cached !== undefined) return cached;
    let width: number;
    try {
      width = this.doc.font(font).fontSize(size).widthOfString(text);
    } catch {
      width = text.length * size * 0.5;
    }
    if (!Number.isFinite(width)) width = text.length * size * 0.5;
    if (this.widths.size > 50_000) this.widths.clear();
    this.widths.set(key, width);
    return width;
  }

  // --------------------------------------------------------------- inline

  /**
   * Cut a run of text into the pieces a line is built from: words, the spaces
   * between them, and a new piece wherever the font has to change because the
   * next character is one the current font cannot draw.
   */
  private textAtoms(raw: string, style: RunStyle, atoms: Atom[]): void {
    let text = raw.normalize('NFC');
    if (style.caps) text = text.toUpperCase();
    const size = style.shift ? style.size * 0.65 : style.size;
    const face = builtinFace(style.family, style.bold, style.italic);

    let pending = '';
    let pendingFont = face;
    let pendingRtl = false;
    let breakNext = false;
    const flush = (): void => {
      if (pending === '') return;
      const previous = atoms[atoms.length - 1];
      const afterGap = !previous || previous.kind !== 'text' || previous.space;
      atoms.push({
        kind: 'text',
        text: pending,
        font: pendingFont,
        size,
        style,
        width: this.measure(pending, pendingFont, size),
        space: false,
        rtl: pendingRtl,
        breakBefore: afterGap || breakNext,
      });
      breakNext = false;
      pending = '';
    };

    for (const char of text) {
      const codePoint = char.codePointAt(0) ?? 0x3f;
      if (char === '\n' || char === '\r') {
        flush();
        atoms.push({ kind: 'break' });
        continue;
      }
      if (char === ' ' || char === '\t') {
        flush();
        // A tab is drawn as a fixed gap. Real tab stops belong to a paragraph's
        // Word markup, which the model does not carry.
        const gap = char === '\t' ? '    ' : ' ';
        atoms.push({
          kind: 'text',
          text: gap,
          font: face,
          size,
          style,
          width: this.measure(gap, face, size),
          space: true,
          rtl: false,
          breakBefore: false,
        });
        continue;
      }
      if (codePoint < 0x20 || codePoint === 0x7f) continue;

      let font = face;
      let drawn = char;
      if (!builtinCanDraw(codePoint)) {
        const twin = builtinTwin(codePoint);
        if (twin !== null) {
          drawn = twin;
        } else if (isJoining(codePoint) && pending !== '' && pendingFont !== face) {
          font = pendingFont;
        } else if (isInvisible(codePoint) || isJoining(codePoint)) {
          continue;
        } else {
          const fallback = this.fallbackFor(codePoint);
          if (fallback) font = fallback;
          else drawn = '?';
        }
      }

      const anywhere = breaksAnywhere(codePoint);
      if (font !== pendingFont || anywhere) flush();
      if (anywhere) breakNext = true;
      pendingFont = font;
      pendingRtl = isRightToLeft(codePoint);
      pending += drawn;
      if (anywhere) {
        flush();
        breakNext = true;
      }
    }
    flush();
  }

  private imageAtom(node: PMNode, maxWidth: number): BoxAtom | null {
    const match = /^data:image\/(png|jpe?g);base64,(.+)$/is.exec(attrText(node, 'src'));
    // Anything else, GIF included, is a format pdfkit has no reader for. The
    // picture is left out and the text around it carries on.
    if (!match?.[1] || !match[2]) return null;
    try {
      const data = Buffer.from(match[2], 'base64');
      if (match[1].toLowerCase() === 'png' && !pngIsSound(data)) return null;
      const image = this.internals.openImage(data);
      if (!(image.width > 0) || !(image.height > 0) || image.width * image.height > MAX_IMAGE_PIXELS) return null;
      const statedWidth = attrNumber(node, 'width');
      const statedHeight = attrNumber(node, 'height');
      const ratio = image.height / image.width;
      let width = (statedWidth && statedWidth > 0 ? statedWidth : null) ?? (statedHeight ? statedHeight / ratio : image.width);
      let height = (statedHeight && statedHeight > 0 ? statedHeight : null) ?? width * ratio;
      width *= PX;
      height *= PX;
      const limitHeight = this.bottom - this.top - 4;
      const scale = Math.min(1, Math.max(1, maxWidth) / width, limitHeight / height);
      return { kind: 'box', width: width * scale, height: height * scale, image, breakBefore: true };
    } catch {
      return null;
    }
  }

  private inlineAtoms(nodes: readonly PMNode[], para: ParagraphStyle, maxWidth: number): Atom[] {
    const atoms: Atom[] = [];
    for (const node of nodes) {
      if (node.type === NODE.hardBreak) {
        atoms.push({ kind: 'break' });
      } else if (node.type === NODE.image) {
        const box = this.imageAtom(node, maxWidth);
        if (box) atoms.push(box);
      } else if (node.type === NODE.wordInline) {
        const kind = attrText(node, 'kind');
        if (kind === 'bookmark' || kind === 'comment' || kind === 'permission') continue;
        const style = runStyle(para.run, node.marks, this.styles);
        if (kind === 'footnote' || kind === 'endnote') style.shift = 'super';
        const label = attrText(node, 'label');
        if (label) this.textAtoms(label, style, atoms);
      } else if (typeof node.text === 'string') {
        this.textAtoms(node.text, runStyle(para.run, node.marks, this.styles), atoms);
      } else {
        // An inline node nobody has told this file about. Its words still matter.
        const words = toPlainText(node);
        if (words) this.textAtoms(words, runStyle(para.run, node.marks, this.styles), atoms);
      }
    }
    return atoms;
  }

  /** Break a word that is wider than the whole line into pieces that fit. */
  private shatter(atom: TextAtom, width: number): TextAtom[] {
    const pieces: TextAtom[] = [];
    let piece = '';
    const push = (): void => {
      if (piece === '') return;
      pieces.push({ ...atom, text: piece, width: this.measure(piece, atom.font, atom.size), breakBefore: true });
      piece = '';
    };
    for (const char of atom.text) {
      if (piece !== '' && this.measure(piece + char, atom.font, atom.size) > width) push();
      piece += char;
    }
    push();
    return pieces;
  }

  private breakLines(atoms: readonly Atom[], firstWidth: number, restWidth: number): Line[] {
    const lines: Line[] = [];
    let line: Placed[] = [];
    let lineWidth = 0;
    let spaces: TextAtom[] = [];
    const room = (): number => Math.max(1, lines.length === 0 ? firstWidth : restWidth);
    const finish = (last: boolean): void => {
      lines.push({ atoms: line, width: lineWidth, last });
      line = [];
      lineWidth = 0;
      spaces = [];
    };

    let index = 0;
    while (index < atoms.length) {
      const atom = atoms[index];
      if (!atom) break;
      if (atom.kind === 'break') {
        finish(true);
        index += 1;
        continue;
      }
      if (atom.kind === 'text' && atom.space) {
        // Spaces at the start of a wrapped line are dropped, as in any word
        // processor. At the very start of a paragraph they were typed on purpose.
        if (line.length > 0 || lines.length === 0) spaces.push(atom);
        index += 1;
        continue;
      }
      // Everything up to the next place a line may end travels together, so
      // that a word half in bold is not split where the bold begins.
      let unit: Placed[] = [atom];
      let end = index + 1;
      for (; end < atoms.length; end += 1) {
        const next = atoms[end];
        if (!next || next.kind === 'break' || next.breakBefore || (next.kind === 'text' && next.space)) break;
        unit.push(next);
      }
      index = end;

      const unitWidth = unit.reduce((sum, part) => sum + part.width, 0);
      const spaceWidth = spaces.reduce((sum, part) => sum + part.width, 0);
      if (line.length > 0 && lineWidth + spaceWidth + unitWidth > room() + 0.01) finish(false);
      else if (spaces.length > 0) {
        line.push(...spaces);
        lineWidth += spaceWidth;
      }
      spaces = [];

      if (unitWidth > room() + 0.01) {
        unit = unit.flatMap((part): Placed[] => (part.kind === 'text' ? this.shatter(part, room()) : [part]));
      }
      for (const part of unit) {
        if (line.length > 0 && lineWidth + part.width > room() + 0.01) finish(false);
        line.push(part);
        lineWidth += part.width;
      }
    }
    if (line.length > 0 || lines.length === 0) finish(true);
    else {
      const final = lines[lines.length - 1];
      if (final) final.last = true;
    }
    return lines;
  }

  // ---------------------------------------------------------------- lines

  private lineItem(line: Line, para: ParagraphStyle, frame: Frame, first: boolean, marker: Marker | null): Item {
    let tallest = 0;
    let box = 0;
    for (const atom of line.atoms) {
      if (atom.kind === 'text') tallest = Math.max(tallest, atom.style.size);
      else box = Math.max(box, atom.height);
    }
    if (tallest === 0 && box === 0) tallest = para.run.size;
    if (marker) tallest = Math.max(tallest, marker.style.size);

    // The same arithmetic as a browser: the line is `pitch` tall and the text
    // sits in the middle of it, so exports and the editor agree on spacing.
    const pitch = tallest === 0 ? 0 : (para.exact ?? tallest * 1.2 * para.multiple);
    const content = tallest * (ASCENT + DESCENT);
    let baseline = (pitch - content) / 2 + tallest * ASCENT;
    let height = pitch;
    if (box > 0) {
      baseline = Math.max(baseline, box + 1);
      height = Math.max(height, baseline + tallest * DESCENT + 1);
    }

    const left = frame.x + para.left + (first ? para.first : 0);
    const room = frame.width - para.left - para.right - (first ? para.first : 0);
    const gaps = line.atoms.filter((atom) => atom.kind === 'text' && atom.space).length;
    const justified = para.align === 'justify' && !line.last && gaps > 0;
    const stretch = justified ? Math.max(0, room - line.width) / gaps : 0;
    const pieces = this.runsOf(this.visualOrder(line.atoms), stretch, justified);
    // Measured again as it will be drawn. Words were measured one at a time to
    // break the line, but a run drawn as one string is kerned across its
    // spaces and comes out a little narrower, which shows at a right-hand edge.
    const slack = Math.max(0, room - pieces.width);
    const shiftX = para.align === 'center' ? slack / 2 : para.align === 'right' ? slack : 0;
    const background = para.background;
    const bandX = frame.x + para.left;
    const bandWidth = frame.width - para.left - para.right;

    return {
      height,
      before: 0,
      after: 0,
      keepWithNext: false,
      baseline,
      ...(frame.bars.length > 0 ? { bars: frame.bars } : {}),
      draw: (originX, y) => {
        if (background) this.doc.rect(originX + bandX, y, bandWidth, height).fill(background);
        if (marker) this.drawMarker(marker, originX, y + baseline);
        this.drawRuns(pieces.runs, originX + left + shiftX, y, baseline, height);
      },
    };
  }

  /**
   * Put right-to-left words in the order they are read. fontkit already turns
   * the letters of each word; without this the words of an Arabic or Hebrew
   * phrase would still run left to right. It is a small part of the Unicode
   * bidirectional algorithm, enough for a phrase inside left-to-right text.
   */
  private visualOrder(atoms: Placed[]): Placed[] {
    if (!atoms.some((atom) => atom.kind === 'text' && atom.rtl)) return atoms;
    const out = [...atoms];
    let start = 0;
    while (start < out.length) {
      const head = out[start];
      if (!head || head.kind !== 'text' || !head.rtl) {
        start += 1;
        continue;
      }
      let end = start;
      for (let look = start + 1; look < out.length; look += 1) {
        const next = out[look];
        if (!next || next.kind !== 'text') break;
        if (next.rtl) end = look;
        else if (!next.space) break;
      }
      const turned = out.slice(start, end + 1).reverse();
      out.splice(start, turned.length, ...turned);
      start = end + 1;
    }
    return out;
  }

  /**
   * Join the pieces of a line into the strings that will be drawn: as few as
   * the formatting allows, so that the text can be selected and searched as
   * words and not as fragments.
   */
  private runsOf(atoms: Placed[], stretch: number, justified: boolean): { runs: Run[]; width: number } {
    const runs: Run[] = [];
    let x = 0;
    let open: Run | null = null;
    const close = (): void => {
      if (!open || open.atom.kind !== 'text' || justified) return;
      open.width = this.measure(open.text, open.atom.font, open.atom.size);
      x = open.x + open.width;
    };
    for (const atom of atoms) {
      if (atom.kind === 'box') {
        close();
        open = null;
        runs.push({ x, width: atom.width, text: '', atom });
        x += atom.width;
        continue;
      }
      // On a justified line every piece is placed by itself, because the
      // spaces between them are no longer the width the font says they are.
      if (open && !justified && open.atom.kind === 'text' && open.atom.style === atom.style && open.atom.font === atom.font) {
        open.text += atom.text;
        continue;
      }
      close();
      const width = atom.width + (atom.space ? stretch : 0);
      open = { x, width, text: atom.text, atom };
      runs.push(open);
      x += width;
    }
    close();
    return { runs, width: x };
  }

  private drawRuns(runs: readonly Run[], startX: number, top: number, baseline: number, height: number): void {
    // Highlights first, so that one is painted under the whole line's text
    // before any of the text is drawn over it.
    for (const run of runs) {
      const colour = run.atom.kind === 'text' ? run.atom.style.highlight : null;
      if (colour) this.doc.rect(startX + run.x, top, run.width, height).fill(colour);
    }
    for (const run of runs) {
      const x = startX + run.x;
      if (run.atom.kind === 'box') {
        try {
          // pdfkit takes an image it has already opened, though its types do not say so.
          this.doc.image(run.atom.image as Buffer, x, top + baseline - run.atom.height, {
            width: run.atom.width,
            height: run.atom.height,
          });
        } catch {
          // A picture pdfkit opened but could not place. The line keeps its gap.
        }
        continue;
      }
      const { style, size, font } = run.atom;
      const shift = style.shift === 'super' ? -style.size * 0.33 : style.shift === 'sub' ? style.size * 0.15 : 0;
      const y = top + baseline + shift;
      if (run.text.trim() !== '') this.drawText(run.text, x, y, font, size, style.colour);
      const thickness = Math.max(0.5, size / 16);
      if (style.underline) this.rule(x, y + size * 0.12, run.width, thickness, style.colour);
      if (style.strike) this.rule(x, y - size * 0.28, run.width, thickness, style.colour);
      if (style.link) {
        try {
          this.doc.link(x, top, run.width, height, style.link);
        } catch {
          // An address pdfkit cannot encode is left as plain, blue text.
        }
      }
    }
  }

  private drawText(text: string, x: number, baselineY: number, font: string, size: number, colour: string): void {
    try {
      this.doc
        .font(font)
        .fontSize(size)
        .fillColor(colour)
        .text(text, x, baselineY, { lineBreak: false, baseline: 'alphabetic' });
    } catch {
      // A font that fails while shaping one string should cost that string,
      // not the document.
    }
  }

  private rule(x: number, y: number, width: number, thickness: number, colour: string): void {
    this.doc.save().lineWidth(thickness).strokeColor(colour).moveTo(x, y).lineTo(x + width, y).stroke().restore();
  }

  private drawMarker(marker: Marker, originX: number, baselineY: number): void {
    const atoms: Atom[] = [];
    this.textAtoms(marker.text, marker.style, atoms);
    const placed = atoms.filter((atom): atom is TextAtom => atom.kind === 'text');
    const width = placed.reduce((sum, atom) => sum + atom.width, 0);
    // "viii." is wider than the gap left for it. It is let out to the left,
    // so that the text of every item still starts on the same line.
    let x = originX + Math.min(marker.x, marker.textX - 3 - width);
    for (const atom of placed) {
      this.drawText(atom.text, x, baselineY, atom.font, atom.size, atom.style.colour);
      x += atom.width;
    }
  }

  // --------------------------------------------------------------- blocks

  private paragraph(node: PMNode, inline: readonly PMNode[], frame: Frame, marker: Marker | null = null): Item[] {
    const para = paragraphStyle(node, this.styles, frame.bold);
    if (frame.flat) {
      para.left = 0;
      para.first = 0;
    }
    const rest = Math.max(1, frame.width - para.left - para.right);
    const atoms = this.inlineAtoms(inline, para, rest);
    const lines = this.breakLines(atoms, rest - para.first, rest);
    const items = lines.map((line, index) => this.lineItem(line, para, frame, index === 0, index === 0 ? marker : null));
    const head = items[0];
    const tail = items[items.length - 1];
    if (head) head.before = para.before;
    if (tail) tail.after = para.after;

    if (node.type === NODE.heading) {
      // A heading alone at the foot of a page, with its text overleaf, is the
      // one pagination fault every reader notices.
      for (const item of items) item.keepWithNext = true;
    } else if (items.length > 1) {
      // Nor should one line of a paragraph be stranded on either side of a page.
      if (head) head.keepWithNext = true;
      const beforeLast = items[items.length - 2];
      if (beforeLast) beforeLast.keepWithNext = true;
    }
    return items;
  }

  private plainParagraph(text: string, frame: Frame): Item[] {
    return this.paragraph({ type: NODE.paragraph }, [{ type: NODE.text, text }], frame);
  }

  private blocks(nodes: readonly PMNode[], frame: Frame): Item[] {
    const items: Item[] = [];
    let loose: PMNode[] = [];
    const flushLoose = (): void => {
      if (loose.length === 0) return;
      items.push(...this.paragraph({ type: NODE.paragraph }, loose, frame));
      loose = [];
    };
    for (const node of nodes) {
      // Text sitting straight inside a list item or a cell is not valid, but
      // it is somebody's text, and it is drawn as the paragraph it should be.
      if (isInline(node)) {
        loose.push(node);
        continue;
      }
      flushLoose();
      items.push(...this.block(node, frame));
    }
    flushLoose();
    return items;
  }

  private block(node: PMNode, frame: Frame): Item[] {
    if (frame.depth > MAX_DEPTH) {
      // Nesting this deep is an attack or an accident. The words are kept and
      // the structure is not, which bounds the recursion.
      const words = toPlainText(node);
      return words ? this.plainParagraph(words, { ...frame, depth: 0 }) : [];
    }
    const content = node.content ?? [];
    switch (node.type) {
      case NODE.paragraph:
      case NODE.heading:
        return this.paragraph(node, content, frame);
      case NODE.pageBreak:
        return [{ height: 0, before: 0, after: 0, keepWithNext: false, pageBreak: true, draw: () => undefined }];
      case NODE.horizontalRule:
        return [this.horizontalRule(frame)];
      case NODE.blockquote: {
        const bar = frame.x + 4;
        return this.blocks(content, {
          ...frame,
          x: frame.x + QUOTE_INDENT,
          width: Math.max(20, frame.width - QUOTE_INDENT),
          depth: frame.depth + 1,
          bars: [...frame.bars, bar],
          flat: false,
        });
      }
      case NODE.bulletList:
      case NODE.orderedList:
        return this.list(node, frame);
      case NODE.listItem:
        // A list item with no list around it still reads as a bullet.
        return this.list({ type: NODE.bulletList, content: [node] }, frame);
      case NODE.table:
        return this.table(node, frame);
      case NODE.tableRow:
      case NODE.tableCell:
      case NODE.tableHeader:
        return this.blocks(content, { ...frame, depth: frame.depth + 1 });
      case NODE.wordBlock:
        return this.wordBlock(node, frame);
      default: {
        if (content.length > 0) return this.blocks(content, { ...frame, depth: frame.depth + 1 });
        return typeof node.text === 'string' ? this.plainParagraph(node.text, frame) : [];
      }
    }
  }

  private horizontalRule(frame: Frame): Item {
    return {
      height: 1,
      before: 8,
      after: 8,
      keepWithNext: false,
      ...(frame.bars.length > 0 ? { bars: frame.bars } : {}),
      draw: (originX, y) => this.rule(originX + frame.x, y + 0.5, frame.width, 0.75, '#808080'),
    };
  }

  private list(node: PMNode, frame: Frame, level = 0): Item[] {
    const ordered = node.type === NODE.orderedList;
    const stated = attrText(node, 'listFormat');
    const format = stated || (ordered ? 'decimal' : 'bullet');
    let counter = attrNumber(node, 'start') ?? 1;
    const items: Item[] = [];
    // The first list sits a step in from the margin. A list inside an item
    // already starts at that item's text, and needs only the step for its marker.
    const markerX = frame.x + (level === 0 ? LIST_STEP : 0);
    const textX = markerX + LIST_STEP;
    const inner: Frame = {
      ...frame,
      x: textX,
      width: Math.max(20, frame.width - (textX - frame.x)),
      depth: frame.depth + 1,
      flat: true,
    };

    for (const child of node.content ?? []) {
      if (child.type !== NODE.listItem) {
        items.push(...this.blocks([child], inner));
        continue;
      }
      const parts = child.content ?? [];
      const firstPart = parts[0];
      const base = paragraphStyle(firstPart ?? { type: NODE.paragraph }, this.styles, false).run;
      const marker: Marker = {
        text: listLabel(format, counter, level),
        x: markerX,
        textX,
        style: { ...base, underline: false, strike: false, highlight: null, shift: null, link: null, italic: false },
      };
      counter += 1;

      const body: Item[] = [];
      let placed = false;
      let loose: PMNode[] = [];
      const flushLoose = (): void => {
        if (loose.length === 0) return;
        body.push(...this.paragraph({ type: NODE.paragraph }, loose, inner, placed ? null : marker));
        placed = true;
        loose = [];
      };
      for (const part of parts) {
        if (isInline(part)) {
          loose.push(part);
          continue;
        }
        flushLoose();
        if (!placed && (part.type === NODE.paragraph || part.type === NODE.heading)) {
          body.push(...this.paragraph(part, part.content ?? [], inner, marker));
          placed = true;
        } else if (part.type === NODE.bulletList || part.type === NODE.orderedList) {
          if (!placed) {
            body.push(...this.paragraph({ type: NODE.paragraph }, [], inner, marker));
            placed = true;
          }
          body.push(...(inner.depth > MAX_DEPTH ? this.block(part, inner) : this.list(part, inner, level + 1)));
        } else {
          if (!placed) {
            body.push(...this.paragraph({ type: NODE.paragraph }, [], inner, marker));
            placed = true;
          }
          body.push(...this.block(part, inner));
        }
      }
      flushLoose();
      if (!placed) body.push(...this.paragraph({ type: NODE.paragraph }, [], inner, marker));
      items.push(...body);
    }
    return items;
  }

  private wordBlock(node: PMNode, frame: Frame): Item[] {
    const lines = attrText(node, 'label')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (attrText(node, 'kind') !== 'toc') return lines.flatMap((line) => this.plainParagraph(line, frame));

    const items: Item[] = [];
    for (const line of lines) {
      const match = /^(.*?)[\s.\u2026]*\s(\d{1,5})$/.exec(line);
      const title = match?.[1]?.trim() ?? '';
      const page = match?.[2] ?? '';
      if (!match || title === '') {
        items.push(...this.plainParagraph(line, frame));
        continue;
      }
      // The numbers are the ones Word last worked out. They are printed as
      // they stand; this layout's own page breaks will differ from Word's.
      const entry = this.paragraph(
        { type: NODE.paragraph, attrs: { indentRight: 36 * 20, spacingAfter: 40 } },
        [{ type: NODE.text, text: title }],
        frame,
      );
      const last = entry[entry.length - 1];
      if (last) {
        const inner = last.draw;
        const style = paragraphStyle({ type: NODE.paragraph }, this.styles, false).run;
        last.draw = (originX, y) => {
          inner(originX, y);
          const face = builtinFace(style.family, false, false);
          const width = this.measure(page, face, style.size);
          const baseline = y + (last.baseline ?? last.height * 0.75);
          this.drawText(page, originX + frame.x + frame.width - width, baseline, face, style.size, style.colour);
        };
      }
      items.push(...entry);
    }
    return items;
  }

  // --------------------------------------------------------------- tables

  private table(node: PMNode, frame: Frame): Item[] {
    const rowNodes = (node.content ?? []).filter((child) => child.type === NODE.tableRow);
    const strays = (node.content ?? []).filter((child) => child.type !== NODE.tableRow);
    if (rowNodes.length === 0) return this.blocks(strays, { ...frame, depth: frame.depth + 1 });

    interface Cell {
      node: PMNode;
      row: number;
      column: number;
      colspan: number;
      rowspan: number;
      items: Item[];
      contentHeight: number;
    }
    const taken: boolean[][] = rowNodes.map(() => []);
    const cells: Cell[] = [];
    let columns = 1;
    rowNodes.forEach((rowNode, row) => {
      let column = 0;
      for (const cellNode of rowNode.content ?? []) {
        while (taken[row]?.[column]) column += 1;
        // A cell claiming a thousand columns is allowed by the model. Here it
        // would mean columns a fraction of a point wide, so the grid is capped.
        column = Math.min(column, MAX_COLUMNS - 1);
        const colspan = Math.max(1, Math.min(Math.floor(attrNumber(cellNode, 'colspan') ?? 1), MAX_COLUMNS - column));
        const rowspan = Math.max(1, Math.min(Math.floor(attrNumber(cellNode, 'rowspan') ?? 1), rowNodes.length - row));
        for (let r = row; r < row + rowspan; r += 1) {
          for (let c = column; c < column + colspan; c += 1) {
            const takenRow = taken[r];
            if (takenRow) takenRow[c] = true;
          }
        }
        cells.push({ node: cellNode, row, column, colspan, rowspan, items: [], contentHeight: 0 });
        column += colspan;
        columns = Math.max(columns, column);
      }
    });

    // Column widths: what the document states, in the editor's pixels, brought
    // down to fit if the table is wider than the text. A column nobody sized
    // gets the average of those that were, or an equal share.
    const stated: Array<number | null> = Array.from({ length: columns }, () => null);
    for (const cell of cells) {
      const widths = cell.node.attrs?.['colwidth'];
      if (!Array.isArray(widths)) continue;
      widths.forEach((value: unknown, offset) => {
        const at = cell.column + offset;
        if (typeof value === 'number' && value > 0 && at < columns && stated[at] === null) stated[at] = value * PX;
      });
    }
    const known = stated.filter((value): value is number => value !== null);
    const share = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : frame.width / columns;
    let widths = stated.map((value) => value ?? share);
    const total = widths.reduce((a, b) => a + b, 0);
    if (total > frame.width || known.length === 0) widths = widths.map((value) => (value * frame.width) / total);
    const offsets = widths.reduce<number[]>((list, value) => [...list, (list[list.length - 1] ?? 0) + value], [0]);
    const span = (from: number, count: number): number => (offsets[from + count] ?? 0) - (offsets[from] ?? 0);

    for (const cell of cells) {
      const inner: Frame = {
        x: 0,
        width: Math.max(4, span(cell.column, cell.colspan) - 2 * CELL_PAD),
        depth: frame.depth + 2,
        bold: cell.node.type === NODE.tableHeader,
        bars: [],
      };
      // A table inside a cell is laid out by the same code, so it is drawn as a
      // real table. What it cannot do is break across pages: the row that
      // holds it is placed whole.
      cell.items = this.blocks(cell.node.content ?? [], inner);
      cell.contentHeight = stackHeight(cell.items);
    }

    const heights = rowNodes.map(() => 2 * CELL_PAD + 6);
    for (const cell of [...cells].sort((a, b) => a.rowspan - b.rowspan)) {
      const needed = cell.contentHeight + 2 * CELL_PAD;
      let have = 0;
      for (let r = cell.row; r < cell.row + cell.rowspan; r += 1) have += heights[r] ?? 0;
      const lastRow = cell.row + cell.rowspan - 1;
      if (needed > have) heights[lastRow] = (heights[lastRow] ?? 0) + needed - have;
    }

    const makeRow = (parts: Array<{ cell: Cell; items: Item[]; height: number }>, height: number, splittable: boolean): Item => {
      const item: Item = {
        height,
        before: 0,
        after: 0,
        keepWithNext: false,
        ...(frame.bars.length > 0 ? { bars: frame.bars } : {}),
        draw: (originX, y) => {
          for (const part of parts) {
            const x = originX + frame.x + (offsets[part.cell.column] ?? 0);
            const width = span(part.cell.column, part.cell.colspan);
            const fill = colourFromAttr(part.cell.node);
            if (fill) this.doc.rect(x, y, width, part.height).fill(fill);
            this.doc.save().lineWidth(BORDER).strokeColor('#000000').rect(x, y, width, part.height).stroke().restore();
            this.drawStack(part.items, x + CELL_PAD, y + CELL_PAD);
          }
        },
      };
      if (splittable) {
        // A single row taller than a page cannot be placed whole, whatever the
        // rule about not splitting rows says. It is cut between lines instead,
        // so that nothing runs off the bottom of the paper unseen.
        item.split = (available) => {
          const room = available - 2 * CELL_PAD;
          let moved = false;
          let kept = false;
          const upper: typeof parts = [];
          const lower: typeof parts = [];
          for (const part of parts) {
            const count = countFitting(part.items, room);
            if (count > 0) kept = true;
            if (count < part.items.length) moved = true;
            upper.push({ ...part, items: part.items.slice(0, count), height: available });
            lower.push({ ...part, items: part.items.slice(count), height: 0 });
          }
          if (!kept || !moved) return null;
          const restHeight = Math.max(...lower.map((part) => stackHeight(part.items))) + 2 * CELL_PAD;
          for (const part of lower) part.height = restHeight;
          return [makeRow(upper, available, false), makeRow(lower, restHeight, true)];
        };
      }
      return item;
    };

    const rows = rowNodes.map((_, row) => {
      const parts = cells
        .filter((cell) => cell.row === row)
        .map((cell) => {
          let height = 0;
          for (let r = row; r < row + cell.rowspan; r += 1) height += heights[r] ?? 0;
          return { cell, items: cell.items, height };
        });
      const spanned = cells.some((cell) => cell.rowspan > 1 && cell.row <= row && row < cell.row + cell.rowspan);
      const item = makeRow(parts, heights[row] ?? 0, !spanned);
      // A cell that spans rows is drawn with the first of them, so the rows it
      // covers have to land on the same page as that one.
      item.keepWithNext = cells.some((cell) => cell.row <= row && row < cell.row + cell.rowspan - 1);
      return item;
    });

    let headerCount = 0;
    while (headerCount < rowNodes.length) {
      const inRow = cells.filter((cell) => cell.row === headerCount);
      if (inRow.length === 0 || !inRow.every((cell) => cell.node.type === NODE.tableHeader)) break;
      headerCount += 1;
    }
    const headerRows = rows.slice(0, headerCount);
    const headerHeight = headerRows.reduce((sum, item) => sum + item.height, 0);
    const selfContained = cells.every((cell) => cell.row >= headerCount || cell.row + cell.rowspan <= headerCount);
    if (headerCount > 0 && headerCount < rows.length && selfContained && headerHeight < (this.bottom - this.top) * 0.4) {
      for (const item of headerRows) item.keepWithNext = true;
      for (const item of rows.slice(headerCount)) item.repeat = headerRows;
    }

    const firstRow = rows[0];
    const lastRow = rows[rows.length - 1];
    if (firstRow) firstRow.before = 4;
    if (lastRow) lastRow.after = 8;
    return [...rows, ...this.blocks(strays, { ...frame, depth: frame.depth + 1 })];
  }

  // ---------------------------------------------------------------- pages

  private drawItem(item: Item, previous: Item | null, originX: number, y: number, gap: number): void {
    for (const bar of item.bars ?? []) {
      const joined = previous?.bars?.includes(bar) === true;
      const from = joined ? y - gap : y;
      this.doc.save().lineWidth(2).strokeColor(RULE_GREY).moveTo(originX + bar, from).lineTo(originX + bar, y + item.height).stroke().restore();
    }
    item.draw(originX, y);
  }

  /** Draw items one under another with no thought for pages: the inside of a table cell. */
  private drawStack(items: readonly Item[], originX: number, top: number): void {
    let y = top;
    let previous: Item | null = null;
    for (const item of items) {
      if (item.pageBreak) continue;
      const gap = previous ? Math.max(previous.after, item.before) : 0;
      this.drawItem(item, previous, originX, y + gap, gap);
      y += gap + item.height;
      previous = item;
    }
  }

  private newPage(): boolean {
    if (this.pages >= MAX_PAGES) {
      this.truncated = true;
      return false;
    }
    this.doc.addPage();
    this.pages += 1;
    return true;
  }

  private pour(items: readonly Item[]): void {
    const originX = MARGIN;
    const body = this.bottom - this.top;
    let y = this.top;
    let previous: Item | null = null;

    const turn = (repeat: Item[] | undefined): boolean => {
      if (!this.newPage()) return false;
      y = this.top;
      previous = null;
      for (const header of repeat ?? []) {
        this.drawItem(header, previous, originX, y, 0);
        y += header.height;
        previous = header;
      }
      return true;
    };

    for (let index = 0; index < items.length; index += 1) {
      const start = items[index];
      if (!start) continue;
      let item: Item = start;
      if (item.pageBreak) {
        // A break with nothing before it on the page, or nothing after it in
        // the document, would only produce a blank sheet.
        const more = items.slice(index + 1).some((later) => !later.pageBreak);
        if (previous && more && !turn(undefined)) return;
        continue;
      }

      let gap: number = previous ? Math.max(previous.after, item.before) : 0;
      let group = item.height;
      for (let look = index; look < items.length - 1 && look - index < 40; look += 1) {
        const here = items[look];
        const next = items[look + 1];
        if (!here?.keepWithNext || !next || next.pageBreak) break;
        group += Math.max(here.after, next.before) + next.height;
      }
      const fitsAlone = item.height <= body - (item.repeat ?? []).reduce((sum, header) => sum + header.height, 0);
      if (previous && y + gap + group > this.bottom && group <= body) {
        if (!turn(item.repeat)) return;
        gap = 0;
      } else if (previous && y + gap + item.height > this.bottom && fitsAlone) {
        if (!turn(item.repeat)) return;
        gap = 0;
      }

      let fresh = !previous;
      while (y + gap + item.height > this.bottom + 0.01 && item.split) {
        const available: number = this.bottom - y - gap;
        const pieces: [Item, Item] | null = available >= INCH ? item.split(available) : null;
        if (!pieces) {
          // Tried on a clean page and still no piece fits: draw it as it is.
          if (fresh) break;
          if (!turn(item.repeat)) return;
          fresh = true;
          gap = 0;
          continue;
        }
        this.drawItem(pieces[0], previous, originX, y + gap, gap);
        if (item.repeat) pieces[1].repeat = item.repeat;
        item = pieces[1];
        if (!turn(item.repeat)) return;
        fresh = true;
        gap = 0;
      }

      this.drawItem(item, previous, originX, y + gap, gap);
      y += gap + item.height;
      previous = item;
    }
  }

  /**
   * One line of running text. A header is a label, not a paragraph: if it is
   * too long for the line it is cut short with an ellipsis, because wrapping
   * it would push it into the body of the page.
   */
  private runningLine(text: string, x: number, baselineY: number, width: number, align: Alignment): void {
    const style: RunStyle = {
      family: 'Helvetica', bold: false, italic: false, underline: false, strike: false, size: 9,
      colour: RUNNING_GREY, highlight: null, shift: null, link: null, caps: false,
    };
    const atoms: Atom[] = [];
    this.textAtoms(text.replace(/\s+/g, ' ').trim(), style, atoms);
    let placed = atoms.filter((atom): atom is TextAtom => atom.kind === 'text');
    let used = placed.reduce((sum, atom) => sum + atom.width, 0);
    if (used > width) {
      const dots: Atom[] = [];
      this.textAtoms('\u2026', style, dots);
      const ellipsis = dots.filter((atom): atom is TextAtom => atom.kind === 'text');
      const dotsWidth = ellipsis.reduce((sum, atom) => sum + atom.width, 0);
      while (placed.length > 0 && used + dotsWidth > width) {
        const dropped = placed.pop();
        used -= dropped?.width ?? 0;
      }
      placed = [...placed, ...ellipsis];
      used += dotsWidth;
    }
    let at = align === 'right' ? x + width - used : x;
    for (const atom of this.visualOrder(placed) as TextAtom[]) {
      this.drawText(atom.text, at, baselineY, atom.font, atom.size, atom.style.colour);
      at += atom.width;
    }
  }

  private furniture(): void {
    const range = this.doc.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
      this.doc.switchToPage(range.start + index);
      const width = this.textWidth;
      const numberRoom = 90;
      if (this.setup.header.trim()) this.runningLine(this.setup.header, MARGIN, INCH / 2 + 9, width, 'left');
      const footY = this.doc.page.height - INCH / 2;
      if (this.setup.footer.trim()) this.runningLine(this.setup.footer, MARGIN, footY, width - numberRoom, 'left');
      this.runningLine(`Page ${index + 1} of ${range.count}`, MARGIN + width - numberRoom, footY, numberRoom, 'right');
    }
  }

  async render(root: PMNode): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const finished = new Promise<Buffer>((resolve, reject) => {
      this.doc.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      this.doc.on('end', () => resolve(Buffer.concat(chunks)));
      this.doc.on('error', reject);
    });
    const frame: Frame = { x: 0, width: this.textWidth, depth: 0, bold: false, bars: [] };
    const top = root.type === NODE.doc ? (root.content ?? []) : [root];
    this.pour(this.blocks(top, frame));
    if (this.truncated) {
      // Said on the page, not only in a log: whoever reads the PDF must be
      // able to tell that the document went on.
      this.doc.switchToPage(this.doc.bufferedPageRange().count - 1);
      this.runningLine(`This export stops here, at ${MAX_PAGES} pages. The document is longer.`, MARGIN, this.bottom + 14, this.textWidth, 'left');
    }
    this.furniture();
    this.doc.end();
    // pdfkit finishes a see-through PNG in a callback and ends the file only
    // when every one has reported back. If one never does, this promise would
    // never settle and the request would hang with it; better to give up and
    // let the caller fall back to the plain export.
    let timer: NodeJS.Timeout | undefined;
    const overdue = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the PDF did not finish writing')), FINISH_TIMEOUT_MS);
      timer.unref();
    });
    try {
      return await Promise.race([finished, overdue]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function stackHeight(items: readonly Item[]): number {
  let height = 0;
  let previous: Item | null = null;
  for (const item of items) {
    if (item.pageBreak) continue;
    height += (previous ? Math.max(previous.after, item.before) : 0) + item.height;
    previous = item;
  }
  return height;
}

/** How many items from the top of a stack fit in a given height. */
function countFitting(items: readonly Item[], room: number): number {
  let height = 0;
  let previous: Item | null = null;
  let count = 0;
  for (const item of items) {
    if (!item.pageBreak) {
      height += (previous ? Math.max(previous.after, item.before) : 0) + item.height;
      if (height > room) break;
      previous = item;
    }
    count += 1;
  }
  return count;
}

function colourFromAttr(cell: PMNode): string | null {
  const value = cell.attrs?.['background'];
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

/**
 * Export a document as a PDF.
 *
 * This does not throw for anything a document can contain. If the layout
 * itself fails, which would be a defect here and not in the document, the
 * words are exported as plain paragraphs: a plain PDF of the right text is
 * more use to the person waiting for it than an error.
 */
export async function exportPdf(doc: PMNode, options: PdfExportOptions): Promise<Buffer> {
  try {
    return await new Renderer(options).render(doc);
  } catch (error) {
    console.error('PDF export fell back to plain text:', error instanceof Error ? error.message : 'unknown error');
    let words = '';
    try {
      words = toPlainText(doc);
    } catch {
      words = '';
    }
    const plain: PMNode = {
      type: NODE.doc,
      content: words.split('\n').map((line) => ({
        type: NODE.paragraph,
        content: line ? [{ type: NODE.text, text: line }] : [],
      })),
    };
    return new Renderer({ ...options, styles: null, fontDirs: [], systemFonts: false }).render(plain);
  }
}
