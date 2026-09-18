import { NODE, MARK, isEmbeddedImageSrc, isSafeHref, type PMMark, type PMNode } from '@docforge/model';
import type { Block, Line, ListMarker, Span } from './layout.js';

/**
 * From lines in reading order to the document model: which lines belong to one
 * paragraph, which paragraphs are headings, which are items of a list.
 */

interface Paragraph {
  lines: Line[];
  spans: Span[];
  marker: ListMarker | null;
}

type Piece =
  | { kind: 'paragraph'; paragraph: Paragraph }
  | { kind: 'node'; node: PMNode };

const PX_PER_PT = 96 / 72;
const TWIPS_PER_PT = 20;
const roundHalf = (value: number): number => Math.round(value * 2) / 2;

/** The size most of the words in the document are set in. */
export function bodySizeOf(blocks: Block[]): number {
  const weight = new Map<number, number>();
  for (const block of blocks) {
    const spans =
      block.kind === 'line' ? block.line.spans : block.kind === 'table' ? block.rows.flat(2) : [];
    for (const span of spans) {
      const key = roundHalf(span.size);
      weight.set(key, (weight.get(key) ?? 0) + span.text.length);
    }
  }
  let best = 11;
  let most = -1;
  for (const [size, count] of weight) {
    if (count > most) {
      most = count;
      best = size;
    }
  }
  return best;
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u;

/**
 * Add the spans of the next line to a paragraph.
 *
 * A word broken across two lines with a hyphen is put back together, but only
 * when the second half starts in lower case: "well-" followed by "Known" or by
 * a digit is a real hyphen, and closing it up changed what the text said.
 */
function appendLine(target: Span[], next: Span[]): void {
  const last = target[target.length - 1];
  const first = next[0];
  if (!last || !first) {
    target.push(...next.map((span) => ({ ...span })));
    return;
  }
  const lead = first.text.charAt(0);
  const softHyphen = /\p{L}-$/u.test(last.text) && /^\p{Ll}/u.test(first.text);
  let joiner = ' ';
  if (softHyphen) {
    last.text = last.text.slice(0, -1);
    joiner = '';
  } else if (last.text.endsWith('-') || /\s$/u.test(last.text)) {
    joiner = '';
  } else if (CJK.test(last.text.slice(-1)) && CJK.test(lead)) {
    joiner = '';
  }
  last.text += joiner;
  for (const span of next) target.push({ ...span });
}

const isCentred = (line: Line): boolean => {
  const width = line.colRight - line.colLeft;
  const offset = Math.abs((line.x0 + line.x1) / 2 - (line.colLeft + line.colRight) / 2);
  return offset <= 1.5 + width * 0.01 && line.x0 - line.colLeft > line.size * 1.5;
};

const firstWordWidth = (line: Line): number => {
  const word = line.text.trimStart().split(/\s/u)[0] ?? '';
  // Spaces and narrow letters pull the average width of a character down, so a
  // word measured by the average comes out narrower than it is. Left as it
  // was, a wrapped line looked as though the next word would have fitted, and
  // paragraphs broke in two at random.
  return ((line.x1 - line.x0) * (word.length + 0.5) * 1.2) / Math.max(1, line.text.length);
};

/** Whether the next line's first word would have fitted on the end of this one. */
const endsShort = (line: Line, next: Line): boolean =>
  line.x1 + line.size * 0.25 + firstWordWidth(next) < line.colRight - 0.5;

const allBold = (spans: Span[]): boolean =>
  spans.length > 0 && spans.every((span) => span.bold || span.text.trim().length === 0);

/**
 * Whether `next` carries on the paragraph that currently ends with `line`.
 *
 * No single sign is reliable. Documents with space between paragraphs show it
 * in the line spacing; documents without show it as a first-line indent or as
 * a last line that stops short of the margin. All three are consulted.
 */
function continues(paragraph: Paragraph, next: Line, bodySize: number): boolean {
  const line = paragraph.lines[paragraph.lines.length - 1];
  if (!line || next.marker) return false;
  if (Math.abs(line.size - next.size) > 0.7) return false;
  const large = line.size >= bodySize * 1.15;

  if (line.stream !== next.stream) {
    // The end of a column or a page. The spacing says nothing here, so the
    // paragraph is rejoined only when the sentence visibly has not finished.
    if (large || paragraph.marker) return false;
    const lastSpan = line.spans[line.spans.length - 1];
    if (lastSpan?.bold !== next.spans[0]?.bold) return false;
    if (line.colRight - line.x1 > firstWordWidth(next) + line.size * 0.25 + 0.5) return false;
    if (next.x0 > next.colLeft + next.size * 0.75) return false;
    const finished = /[.!?:;]["'\u2019\u201d)\]]*$/u.test(line.text.trimEnd());
    return !finished || /^\p{Ll}/u.test(next.text);
  }

  const gap = next.y - line.y;
  if (gap <= 0) return false;
  if (large) {
    // A title that wraps: no short-line test, since a title's first line ends
    // wherever its words do. Three lines is the most a heading runs to.
    return gap <= line.size * 1.6 && paragraph.lines.length < 3 && allBold(line.spans) === allBold(next.spans);
  }
  const pitch = line.pitch > 0 ? line.pitch : line.size * 1.2;
  if (gap > pitch * 1.3 || gap > line.size * 2.2) return false;
  if (allBold(line.spans) !== allBold(next.spans) && endsShort(line, next)) return false;

  if (isCentred(line) && isCentred(next)) return true;
  if (endsShort(line, next)) return false;

  const first = paragraph.lines.length === 1;
  if (paragraph.marker) {
    // The second line of a list item hangs under its words, not its marker.
    return first
      ? next.x0 > line.x0 + 2 && Math.abs(next.x0 - paragraph.marker.textX) <= line.size * 1.5
      : Math.abs(next.x0 - line.x0) <= line.size * 0.5;
  }
  // After a first line anything goes: the second line sits to the left of it
  // under a first-line indent and to the right of it under a hanging one.
  if (first) return true;
  return Math.abs(next.x0 - line.x0) <= line.size * 0.5;
}

function marksFor(span: Span, bodySize: number): PMMark[] {
  const marks: PMMark[] = [];
  if (span.href && isSafeHref(span.href)) marks.push({ type: MARK.link, attrs: { href: span.href } });
  if (span.bold) marks.push({ type: MARK.bold });
  if (span.italic) marks.push({ type: MARK.italic });
  if (span.underline) marks.push({ type: MARK.underline });
  const style: Record<string, string> = {};
  if (Math.abs(span.size - bodySize) > 0.5) style['fontSize'] = `${roundHalf(span.size)}pt`;
  if (span.family) style['fontFamily'] = span.family;
  if (span.colour) style['color'] = span.colour;
  if (Object.keys(style).length > 0) marks.push({ type: MARK.textStyle, attrs: style });
  return marks;
}

// Control characters cannot be stored in the editor, and a PDF font without a
// proper character map produces them freely.
const storable = (text: string): string => {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    if (!control && code !== 0xfffe && code !== 0xffff) out += char;
  }
  return out;
};

function textNodes(spans: Span[], bodySize: number, skip = 0): PMNode[] {
  const nodes: PMNode[] = [];
  let toSkip = skip;
  let atStart = true;
  for (const span of spans) {
    let text = storable(span.text).replace(/\s+/gu, ' ');
    if (toSkip > 0) {
      const cut = Math.min(toSkip, text.length);
      text = text.slice(cut);
      toSkip -= cut;
    }
    if (atStart) text = text.trimStart();
    if (text.length === 0) continue;
    atStart = false;
    const marks = marksFor(span, bodySize);
    const previous = nodes[nodes.length - 1];
    if (previous && JSON.stringify(previous.marks ?? []) === JSON.stringify(marks)) {
      previous.text = (previous.text ?? '') + text;
    } else {
      nodes.push({ type: NODE.text, text, ...(marks.length > 0 ? { marks } : {}) });
    }
  }
  const last = nodes[nodes.length - 1];
  if (last?.text !== undefined) {
    last.text = last.text.trimEnd();
    if (last.text.length === 0) nodes.pop();
  }
  return nodes;
}

function alignmentOf(lines: Line[]): 'center' | 'right' | 'justify' | null {
  const first = lines[0];
  if (!first) return null;
  if (lines.every(isCentred)) return 'center';
  const width = first.colRight - first.colLeft;
  if (
    width > 0 &&
    lines.every((line) => line.colRight - line.x1 <= 1.5 && line.x0 - line.colLeft > line.size * 1.5) &&
    (lines.length > 1 || first.x0 - first.colLeft > width * 0.3)
  ) {
    return 'right';
  }
  const full = lines.slice(0, -1);
  if (full.length >= 2 && full.every((line) => line.colRight - line.x1 <= 1)) return 'justify';
  return null;
}

function blockAttrs(paragraph: Paragraph): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  const align = alignmentOf(paragraph.lines);
  if (align) attrs['textAlign'] = align;
  if (!align || align === 'justify') {
    const hanging = paragraph.lines.slice(1);
    const first = paragraph.lines[0];
    // One line alone cannot tell a first-line indent from an indented block,
    // so only an indent too deep to be a first-line indent is believed.
    const indent =
      hanging.length > 0
        ? Math.min(...hanging.map((line) => line.x0 - line.colLeft))
        : first && first.x0 - first.colLeft > first.size * 3
          ? first.x0 - first.colLeft
          : 0;
    if (first && indent > first.size * 0.75) attrs['indentLeft'] = Math.round(indent * TWIPS_PER_PT);
  }
  return attrs;
}

const MAX_HEADING_CHARS = 200;
const MAX_BOLD_HEADING_CHARS = 80;

/**
 * Turn the blocks of the whole document into nodes.
 */
export function assemble(blocks: Block[], bodySize: number): PMNode[] {
  // Pass one: lines into paragraphs. Anything that is not a line ends the
  // paragraph before it.
  const pieces: Piece[] = [];
  let open: Paragraph | null = null;
  for (const block of blocks) {
    if (block.kind === 'line') {
      if (open && continues(open, block.line, bodySize)) {
        open.lines.push(block.line);
        appendLine(open.spans, block.line.spans);
      } else {
        open = {
          lines: [block.line],
          spans: block.line.spans.map((span) => ({ ...span })),
          marker: block.line.marker,
        };
        pieces.push({ kind: 'paragraph', paragraph: open });
      }
      continue;
    }
    open = null;
    if (block.kind === 'rule') {
      pieces.push({ kind: 'node', node: { type: NODE.horizontalRule } });
    } else if (block.kind === 'picture') {
      const { picture } = block;
      if (!isEmbeddedImageSrc(picture.src)) continue;
      pieces.push({
        kind: 'node',
        node: {
          type: NODE.paragraph,
          content: [
            {
              type: NODE.image,
              attrs: {
                src: picture.src,
                alt: null,
                title: null,
                width: Math.min(20000, Math.max(1, Math.round(picture.width * PX_PER_PT))),
                height: Math.min(20000, Math.max(1, Math.round(picture.height * PX_PER_PT))),
              },
            },
          ],
        },
      });
    } else {
      const rows: PMNode[] = block.rows.map((cells, rowIndex) => ({
        type: NODE.tableRow,
        content: cells.map((cell) => {
          const content = textNodes(cell, bodySize);
          return {
            type: block.header && rowIndex === 0 ? NODE.tableHeader : NODE.tableCell,
            attrs: { colspan: 1, rowspan: 1 },
            content: [{ type: NODE.paragraph, ...(content.length > 0 ? { content } : {}) }],
          };
        }),
      }));
      if (rows.length > 0) pieces.push({ kind: 'node', node: { type: NODE.table, content: rows } });
    }
  }

  // The larger sizes in use, biggest first, decide the heading levels.
  const isLarge = (p: Paragraph): boolean => {
    const size = p.lines[0]?.size ?? 0;
    const length = p.spans.reduce((sum, span) => sum + span.text.length, 0);
    return size >= bodySize * 1.15 && p.lines.length <= 3 && length <= MAX_HEADING_CHARS && /\p{L}/u.test(p.lines[0]?.text ?? '');
  };
  const sizes = [
    ...new Set(
      pieces.flatMap((piece) =>
        piece.kind === 'paragraph' && isLarge(piece.paragraph) ? [roundHalf(piece.paragraph.lines[0]?.size ?? 0)] : [],
      ),
    ),
  ].sort((a, b) => b - a);

  const headingLevel = (p: Paragraph, following: Piece | undefined): number | null => {
    if (isLarge(p)) return Math.min(4, sizes.indexOf(roundHalf(p.lines[0]?.size ?? 0)) + 1) || 1;
    const text = p.spans.map((span) => span.text).join('').trim();
    // Bold at the size of the body is a heading only when it stands alone over
    // ordinary text. A bold sentence, or a run of bold lines, is emphasis.
    const standsOver =
      following?.kind === 'paragraph' && !allBold(following.paragraph.spans);
    if (
      p.lines.length === 1 &&
      !p.marker &&
      allBold(p.spans) &&
      text.length <= MAX_BOLD_HEADING_CHARS &&
      /\p{L}/u.test(text) &&
      !/[.,;]$/u.test(text) &&
      (p.lines[0]?.size ?? 0) >= bodySize - 0.5 &&
      standsOver
    ) {
      return Math.min(4, sizes.length + 1);
    }
    return null;
  };

  // Pass two: headings, paragraphs and the runs of list items.
  const nodes: PMNode[] = [];
  let index = 0;
  while (index < pieces.length) {
    const piece = pieces[index];
    if (!piece) break;
    if (piece.kind === 'node') {
      nodes.push(piece.node);
      index += 1;
      continue;
    }
    const p = piece.paragraph;
    const level = p.marker && !isLarge(p) ? null : headingLevel(p, pieces[index + 1]);
    if (level !== null) {
      const content = textNodes(p.spans, bodySize);
      const align = alignmentOf(p.lines);
      if (content.length > 0) {
        nodes.push({
          type: NODE.heading,
          attrs: { level, ...(align === 'center' || align === 'right' ? { textAlign: align } : {}) },
          content,
        });
      }
      index += 1;
      continue;
    }
    if (p.marker) {
      const run: Paragraph[] = [];
      let cursor = index;
      while (cursor < pieces.length) {
        const candidate = pieces[cursor];
        if (candidate?.kind !== 'paragraph' || !candidate.paragraph.marker) break;
        if (isLarge(candidate.paragraph)) break;
        run.push(candidate.paragraph);
        cursor += 1;
      }
      // One numbered line by itself is far more often "1. Purpose" than a list
      // of one, and as a list it would lose its number. Bullets carry no such
      // information, so a single bullet is still a list.
      if (run.length >= 2 || !p.marker.ordered) {
        nodes.push(...listNodes(run, bodySize));
        index = cursor;
        continue;
      }
    }
    const content = textNodes(p.spans, bodySize);
    if (content.length > 0) {
      const attrs = p.marker ? {} : blockAttrs(p);
      nodes.push({
        type: NODE.paragraph,
        ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
        content,
      });
    }
    index += 1;
  }
  return nodes;
}

const MAX_LIST_DEPTH = 5;

/** Build nested lists from a run of marked paragraphs, nesting by indent. */
function listNodes(run: Paragraph[], bodySize: number): PMNode[] {
  const offsets = run.map((p) => (p.lines[0]?.x0 ?? 0) - (p.lines[0]?.colLeft ?? 0));
  const steps: number[] = [];
  for (const offset of [...offsets].sort((a, b) => a - b)) {
    if (steps.length === 0 || offset - (steps[steps.length - 1] ?? 0) > 6) steps.push(offset);
  }
  const levelOf = (offset: number): number => {
    let level = 0;
    steps.forEach((step, at) => {
      if (offset >= step - 0.01) level = at;
    });
    return Math.min(level, MAX_LIST_DEPTH);
  };
  const items = run.map((p, at) => ({ p, level: levelOf(offsets[at] ?? 0) }));

  let cursor = 0;
  const build = (level: number): PMNode | null => {
    const first = items[cursor];
    if (!first?.p.marker) return null;
    const { marker } = first.p;
    const content: PMNode[] = [];
    while (cursor < items.length) {
      const item = items[cursor];
      if (!item?.p.marker || item.level < level) break;
      if (item.level > level && content.length > 0) {
        const nested = build(item.level);
        if (nested) content[content.length - 1]?.content?.push(nested);
        continue;
      }
      if (item.level === level && item.p.marker.ordered !== marker.ordered) break;
      const text = textNodes(item.p.spans, bodySize, item.p.marker.length);
      content.push({
        type: NODE.listItem,
        content: [{ type: NODE.paragraph, ...(text.length > 0 ? { content: text } : {}) }],
      });
      cursor += 1;
    }
    if (content.length === 0) return null;
    const attrs: Record<string, unknown> = {};
    if (marker.ordered) {
      if (marker.value !== null && marker.value > 1) attrs['start'] = marker.value;
      if (marker.format !== 'decimal') attrs['listFormat'] = marker.format;
    }
    return {
      type: marker.ordered ? NODE.orderedList : NODE.bulletList,
      ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
      content,
    };
  };

  const lists: PMNode[] = [];
  // Every turn either consumes an item or stops, so this cannot run away.
  while (cursor < items.length) {
    const before = cursor;
    const list = build(items[cursor]?.level ?? 0);
    if (list) lists.push(list);
    if (cursor === before) cursor += 1;
  }
  return lists;
}
