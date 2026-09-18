import { OPS, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { isSafeHref } from '@docforge/model';
import { encodePng, type RawImage } from './png.js';

/**
 * What one page of a PDF holds, in the terms the layout pass works in.
 *
 * Everything here is in points, measured from the top left of the page as it is
 * shown, with y growing downwards. A PDF measures from the bottom left, and a
 * page may be rotated or have its origin somewhere other than a corner, so the
 * conversion is done once, here, through the page's own viewport. Doing it
 * later meant every rule about "above" and "below" had to be written twice.
 */
export interface PageData {
  index: number;
  width: number;
  height: number;
  items: TextPiece[];
  /** Text set at an angle, which cannot take part in line building. */
  rotated: TextPiece[];
  rules: Rule[];
  pictures: Picture[];
  /** Whether the page paints any picture at all, kept or not. */
  paintsImages: boolean;
  picturesSkipped: number;
}

export interface FontInfo {
  bold: boolean;
  italic: boolean;
  family: string | null;
}

export interface TextPiece {
  text: string;
  x: number;
  /** The baseline. */
  y: number;
  width: number;
  size: number;
  font: FontInfo;
  colour: string | null;
  href: string | null;
}

/** A straight ruling line, horizontal or vertical. */
export interface Rule {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  horizontal: boolean;
}

export interface Picture {
  x: number;
  y: number;
  width: number;
  height: number;
  src: string;
}

export interface PictureBudget {
  /** How many more pictures may be kept. */
  remaining: number;
  /** How many more encoded bytes may be kept. */
  bytes: number;
}

export const MAX_PICTURE_BYTES = 4 * 1024 * 1024;

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `b` first, then `a`, which is the order a PDF composes its matrices in. */
function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

function matrixFrom(value: unknown): Matrix | null {
  // pdf.js hands a matrix over either as six arguments or as one array of six,
  // depending on the operator and the release.
  const source =
    Array.isArray(value) && value.length === 1 && typeof value[0] === 'object' ? value[0] : value;
  if (source === null || typeof source !== 'object') return null;
  const list = Array.from(source as ArrayLike<unknown>);
  if (list.length < 6) return null;
  const numbers = list.slice(0, 6).map((entry) => (typeof entry === 'number' ? entry : NaN));
  if (numbers.some((entry) => !Number.isFinite(entry))) return null;
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = numbers;
  return [a, b, c, d, e, f];
}

interface RawTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
}

const isTextItem = (item: unknown): item is RawTextItem =>
  typeof item === 'object' &&
  item !== null &&
  typeof (item as { str?: unknown }).str === 'string' &&
  Array.isArray((item as { transform?: unknown }).transform);

/**
 * A readable family name from whatever the PDF calls its font.
 *
 * An embedded font is usually a subset with a six-letter tag in front and the
 * weight welded on behind, "ABCDEE+Calibri-Bold" or "TimesNewRomanPS-BoldMT".
 * Offering that in the font list as it stands gave people a font nothing on
 * their machine answers to, so it is reduced to the family a person would
 * recognise, or to nothing when the name is only a generated label.
 */
export function familyFromFontName(name: string): string | null {
  let family = name.replace(/^[A-Z]{6}\+/u, '');
  family = family.split(/[-,]/u)[0] ?? '';
  family = family
    .replace(/(PS)?MT$/u, '')
    .replace(/PS$/u, '')
    .replace(/(Bold|Italic|Oblique|Regular|Roman|Medium|Light|Semibold|Black|Heavy)+$/u, '')
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .replace(/[^\p{L}\p{N} _.]/gu, '')
    .trim();
  if (family.length < 3 || /^(g_|[A-Z]{1,3}\d+$|CIDFont|Type\d)/u.test(family)) return null;
  return family.slice(0, 60);
}

const NO_FONT: FontInfo = { bold: false, italic: false, family: null };

function fontInfoFor(page: PDFPageProxy, fontName: string, cache: Map<string, FontInfo>): FontInfo {
  const known = cache.get(fontName);
  if (known) return known;
  let info = NO_FONT;
  try {
    if (page.commonObjs.has(fontName)) {
      const font = page.commonObjs.get(fontName) as {
        name?: unknown;
        bold?: unknown;
        italic?: unknown;
        black?: unknown;
      } | null;
      const name = typeof font?.name === 'string' ? font.name : '';
      const styled = name.replace(/^[A-Z]{6}\+/u, '');
      info = {
        bold:
          font?.bold === true ||
          font?.black === true ||
          /bold|black|heavy|semibold|demi/iu.test(styled),
        italic: font?.italic === true || /italic|oblique/iu.test(styled),
        family: familyFromFontName(name),
      };
    }
  } catch {
    // A font that failed to load still leaves its text readable, only unstyled.
  }
  cache.set(fontName, info);
  return info;
}

interface InkMark {
  x: number;
  y: number;
  colour: string | null;
}

interface Walked {
  rules: Rule[];
  pictures: Picture[];
  ink: InkMark[];
  paintsImages: boolean;
  picturesSkipped: number;
}

const MAX_RULES = 5000;
/** Shorter than this and a stroke is a tick or part of a drawing, not a ruling. */
const MIN_RULE_LENGTH = 8;
/** A filled box this thin is a line drawn the way Word draws one. */
const MAX_RULE_THICKNESS = 3;

interface GraphicsState {
  ctm: Matrix;
  fill: string | null;
}

const PX_PER_PT = 96 / 72;

/**
 * Read the page's drawing instructions once, for the three things the text
 * layer cannot say: where the ruling lines are, where the pictures sit, and
 * what colour each run of text was painted in.
 */
function walkOperators(
  page: PDFPageProxy,
  fnArray: number[],
  argsArray: unknown[],
  view: Matrix,
  budget: PictureBudget,
): Walked {
  const out: Walked = { rules: [], pictures: [], ink: [], paintsImages: false, picturesSkipped: 0 };
  const stack: GraphicsState[] = [];
  let state: GraphicsState = { ctm: IDENTITY, fill: '#000000' };

  let textMatrix: Matrix = IDENTITY;
  let lineMatrix: Matrix = IDENTITY;
  let leading = 0;
  let fontSize = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let horizontalScale = 1;

  const moveLine = (x: number, y: number): void => {
    lineMatrix = mul(lineMatrix, [1, 0, 0, 1, x, y]);
    textMatrix = lineMatrix;
  };

  const showText = (glyphs: unknown): void => {
    const [x, y] = apply(mul(view, mul(state.ctm, textMatrix)), 0, 0);
    out.ink.push({ x, y, colour: state.fill });
    if (!Array.isArray(glyphs)) return;
    let advance = 0;
    for (const glyph of glyphs) {
      if (typeof glyph === 'number') {
        advance -= (glyph / 1000) * fontSize;
      } else if (glyph !== null && typeof glyph === 'object') {
        const g = glyph as { width?: unknown; isSpace?: unknown };
        const width = typeof g.width === 'number' ? g.width : 0;
        advance += (width / 1000) * fontSize + charSpacing + (g.isSpace === true ? wordSpacing : 0);
      }
    }
    textMatrix = mul(textMatrix, [1, 0, 0, 1, advance * horizontalScale, 0]);
  };

  const addRule = (ax: number, ay: number, bx: number, by: number): void => {
    if (out.rules.length >= MAX_RULES) return;
    const dx = Math.abs(bx - ax);
    const dy = Math.abs(by - ay);
    if (dy <= 0.75 && dx >= MIN_RULE_LENGTH) {
      const y = (ay + by) / 2;
      out.rules.push({ x0: Math.min(ax, bx), x1: Math.max(ax, bx), y0: y, y1: y, horizontal: true });
    } else if (dx <= 0.75 && dy >= MIN_RULE_LENGTH) {
      const x = (ax + bx) / 2;
      out.rules.push({ x0: x, x1: x, y0: Math.min(ay, by), y1: Math.max(ay, by), horizontal: false });
    }
  };

  const readPath = (args: unknown): void => {
    if (!Array.isArray(args)) return;
    const paint = args[0] as number;
    const data = Array.isArray(args[1]) ? (args[1][0] as ArrayLike<number> | null) : null;
    if (!data || data.length > 20000) return;
    const strokes = paint === OPS.stroke || paint === OPS.closeStroke;
    const fills =
      paint === OPS.fill ||
      paint === OPS.eoFill ||
      paint === OPS.fillStroke ||
      paint === OPS.eoFillStroke ||
      paint === OPS.closeFillStroke ||
      paint === OPS.closeEOFillStroke;
    if (!strokes && !fills) return;
    const device = mul(view, state.ctm);

    const points: [number, number][] = [];
    let curved = false;
    const flush = (closed: boolean): void => {
      if (points.length >= 2 && !curved) {
        if (strokes || paint === OPS.fillStroke || paint === OPS.eoFillStroke) {
          for (let i = 1; i < points.length; i += 1) {
            const a = points[i - 1];
            const b = points[i];
            if (a && b) addRule(a[0], a[1], b[0], b[1]);
          }
          const first = points[0];
          const last = points[points.length - 1];
          if (closed && first && last) addRule(last[0], last[1], first[0], first[1]);
        } else {
          // Filled and not stroked: only a sliver counts, as a line. A filled
          // box of any real height is shading behind text, not a ruling.
          const xs = points.map((p) => p[0]);
          const ys = points.map((p) => p[1]);
          const x0 = Math.min(...xs);
          const x1 = Math.max(...xs);
          const y0 = Math.min(...ys);
          const y1 = Math.max(...ys);
          if (y1 - y0 <= MAX_RULE_THICKNESS && x1 - x0 >= MIN_RULE_LENGTH) {
            addRule(x0, (y0 + y1) / 2, x1, (y0 + y1) / 2);
          } else if (x1 - x0 <= MAX_RULE_THICKNESS && y1 - y0 >= MIN_RULE_LENGTH) {
            addRule((x0 + x1) / 2, y0, (x0 + x1) / 2, y1);
          }
        }
      }
      points.length = 0;
      curved = false;
    };

    let i = 0;
    while (i < data.length) {
      const op = data[i];
      if (op === 0) {
        flush(false);
        points.push(apply(device, data[i + 1] ?? 0, data[i + 2] ?? 0));
        i += 3;
      } else if (op === 1) {
        points.push(apply(device, data[i + 1] ?? 0, data[i + 2] ?? 0));
        i += 3;
      } else if (op === 2) {
        curved = true;
        i += 7;
      } else if (op === 3) {
        curved = true;
        i += 5;
      } else if (op === 4) {
        flush(true);
        i += 1;
      } else {
        // An instruction this reader does not know: stop rather than misread
        // the numbers after it as coordinates.
        return;
      }
    }
    flush(false);
  };

  const readImage = (source: unknown): void => {
    out.paintsImages = true;
    const device = mul(view, state.ctm);
    const corners = [apply(device, 0, 0), apply(device, 1, 0), apply(device, 0, 1), apply(device, 1, 1)];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const width = Math.max(...xs) - x;
    const height = Math.max(...ys) - y;
    // Hairlines and dots painted as images are decoration, and a PDF made from
    // a slide deck can hold thousands of them.
    if (width < 6 || height < 6) return;
    if (budget.remaining <= 0) {
      out.picturesSkipped += 1;
      return;
    }
    let raw: unknown = source;
    if (typeof source === 'string') {
      try {
        const store = source.startsWith('g_') ? page.commonObjs : page.objs;
        raw = store.has(source) ? store.get(source) : null;
      } catch {
        raw = null;
      }
    }
    const image = raw as Partial<RawImage> | null;
    if (
      !image ||
      typeof image.width !== 'number' ||
      typeof image.height !== 'number' ||
      typeof image.kind !== 'number' ||
      !(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray)
    ) {
      out.picturesSkipped += 1;
      return;
    }
    const shownWidth = Math.max(1, Math.round(width * PX_PER_PT));
    const png = encodePng(
      { width: image.width, height: image.height, kind: image.kind, data: image.data },
      shownWidth,
    );
    if (!png || png.length > MAX_PICTURE_BYTES || png.length > budget.bytes) {
      out.picturesSkipped += 1;
      return;
    }
    budget.remaining -= 1;
    budget.bytes -= png.length;
    out.pictures.push({
      x,
      y,
      width,
      height,
      src: `data:image/png;base64,${png.toString('base64')}`,
    });
  };

  const count = Math.min(fnArray.length, argsArray.length);
  for (let index = 0; index < count; index += 1) {
    const fn = fnArray[index];
    const args = argsArray[index];
    const list = Array.isArray(args) ? (args as unknown[]) : [];
    const number = (at: number): number => (typeof list[at] === 'number' ? list[at] : 0);
    switch (fn) {
      case OPS.save:
        if (stack.length < 256) stack.push(state);
        break;
      case OPS.restore:
        state = stack.pop() ?? state;
        break;
      case OPS.transform: {
        const m = matrixFrom(list);
        if (m) state = { ...state, ctm: mul(state.ctm, m) };
        break;
      }
      case OPS.paintFormXObjectBegin: {
        if (stack.length < 256) stack.push(state);
        const m = matrixFrom(list[0]);
        if (m) state = { ...state, ctm: mul(state.ctm, m) };
        break;
      }
      case OPS.paintFormXObjectEnd:
        state = stack.pop() ?? state;
        break;
      case OPS.setFillRGBColor:
        state = {
          ...state,
          fill: typeof list[0] === 'string' && /^#[0-9a-f]{6}$/iu.test(list[0]) ? list[0].toLowerCase() : null,
        };
        break;
      case OPS.setFillColorN:
      case OPS.setFillTransparent:
        state = { ...state, fill: null };
        break;
      case OPS.beginText:
        textMatrix = IDENTITY;
        lineMatrix = IDENTITY;
        break;
      case OPS.setTextMatrix: {
        const m = matrixFrom(list);
        if (m) {
          textMatrix = m;
          lineMatrix = m;
        }
        break;
      }
      case OPS.setFont:
        fontSize = number(1);
        break;
      case OPS.setLeading:
        leading = number(0);
        break;
      case OPS.setCharSpacing:
        charSpacing = number(0);
        break;
      case OPS.setWordSpacing:
        wordSpacing = number(0);
        break;
      case OPS.setHScale:
        horizontalScale = number(0) / 100 || 1;
        break;
      case OPS.moveText:
        moveLine(number(0), number(1));
        break;
      case OPS.setLeadingMoveText:
        leading = -number(1);
        moveLine(number(0), number(1));
        break;
      case OPS.nextLine:
        moveLine(0, -leading);
        break;
      case OPS.showText:
      case OPS.showSpacedText:
        showText(list[0]);
        break;
      case OPS.nextLineShowText:
        moveLine(0, -leading);
        showText(list[0]);
        break;
      case OPS.nextLineSetSpacingShowText:
        wordSpacing = number(0);
        charSpacing = number(1);
        moveLine(0, -leading);
        showText(list[2]);
        break;
      case OPS.constructPath:
        readPath(args);
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
        readImage(list[0]);
        break;
      case OPS.paintImageXObjectRepeat:
      case OPS.paintImageMaskXObject:
        out.paintsImages = true;
        break;
      default:
        break;
    }
  }
  return out;
}

interface LinkArea {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  href: string;
  text: string | null;
}

/**
 * Give a piece of text its link, cutting the piece where the link covers only
 * part of it.
 *
 * pdf.js hands a whole line over as one piece, so a link on three words in the
 * middle of a sentence either claimed the entire line or, with a stricter
 * test, nothing. The annotation usually says which words it lies over; failing
 * that the cut is placed in proportion and moved to the nearest space.
 */
function applyLinks(piece: TextPiece, links: LinkArea[]): TextPiece[] {
  const top = piece.y - piece.size * 0.8;
  const bottom = piece.y + piece.size * 0.2;
  const middle = (top + bottom) / 2;
  for (const link of links) {
    if (middle < link.y0 || middle > link.y1) continue;
    const left = Math.max(piece.x, link.x0 - 1);
    const right = Math.min(piece.x + piece.width, link.x1 + 1);
    if (right - left <= 0 || piece.width <= 0) continue;
    if (right - left >= piece.width * 0.9) return [{ ...piece, href: link.href }];

    const length = piece.text.length;
    let from = -1;
    let to = -1;
    if (link.text && link.text.trim().length > 0) {
      const at = piece.text.indexOf(link.text.trim());
      if (at >= 0) {
        from = at;
        to = at + link.text.trim().length;
      }
    }
    if (from < 0) {
      const snap = (fraction: number): number => {
        const ideal = Math.round(fraction * length);
        for (let reach = 0; reach <= 4; reach += 1) {
          for (const at of [ideal - reach, ideal + reach]) {
            if (at <= 0) return 0;
            if (at >= length) return length;
            if (piece.text[at] === ' ' || piece.text[at - 1] === ' ') return at;
          }
        }
        return ideal;
      };
      from = snap((left - piece.x) / piece.width);
      to = snap((right - piece.x) / piece.width);
    }
    if (to <= from) continue;
    const perChar = piece.width / Math.max(1, length);
    const cut = (start: number, end: number, href: string | null): TextPiece => ({
      ...piece,
      text: piece.text.slice(start, end),
      x: piece.x + start * perChar,
      width: (end - start) * perChar,
      href,
    });
    const parts: TextPiece[] = [];
    if (from > 0) parts.push(cut(0, from, null));
    parts.push(cut(from, to, link.href));
    // What follows may carry a second link of its own.
    if (to < length) parts.push(...applyLinks(cut(to, length, null), links.filter((l) => l !== link)));
    return parts;
  }
  return [piece];
}

async function readLinks(page: PDFPageProxy, view: Matrix): Promise<LinkArea[]> {
  const links: LinkArea[] = [];
  try {
    const annotations = (await page.getAnnotations()) as unknown[];
    for (const entry of annotations.slice(0, 2000)) {
      const annotation = entry as {
        subtype?: unknown;
        url?: unknown;
        rect?: unknown;
        overlaidText?: unknown;
      };
      if (annotation.subtype !== 'Link' || typeof annotation.url !== 'string') continue;
      if (!isSafeHref(annotation.url)) continue;
      const rect = Array.isArray(annotation.rect) ? (annotation.rect as unknown[]) : [];
      if (rect.length < 4 || rect.some((value) => typeof value !== 'number')) continue;
      const [ax, ay] = apply(view, rect[0] as number, rect[1] as number);
      const [bx, by] = apply(view, rect[2] as number, rect[3] as number);
      links.push({
        x0: Math.min(ax, bx),
        x1: Math.max(ax, bx),
        y0: Math.min(ay, by),
        y1: Math.max(ay, by),
        href: annotation.url,
        text: typeof annotation.overlaidText === 'string' ? annotation.overlaidText : null,
      });
    }
  } catch {
    // Links are a nicety. A page whose annotations cannot be read keeps its text.
  }
  return links;
}

/** Text lighter than this was written on a dark panel the import does not keep. */
function isTooPaleToRead(colour: string): boolean {
  const r = parseInt(colour.slice(1, 3), 16);
  const g = parseInt(colour.slice(3, 5), 16);
  const b = parseInt(colour.slice(5, 7), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 225;
}

export async function extractPage(
  page: PDFPageProxy,
  index: number,
  fonts: Map<string, FontInfo>,
  budget: PictureBudget,
  itemLimit: number,
): Promise<PageData> {
  const viewport = page.getViewport({ scale: 1 });
  const view = matrixFrom(viewport.transform) ?? IDENTITY;

  // The operator list comes first: reading it is what loads the fonts, and the
  // font is the only place a PDF says that text is bold.
  let walked: Walked = { rules: [], pictures: [], ink: [], paintsImages: false, picturesSkipped: 0 };
  try {
    const operators = await page.getOperatorList();
    walked = walkOperators(page, operators.fnArray, operators.argsArray as unknown[], view, budget);
  } catch {
    // The text layer is read separately, so a page whose drawing cannot be
    // followed still gives up its words.
  }

  const ink = new Map<number, InkMark[]>();
  for (const mark of walked.ink) {
    const key = Math.round(mark.y);
    const bucket = ink.get(key);
    if (bucket) bucket.push(mark);
    else ink.set(key, [mark]);
  }
  const colourAt = (x: number, y: number): string | null => {
    const key = Math.round(y);
    for (const bucket of [ink.get(key), ink.get(key - 1), ink.get(key + 1)]) {
      for (const mark of bucket ?? []) {
        if (Math.abs(mark.y - y) <= 1 && Math.abs(mark.x - x) <= 1.5) return mark.colour;
      }
    }
    return null;
  };

  const links = await readLinks(page, view);
  const content = await page.getTextContent();
  const items: TextPiece[] = [];
  const rotated: TextPiece[] = [];
  for (const raw of content.items as unknown[]) {
    if (items.length + rotated.length >= itemLimit) break;
    if (!isTextItem(raw) || raw.str.length === 0) continue;
    const local = matrixFrom(raw.transform);
    if (!local) continue;
    const m = mul(view, local);
    const size = Math.hypot(m[2], m[3]) || Math.abs(raw.height) || 10;
    const colour = colourAt(m[4], m[5]);
    const piece: TextPiece = {
      text: raw.str,
      x: m[4],
      y: m[5],
      width: Math.max(0, raw.width),
      size,
      font: fontInfoFor(page, raw.fontName, fonts),
      colour: colour && colour !== '#000000' && !isTooPaleToRead(colour) ? colour : null,
      href: null,
    };
    if (Math.abs(Math.atan2(m[1], m[0])) > 0.2) {
      if (piece.text.trim().length > 0) rotated.push(piece);
      continue;
    }
    items.push(...(links.length > 0 ? applyLinks(piece, links) : [piece]));
  }

  return {
    index,
    width: viewport.width,
    height: viewport.height,
    items,
    rotated,
    rules: walked.rules,
    pictures: walked.pictures,
    paintsImages: walked.paintsImages,
    picturesSkipped: walked.picturesSkipped,
  };
}
