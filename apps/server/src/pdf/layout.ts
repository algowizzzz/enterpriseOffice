import type { Picture, Rule, TextPiece } from './extract.js';

/**
 * From loose pieces of text to reading order.
 *
 * A PDF does not hold lines, paragraphs, columns or tables. It holds strings
 * and where to paint them. Everything here is inference from position, and the
 * rule throughout is that a doubtful guess falls back to plain lines of text:
 * a table read as paragraphs is an annoyance, while paragraphs forced into a
 * wrong table are words in the wrong place.
 */

export interface Span {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  family: string | null;
  size: number;
  colour: string | null;
  href: string | null;
  x0: number;
  x1: number;
}

/** A run of text on one baseline with no wide gap inside it. */
export interface Segment {
  x0: number;
  x1: number;
  y: number;
  size: number;
  spans: Span[];
  text: string;
}

export interface Row {
  y: number;
  segments: Segment[];
}

export interface ListMarker {
  ordered: boolean;
  format: 'decimal' | 'lowerLetter' | 'lowerRoman' | 'bullet';
  /** The number an ordered marker stood for, where it was a number. */
  value: number | null;
  /** How many characters at the start of the line are the marker. */
  length: number;
  /** Where the words after the marker begin. */
  textX: number;
}

export interface Line {
  x0: number;
  x1: number;
  y: number;
  size: number;
  spans: Span[];
  text: string;
  marker: ListMarker | null;
  stream: number;
  colLeft: number;
  colRight: number;
  /** The usual distance between baselines where this line sits. */
  pitch: number;
}

export type Block =
  | { kind: 'line'; line: Line }
  | { kind: 'table'; rows: Span[][][]; header: boolean }
  | { kind: 'picture'; picture: Picture }
  | { kind: 'rule' };

const sameStyle = (a: Span, b: Span): boolean =>
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.underline === b.underline &&
  a.family === b.family &&
  a.colour === b.colour &&
  a.href === b.href &&
  Math.abs(a.size - b.size) < 0.26;

/** Wider than this between two pieces and they are not the same run of words. */
const splitGap = (size: number): number => Math.max(size * 0.9, 8);

function dominantSize(spans: Span[]): number {
  const weight = new Map<number, number>();
  for (const span of spans) {
    const key = Math.round(span.size * 2) / 2;
    weight.set(key, (weight.get(key) ?? 0) + span.text.trim().length);
  }
  let best = spans[0]?.size ?? 10;
  let most = -1;
  for (const [size, count] of weight) {
    if (count > most) {
      most = count;
      best = size;
    }
  }
  return best;
}

function finishSegment(spans: Span[], y: number): Segment | null {
  while (spans.length > 0 && (spans[0]?.text.trim().length ?? 0) === 0) spans.shift();
  while (spans.length > 0 && (spans[spans.length - 1]?.text.trim().length ?? 0) === 0) spans.pop();
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (!first || !last) return null;
  first.text = first.text.trimStart();
  last.text = last.text.trimEnd();
  return {
    x0: first.x0,
    x1: last.x1,
    y,
    size: dominantSize(spans),
    spans,
    text: spans.map((span) => span.text).join(''),
  };
}

/**
 * Gather the pieces of one page into rows by baseline, and cut each row into
 * segments wherever the gap is too wide to be a space.
 *
 * The cut is what later lets a row be recognised as two columns of prose or as
 * the cells of a table. A row that turns out to be neither is put back
 * together, so cutting too eagerly costs nothing.
 */
export function buildRows(pieces: TextPiece[]): Row[] {
  const sorted = [...pieces].sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: TextPiece[][] = [];
  let current: TextPiece[] = [];
  let anchor = 0;
  let tallest = 0;
  for (const piece of sorted) {
    // A raised footnote mark sits a third of a line above its sentence. The
    // allowance is tied to the size of the text so that it still stays well
    // inside the distance to the next line.
    const reach = Math.max(tallest, piece.size) * 0.4;
    if (current.length > 0 && Math.abs(piece.y - anchor) <= reach) {
      current.push(piece);
      if (piece.size > tallest) {
        tallest = piece.size;
        anchor = piece.y;
      }
    } else {
      if (current.length > 0) groups.push(current);
      current = [piece];
      anchor = piece.y;
      tallest = piece.size;
    }
  }
  if (current.length > 0) groups.push(current);

  const rows: Row[] = [];
  for (const group of groups) {
    group.sort((a, b) => a.x - b.x);
    const segments: Segment[] = [];
    let spans: Span[] = [];
    let end = -Infinity;
    let previous: TextPiece | null = null;
    let baseline = group[0]?.y ?? 0;
    let widest = -1;
    const close = (): void => {
      const segment = finishSegment(spans, baseline);
      if (segment) segments.push(segment);
      spans = [];
      widest = -1;
    };
    for (const piece of group) {
      const gap = piece.x - end;
      if (spans.length > 0 && gap > splitGap(Math.max(piece.size, previous?.size ?? 0))) close();
      // Bold faked by printing the same words twice, a hair apart, would
      // otherwise come out as every word doubled.
      if (
        previous &&
        previous.text === piece.text &&
        Math.abs(previous.x - piece.x) < 1 &&
        piece.text.trim().length > 0
      ) {
        continue;
      }
      const blank = piece.text.trim().length === 0;
      const last = spans[spans.length - 1];
      if (blank) {
        // pdf.js fills the space between two cells of a table with one blank
        // piece as wide as the gap. Counted as text it bridged the gap, and
        // every table arrived as a line of words. A blank piece is a space at
        // most, and never moves the point the next gap is measured from.
        if (last && !last.text.endsWith(' ') && piece.width <= splitGap(piece.size)) last.text += ' ';
        continue;
      }
      const needsSpace =
        last !== undefined &&
        gap > piece.size * 0.18 &&
        !last.text.endsWith(' ') &&
        !piece.text.startsWith(' ');
      const span: Span = {
        text: piece.text,
        bold: piece.font.bold,
        italic: piece.font.italic,
        underline: false,
        family: piece.font.family,
        size: piece.size,
        colour: piece.colour,
        href: piece.href,
        x0: piece.x,
        x1: piece.x + piece.width,
      };
      if (last && needsSpace) last.text += ' ';
      if (last && sameStyle(last, span)) {
        last.text += span.text;
        last.x1 = Math.max(last.x1, span.x1);
      } else {
        spans.push(span);
      }
      if (piece.width > widest) {
        widest = piece.width;
        baseline = piece.y;
      }

      end = Math.max(end, piece.x + piece.width);
      previous = piece;
    }
    close();
    if (segments.length > 0) rows.push({ y: segments[0]?.y ?? 0, segments });
  }
  return rows;
}

/**
 * Mark text as underlined where a short rule runs just beneath it, and hand
 * back the rules that were not underlines.
 *
 * An underline stops where its words stop. A table border or a rule across the
 * page carries on past them, which is how the two are told apart.
 */
export function takeUnderlines(rows: Row[], rules: Rule[]): Rule[] {
  const candidates = rules.filter((rule) => rule.horizontal);
  if (candidates.length === 0) return rules;
  const used = new Set<Rule>();
  for (const row of rows) {
    for (const segment of row.segments) {
      for (const rule of candidates) {
        const below = rule.y0 - segment.y;
        if (below < 0.3 || below > segment.size * 0.22 + 0.5) continue;
        if (rule.x0 < segment.x0 - 2 || rule.x1 > segment.x1 + 2) continue;
        for (const span of segment.spans) {
          const overlap = Math.min(span.x1, rule.x1) - Math.max(span.x0, rule.x0);
          if (overlap >= (span.x1 - span.x0) * 0.7 && overlap > 0) {
            span.underline = true;
            used.add(rule);
          }
        }
      }
    }
  }
  return rules.filter((rule) => !used.has(rule));
}

interface Gutter {
  x0: number;
  x1: number;
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/**
 * Look for the empty vertical strip between two columns of prose.
 *
 * A table has such strips as well, so an empty strip is not enough. Prose in
 * columns fills its column from edge to edge; the cells of a table mostly do
 * not, and a table is usually crossed by ruling lines. Both are checked, and
 * when they disagree the page is read as one column, where the table detector
 * gets its turn.
 */
function findGutter(segments: Segment[], rules: Rule[]): Gutter | null {
  if (segments.length < 8) return null;
  const left = Math.min(...segments.map((s) => s.x0));
  const right = Math.max(...segments.map((s) => s.x1));
  const width = right - left;
  if (width < 200) return null;

  const cover = new Uint32Array(Math.ceil(width) + 2);
  for (const segment of segments) {
    const from = Math.max(0, Math.floor(segment.x0 - left));
    const to = Math.min(cover.length - 1, Math.ceil(segment.x1 - left));
    for (let x = from; x <= to; x += 1) cover[x] = (cover[x] ?? 0) + 1;
  }
  const from = Math.floor(width * 0.2);
  const to = Math.ceil(width * 0.8);
  let floor = Infinity;
  let peak = 0;
  for (let x = from; x <= to; x += 1) {
    floor = Math.min(floor, cover[x] ?? 0);
    peak = Math.max(peak, cover[x] ?? 0);
  }
  const limit = floor + Math.max(1, Math.floor(peak * 0.1));

  const runs: Gutter[] = [];
  let start = -1;
  for (let x = from; x <= to + 1; x += 1) {
    const low = x <= to && (cover[x] ?? 0) <= limit;
    if (low && start < 0) start = x;
    if (!low && start >= 0) {
      if (x - start >= 8) runs.push({ x0: left + start, x1: left + x - 1 });
      start = -1;
    }
  }

  let best: { gutter: Gutter; crossing: number } | null = null;
  for (const run of runs) {
    const onLeft = segments.filter((s) => s.x1 <= run.x0 + 1.5);
    const onRight = segments.filter((s) => s.x0 >= run.x1 - 1.5);
    const crossing = segments.length - onLeft.length - onRight.length;
    if (onLeft.length < 4 || onRight.length < 4) continue;
    if (crossing > segments.length * 0.4) continue;
    if (median(onLeft.map((s) => s.x1 - s.x0)) < (run.x0 - left) * 0.5) continue;
    if (median(onRight.map((s) => s.x1 - s.x0)) < (right - run.x1) * 0.5) continue;
    const top = Math.max(Math.min(...onLeft.map((s) => s.y)), Math.min(...onRight.map((s) => s.y)));
    const bottom = Math.min(Math.max(...onLeft.map((s) => s.y)), Math.max(...onRight.map((s) => s.y)));
    if (bottom <= top) continue;
    const ruled = rules.filter(
      (rule) =>
        rule.horizontal &&
        rule.x0 < run.x0 &&
        rule.x1 > run.x1 &&
        rule.y0 >= top - 20 &&
        rule.y0 <= bottom + 20,
    ).length;
    if (ruled >= 2) continue;
    if (
      !best ||
      crossing < best.crossing ||
      (crossing === best.crossing && run.x1 - run.x0 > best.gutter.x1 - best.gutter.x0)
    ) {
      best = { gutter: run, crossing };
    }
  }
  return best?.gutter ?? null;
}

interface Stream {
  segments: Segment[];
  pictures: Picture[];
}

/**
 * Put the segments of a page into the order a person reads them in: down the
 * left column, then down the right, with anything that spans both columns (a
 * title, a wide figure) read at the height it sits at.
 */
function readingOrder(
  segments: Segment[],
  pictures: Picture[],
  rules: Rule[],
  depth: number,
): Stream[] {
  const gutter = depth < 2 ? findGutter(segments, rules) : null;
  if (!gutter) return segments.length > 0 || pictures.length > 0 ? [{ segments, pictures }] : [];

  type Entry = { y: number; side: 'left' | 'right' | 'across'; segment?: Segment; picture?: Picture };
  const entries: Entry[] = [];
  for (const segment of segments) {
    const side = segment.x1 <= gutter.x0 + 1.5 ? 'left' : segment.x0 >= gutter.x1 - 1.5 ? 'right' : 'across';
    entries.push({ y: segment.y, side, segment });
  }
  for (const picture of pictures) {
    const side =
      picture.x + picture.width <= gutter.x0 + 1.5
        ? 'left'
        : picture.x >= gutter.x1 - 1.5
          ? 'right'
          : 'across';
    entries.push({ y: picture.y + picture.height, side, picture });
  }
  entries.sort((a, b) => a.y - b.y);

  const streams: Stream[] = [];
  let leftSide: Stream = { segments: [], pictures: [] };
  let rightSide: Stream = { segments: [], pictures: [] };
  let across: Stream = { segments: [], pictures: [] };
  const put = (stream: Stream, entry: Entry): void => {
    if (entry.segment) stream.segments.push(entry.segment);
    if (entry.picture) stream.pictures.push(entry.picture);
  };
  const flushColumns = (): void => {
    for (const side of [leftSide, rightSide]) {
      streams.push(...readingOrder(side.segments, side.pictures, rules, depth + 1));
    }
    leftSide = { segments: [], pictures: [] };
    rightSide = { segments: [], pictures: [] };
  };
  const flushAcross = (): void => {
    if (across.segments.length > 0 || across.pictures.length > 0) streams.push(across);
    across = { segments: [], pictures: [] };
  };
  for (const entry of entries) {
    if (entry.side === 'across') {
      flushColumns();
      put(across, entry);
    } else {
      flushAcross();
      put(entry.side === 'left' ? leftSide : rightSide, entry);
    }
  }
  flushColumns();
  flushAcross();
  return streams;
}

const BULLETS = '\u2022\u25aa\u25cf\u25e6\u25a0\u25a1\u25b8\u27a2\u2023\u2043\u00b7\uf0b7\uf0a7\uf0d8\u2219\u25cb';
const BULLET_LINE = new RegExp(`^([${BULLETS}]|[\\u2013\\u2014*-](?=\\s))\\s*`, 'u');
const NUMBER_LINE = /^(?:\((\d{1,3}|[a-z]|[ivxl]{1,6})\)|(\d{1,3}|[a-z]|[ivxl]{1,6})[.)])\s+/u;
const ROMAN = /^(?=[ivxl])(x{0,3})(ix|iv|v?i{0,3})$/u;

const ROMAN_VALUES: Record<string, number> = { i: 1, v: 5, x: 10, l: 50 };
function romanValue(text: string): number {
  let total = 0;
  for (let i = 0; i < text.length; i += 1) {
    const value = ROMAN_VALUES[text[i] ?? ''] ?? 0;
    const next = ROMAN_VALUES[text[i + 1] ?? ''] ?? 0;
    total += value < next ? -value : value;
  }
  return total;
}

/**
 * Whether a line opens with a bullet or a number, and how much of it that is.
 *
 * A lone letter "o" is a bullet in a great many Word documents and the start
 * of an ordinary word in all the others, so it only counts when the PDF set it
 * as a piece of its own with a gap after it.
 */
function markerOf(segments: Segment[]): ListMarker | null {
  const first = segments[0];
  if (!first) return null;
  const text = segments.map((s) => s.text).join(' ');
  const second = segments[1];
  const alone = second !== undefined;
  const textXAfter = (length: number): number => {
    if (alone && first.text.length <= length) return second.x0;
    const share = Math.min(1, length / Math.max(1, first.text.length));
    return first.x0 + (first.x1 - first.x0) * share;
  };

  if (alone && first.text === 'o') {
    return { ordered: false, format: 'bullet', value: null, length: 2, textX: second.x0 };
  }
  const bullet = BULLET_LINE.exec(text);
  if (bullet && text.length > bullet[0].length) {
    return { ordered: false, format: 'bullet', value: null, length: bullet[0].length, textX: textXAfter(bullet[0].length) };
  }
  const number = NUMBER_LINE.exec(text);
  if (number && text.length > number[0].length) {
    const token = number[1] ?? number[2] ?? '';
    let format: ListMarker['format'] = 'decimal';
    let value: number | null = null;
    if (/^\d+$/u.test(token)) {
      value = Number(token);
    } else if (ROMAN.test(token) && (token.length > 1 || token === 'i')) {
      format = 'lowerRoman';
      value = romanValue(token);
    } else if (token.length === 1) {
      format = 'lowerLetter';
      value = token.charCodeAt(0) - 96;
    } else {
      return null;
    }
    return { ordered: true, format, value, length: number[0].length, textX: textXAfter(number[0].length) };
  }
  return null;
}

function joinSegments(segments: Segment[]): Span[] {
  const spans: Span[] = [];
  segments.forEach((segment, index) => {
    segment.spans.forEach((span, at) => {
      const copy = { ...span };
      if (index > 0 && at === 0) copy.text = ` ${copy.text}`;
      const last = spans[spans.length - 1];
      if (last && sameStyle(last, copy)) {
        last.text += copy.text;
        last.x1 = copy.x1;
      } else {
        spans.push(copy);
      }
    });
  });
  return spans;
}

interface StreamRow extends Row {
  marker: ListMarker | null;
}

/** The empty vertical strips shared by every one of these rows. */
function sharedGutters(rows: Row[]): Gutter[] {
  const segments = rows.flatMap((row) => row.segments);
  if (segments.length === 0) return [];
  const spans = segments.map((s) => [s.x0, s.x1] as const).sort((a, b) => a[0] - b[0]);
  const gutters: Gutter[] = [];
  let reach = spans[0]?.[1] ?? 0;
  for (const [x0, x1] of spans) {
    if (x0 - reach >= 5) gutters.push({ x0: reach, x1: x0 });
    reach = Math.max(reach, x1);
  }
  return gutters;
}

const columnOf = (segment: Segment, gutters: Gutter[]): number => {
  const middle = (segment.x0 + segment.x1) / 2;
  let column = 0;
  for (const gutter of gutters) if (middle > gutter.x1 - 0.5) column += 1;
  return column;
};

const fitsOneColumn = (segment: Segment, gutters: Gutter[]): boolean =>
  gutters.every((gutter) => segment.x1 <= gutter.x0 + 0.5 || segment.x0 >= gutter.x1 - 0.5);

interface TableFind {
  block: Extract<Block, { kind: 'table' }>;
  top: number;
  bottom: number;
  next: number;
}

/**
 * Try to read a table starting at this row.
 *
 * It takes three rows that share their column gaps before text with no ruling
 * lines is believed to be a table, and two where lines are drawn around it.
 * Two lines of a form ("Name ... Date ...") line up by accident often enough
 * that believing them made tables out of ordinary letters.
 */
function tableAt(rows: StreamRow[], start: number, rules: Rule[]): TableFind | null {
  const first = rows[start];
  if (!first || first.segments.length < 2 || first.marker) return null;
  const multi: StreamRow[] = [first];
  const taken: StreamRow[] = [first];
  let end = start;
  while (end + 1 < rows.length && taken.length < 2000) {
    const previous = rows[end];
    const next = rows[end + 1];
    if (!previous || !next) break;
    const size = Math.max(previous.segments[0]?.size ?? 10, next.segments[0]?.size ?? 10);
    const gap = next.y - previous.y;
    if (gap > size * 3.2) break;
    if (next.segments.length >= 2 && !next.marker) {
      if (sharedGutters([...multi, next]).length === 0) break;
      multi.push(next);
    } else {
      // A cell whose words run to two or three lines puts lines of its own
      // between the full rows. Stopping at the first of them cut one table
      // into four with loose lines between, so a lone run of words that stays
      // inside one column is taken along, for now.
      const only = next.segments[0];
      if (only === undefined || next.marker || !fitsOneColumn(only, sharedGutters(multi))) break;
    }
    taken.push(next);
    end += 1;
  }
  // Whatever trails the last full row belongs to the table only while it keeps
  // the spacing of a wrapped line. Anything looser is the text after the table.
  const lastFull = taken.lastIndexOf(multi[multi.length - 1] ?? first);
  let keep = lastFull;
  while (keep + 1 < taken.length) {
    const above = taken[keep];
    const below = taken[keep + 1];
    if (!above || !below || below.y - above.y > (below.segments[0]?.size ?? 10) * 1.35) break;
    keep += 1;
  }
  end -= taken.length - 1 - keep;
  taken.length = keep + 1;

  const gutters = sharedGutters(multi);
  if (gutters.length === 0) return null;
  const left = Math.min(...multi.flatMap((row) => row.segments.map((s) => s.x0)));
  const right = Math.max(...multi.flatMap((row) => row.segments.map((s) => s.x1)));
  const size = first.segments[0]?.size ?? 10;
  const top = first.y - size * 1.6;
  const bottom = (rows[end]?.y ?? first.y) + size;
  const across = rules.filter(
    (rule) =>
      rule.horizontal &&
      rule.y0 >= top &&
      rule.y0 <= bottom &&
      Math.min(rule.x1, right) - Math.max(rule.x0, left) >= (right - left) * 0.5,
  );
  const upright = rules.filter(
    (rule) => !rule.horizontal && rule.y1 >= top && rule.y0 <= bottom && rule.x0 >= left - 12 && rule.x0 <= right + 12,
  );
  const ruled = across.length >= 2 || upright.length >= 1;
  if (multi.length < (ruled ? 2 : 3)) return null;

  // Where ruling lines separate nearly every row they say exactly which lines
  // of text share a cell. A table ruled only under its heading says nothing
  // about the rows beneath, so there the spacing has to decide instead.
  const lineYs: number[] = [];
  for (const rule of [...across].sort((a, b) => a.y0 - b.y0)) {
    if (lineYs.length === 0 || rule.y0 - (lineYs[lineYs.length - 1] ?? 0) > 1.5) lineYs.push(rule.y0);
  }
  const bandOf = (row: StreamRow): number =>
    lineYs.filter((y) => y < row.y - (row.segments[0]?.size ?? 10) * 0.3).length;
  const bandsUsed = new Set(multi.map(bandOf)).size;
  const byRules = lineYs.length >= 2 && bandsUsed >= multi.length * 0.6;

  const columns = gutters.length + 1;
  const grouped: Segment[][][] = [];
  let lastBand = -1;
  let joinNext = false;
  taken.forEach((row, index) => {
    const before = taken[index - 1];
    const after = taken[index + 1];
    const reach = (row.segments[0]?.size ?? 10) * 1.35;
    const gapBefore = before ? row.y - before.y : Infinity;
    const gapAfter = after ? after.y - row.y : Infinity;
    const partial =
      row.segments.length === 1 || row.segments.every((segment) => columnOf(segment, gutters) > 0);
    let continues: boolean;
    if (byRules) {
      continues = bandOf(row) === lastBand;
    } else if (joinNext) {
      continues = true;
    } else {
      continues = partial && gapBefore <= reach && gapBefore <= gapAfter && grouped.length > 0;
    }
    // A label of two lines beside a one-line row starts above that row, so
    // the lone line opens the row and the full line after it joins in.
    joinNext = !byRules && !continues && row.segments.length === 1 && gapAfter <= reach;
    lastBand = bandOf(row);
    let cells = grouped[grouped.length - 1];
    if (!continues || !cells) {
      cells = Array.from({ length: columns }, () => []);
      grouped.push(cells);
    }
    for (const segment of row.segments) cells[columnOf(segment, gutters)]?.push(segment);
  });
  if (grouped.length < 2) return null;

  const tableRows = grouped.map((cells) => cells.map((cell) => joinSegments(cell)));
  const allBold = (cells: Span[][]): boolean => {
    const spans = cells.flat();
    return spans.length > 0 && spans.every((span) => span.bold);
  };
  const head = tableRows[0];
  const header = head !== undefined && allBold(head) && !tableRows.slice(1).every(allBold);
  return { block: { kind: 'table', rows: tableRows, header }, top, bottom, next: end + 1 };
}

/**
 * Lay out one page: reading order first, then tables, lists and plain lines
 * within each column.
 */
export function layoutPage(
  rows: Row[],
  pictures: Picture[],
  allRules: Rule[],
  nextStream: { value: number },
): Block[] {
  const rules = takeUnderlines(rows, allRules);
  const drawn = new Set<Rule>();
  const segments = rows.flatMap((row) => row.segments);
  const blocks: Block[] = [];

  for (const stream of readingOrder(segments, pictures, rules, 0)) {
    const id = nextStream.value;
    nextStream.value += 1;

    const sorted = [...stream.segments].sort((a, b) => a.y - b.y || a.x0 - b.x0);
    const streamRows: StreamRow[] = [];
    for (const segment of sorted) {
      const last = streamRows[streamRows.length - 1];
      if (last && Math.abs(last.y - segment.y) <= Math.max(segment.size, last.segments[0]?.size ?? 0) * 0.3) {
        last.segments.push(segment);
      } else {
        streamRows.push({ y: segment.y, segments: [segment], marker: null });
      }
    }
    for (const row of streamRows) {
      row.segments.sort((a, b) => a.x0 - b.x0);
      const marker = markerOf(row.segments);
      // "1.  Widget  4.00" is a table row that happens to be numbered. A list
      // item has its marker and then one run of words.
      const first = row.segments[0];
      const markerStandsAlone = first !== undefined && first.text.length <= (marker?.length ?? 0);
      // A bullet set apart from its words is a list item however widely the
      // justified words after it are spaced.
      const spread = marker !== null && !marker.ordered && markerStandsAlone;
      if (marker && (row.segments.length === 1 || (row.segments.length === 2 && markerStandsAlone) || spread)) {
        row.marker = marker;
      }
    }

    const colLeft = Math.min(...stream.segments.map((s) => s.x0));
    const colRight = Math.max(...stream.segments.map((s) => s.x1));
    const gaps: number[] = [];
    for (let i = 1; i < streamRows.length; i += 1) {
      const a = streamRows[i - 1];
      const b = streamRows[i];
      if (!a || !b) continue;
      const size = a.segments[0]?.size ?? 10;
      const gap = b.y - a.y;
      if (Math.abs(size - (b.segments[0]?.size ?? 10)) < 0.6 && gap >= size * 0.8 && gap <= size * 2.5) gaps.push(gap);
    }
    gaps.sort((a, b) => a - b);
    const pitch = gaps[Math.floor(gaps.length * 0.2)] ?? 0;

    type Placed = { y: number; block: Block };
    const placed: Placed[] = [];
    const tableSpans: { top: number; bottom: number }[] = [];
    let index = 0;
    while (index < streamRows.length) {
      const row = streamRows[index];
      if (!row) break;
      const table = tableAt(streamRows, index, rules);
      if (table) {
        placed.push({ y: row.y, block: table.block });
        tableSpans.push({ top: table.top, bottom: table.bottom });
        index = table.next;
        continue;
      }
      const spans = joinSegments(row.segments);
      const x0 = row.segments[0]?.x0 ?? 0;
      const x1 = row.segments[row.segments.length - 1]?.x1 ?? x0;
      placed.push({
        y: row.y,
        block: {
          kind: 'line',
          line: {
            x0,
            x1,
            y: row.y,
            size: dominantSize(spans),
            spans,
            text: spans.map((span) => span.text).join(''),
            marker: row.marker,
            stream: id,
            colLeft,
            colRight,
            pitch,
          },
        },
      });
      index += 1;
    }
    for (const picture of stream.pictures) {
      placed.push({ y: picture.y + picture.height, block: { kind: 'picture', picture } });
    }

    // A rule on its own across the column is a divider somebody drew. One of
    // several close together is a box or the remains of a table, and turning
    // each of those into a divider filled pages with stray lines.
    const wide = rules.filter(
      (rule) =>
        rule.horizontal &&
        Number.isFinite(colLeft) &&
        rule.x0 >= colLeft - 20 &&
        rule.x1 <= colRight + 20 &&
        rule.x1 - rule.x0 >= (colRight - colLeft) * 0.5,
    );
    for (const rule of wide) {
      const crowded = rules.some(
        (other) =>
          other !== rule &&
          (other.horizontal
            ? Math.abs(other.y0 - rule.y0) < 40 && other.x0 < rule.x1 && other.x1 > rule.x0
            : other.y0 <= rule.y0 + 2 && other.y1 >= rule.y0 - 2 && other.x0 >= rule.x0 - 2 && other.x0 <= rule.x1 + 2),
      );
      const inTable = tableSpans.some((span) => rule.y0 >= span.top && rule.y0 <= span.bottom);
      const inside =
        streamRows.length > 0 &&
        rule.y0 > (streamRows[0]?.y ?? 0) - 40 &&
        rule.y0 < (streamRows[streamRows.length - 1]?.y ?? 0) + 40;
      if (!crowded && !inTable && inside && !drawn.has(rule)) {
        drawn.add(rule);
        placed.push({ y: rule.y0, block: { kind: 'rule' } });
      }
    }

    placed.sort((a, b) => a.y - b.y);
    blocks.push(...placed.map((entry) => entry.block));
  }
  return blocks;
}
