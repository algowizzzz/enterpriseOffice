/**
 * What a paragraph and a run of text look like, worked out the way Word does:
 * the document's defaults, then its default paragraph style, then the style the
 * paragraph names, then the paragraph's own formatting, then the marks on the
 * run. Everything leaves here in points, so the layout never sees a twip.
 */
import { MARK, NODE, isSafeHref } from '@docforge/model';
import type { Alignment, PMMark, PMNode, StyleEntry, StyleProps, StyleTable } from '@docforge/model';
import { builtinFamily } from './fonts.js';
import type { BuiltinFamily } from './fonts.js';

export interface RunStyle {
  family: BuiltinFamily;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** Points, before any reduction for superscript or subscript. */
  size: number;
  colour: string;
  highlight: string | null;
  shift: 'super' | 'sub' | null;
  link: string | null;
  caps: boolean;
}

export interface ParagraphStyle {
  align: Alignment;
  left: number;
  right: number;
  /** Added to `left` for the first line only. Negative for a hanging indent. */
  first: number;
  before: number;
  after: number;
  multiple: number;
  exact: number | null;
  background: string | null;
  run: RunStyle;
}

const TWIPS = 20;
const INK = '#000000';
export const LINK_BLUE = '#0563c1';
export const CHANGE_RED = '#c00000';

/** Used when the document did not come from Word and so has no styles of its own. */
const PLAIN_DEFAULTS: StyleProps = { fontSize: 11, spacingAfter: 160, lineHeight: 1.15 };

/**
 * With a Word file's styles present, whatever they leave unsaid means what Word
 * takes it to mean: no space after, single line spacing. Falling back to the
 * plain defaults instead would add 8pt under every paragraph of a document that
 * was written without any.
 */
const WORD_DEFAULTS: StyleProps = { fontSize: 11, spacingAfter: 0, lineHeight: 1 };

const HEADING_SIZES = [20, 16, 14, 12, 11, 11];

function headingDefaults(level: number): StyleProps {
  return {
    fontSize: HEADING_SIZES[level - 1] ?? 11,
    bold: true,
    spacingBefore: level === 1 ? 240 : 160,
    spacingAfter: 80,
  };
}

const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  orange: '#ffa500',
  purple: '#800080',
};

/** A colour as `#rrggbb`, or null for anything pdfkit might choke on. */
export function colourFrom(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(text);
  if (rgb) {
    const hex = [rgb[1], rgb[2], rgb[3]].map((part) =>
      Math.min(255, Number(part)).toString(16).padStart(2, '0'),
    );
    return `#${hex.join('')}`;
  }
  return NAMED[text] ?? null;
}

function finite(value: unknown, low: number, high: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(high, Math.max(low, value));
}

/** A font size as the editor writes it (`12pt`, `16px`, a bare number), in points. */
function sizeFrom(value: unknown): number | null {
  if (typeof value === 'number') return finite(value, 1, 400);
  if (typeof value !== 'string') return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(pt|px|em|rem)?\s*$/i.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'pt').toLowerCase();
  if (unit === 'px') return finite(amount * 0.75, 1, 400);
  if (unit === 'em' || unit === 'rem') return finite(amount * 11, 1, 400);
  return finite(amount, 1, 400);
}

/**
 * Lay one set of properties over another. The two ways of stating a line
 * height exclude each other, so whichever layer speaks last silences the other
 * form from the layers beneath it.
 */
function over(base: StyleProps, top: StyleProps | undefined): StyleProps {
  if (!top) return base;
  const merged: StyleProps = { ...base };
  for (const [key, value] of Object.entries(top)) {
    if (value !== undefined && value !== null) (merged as Record<string, unknown>)[key] = value;
  }
  if (top.lineHeight !== undefined && top.lineExact === undefined) delete merged.lineExact;
  if (top.lineExact !== undefined && top.lineHeight === undefined) delete merged.lineHeight;
  return merged;
}

/**
 * A style id comes from the file, and `constructor` is a legal one. Looking it
 * up as a plain property would find Object's, not a style.
 */
function propsOf(record: Record<string, StyleEntry>, id: string | null | undefined): StyleProps | undefined {
  if (!id || !Object.hasOwn(record, id)) return undefined;
  const props = record[id]?.props;
  return props && typeof props === 'object' ? props : undefined;
}

function headingStyle(table: StyleTable, level: number): StyleProps | undefined {
  const wanted = `heading${level}`;
  for (const [id, entry] of Object.entries(table.paragraph)) {
    if (id.toLowerCase() === wanted) return entry.props;
  }
  return undefined;
}

function ownProps(attrs: Record<string, unknown>): StyleProps {
  const own: StyleProps = {};
  const align = attrs['textAlign'];
  if (align === 'left' || align === 'center' || align === 'right' || align === 'justify') own.textAlign = align;
  for (const key of ['indentLeft', 'indentRight', 'indentFirstLine', 'spacingBefore', 'spacingAfter'] as const) {
    const value = finite(attrs[key], -31680, 31680);
    if (value !== null) own[key] = value;
  }
  const multiple = finite(attrs['lineHeight'], 0.5, 10);
  const exact = finite(attrs['lineExact'], 20, 31680);
  if (multiple !== null) own.lineHeight = multiple;
  else if (exact !== null) own.lineExact = exact;
  return own;
}

export function paragraphStyle(node: PMNode, table: StyleTable | null, forceBold: boolean): ParagraphStyle {
  const attrs = node.attrs ?? {};
  let props: StyleProps;
  if (table) {
    props = over(WORD_DEFAULTS, table.defaults);
    props = over(props, propsOf(table.paragraph, table.defaultParagraph));
  } else {
    props = { ...PLAIN_DEFAULTS };
  }

  const styleId = typeof attrs['styleId'] === 'string' ? attrs['styleId'] : null;
  const named = table ? propsOf(table.paragraph, styleId) : undefined;
  if (node.type === NODE.heading) {
    const level = finite(attrs['level'], 1, 6) ?? 1;
    // A heading typed in the editor names no style. It still has to look like a
    // heading, from the document's own Heading style if it has one.
    props = over(props, named ?? (table ? headingStyle(table, level) : undefined) ?? headingDefaults(level));
  } else {
    props = over(props, named);
  }
  props = over(props, ownProps(attrs));

  const left = Math.max(0, (finite(props.indentLeft, -31680, 31680) ?? 0) / TWIPS);
  return {
    align: props.textAlign ?? 'left',
    left,
    right: Math.max(0, (finite(props.indentRight, -31680, 31680) ?? 0) / TWIPS),
    // A hanging indent cannot hang further out than the paragraph is in.
    first: Math.max(-left, (finite(props.indentFirstLine, -31680, 31680) ?? 0) / TWIPS),
    before: (finite(props.spacingBefore, 0, 31680) ?? 0) / TWIPS,
    after: (finite(props.spacingAfter, 0, 31680) ?? 0) / TWIPS,
    multiple: finite(props.lineHeight, 0.5, 10) ?? 1,
    exact: props.lineHeight === undefined ? (finite(props.lineExact, 20, 31680) ?? 0) / TWIPS || null : null,
    background: colourFrom(props.background),
    run: {
      family: builtinFamily(props.fontFamily),
      bold: props.bold === true || forceBold,
      italic: props.italic === true,
      underline: props.underline === true,
      strike: props.strike === true,
      size: finite(props.fontSize, 1, 400) ?? 11,
      colour: colourFrom(props.color) ?? INK,
      highlight: null,
      shift: null,
      link: null,
      caps: props.caps === true,
    },
  };
}

function applyProps(style: RunStyle, props: StyleProps): void {
  if (props.fontFamily) style.family = builtinFamily(props.fontFamily);
  const size = finite(props.fontSize, 1, 400);
  if (size !== null) style.size = size;
  const colour = colourFrom(props.color);
  if (colour) style.colour = colour;
  if (props.bold !== undefined) style.bold = props.bold;
  if (props.italic !== undefined) style.italic = props.italic;
  if (props.underline !== undefined) style.underline = props.underline;
  if (props.strike !== undefined) style.strike = props.strike;
  if (props.caps !== undefined) style.caps = props.caps;
}

/** Marks that set a colour of their own accord, which direct formatting may then overrule. */
const FIRST = new Set<string>([MARK.link, MARK.wordRun]);

export function runStyle(base: RunStyle, marks: readonly PMMark[] | undefined, table: StyleTable | null): RunStyle {
  const style: RunStyle = { ...base };
  if (!marks || marks.length === 0) return style;
  // A link is blue unless somebody coloured it, so the link has to be applied
  // before the colour whatever order the marks arrive in.
  const ordered = [...marks].sort((a, b) => Number(FIRST.has(b.type)) - Number(FIRST.has(a.type)));
  let tracked = false;
  for (const mark of ordered) {
    const attrs = mark.attrs ?? {};
    switch (mark.type) {
      case MARK.bold:
        style.bold = true;
        break;
      case MARK.italic:
        style.italic = true;
        break;
      case MARK.underline:
        style.underline = true;
        break;
      case MARK.strike:
        style.strike = true;
        break;
      case MARK.superscript:
        style.shift = 'super';
        break;
      case MARK.subscript:
        style.shift = 'sub';
        break;
      case MARK.highlight:
        style.highlight = colourFrom(attrs['color']) ?? '#ffff00';
        break;
      case MARK.link: {
        const href = attrs['href'];
        // The same rule the editor applies: a javascript: address must not
        // become something a reader can click.
        if (typeof href === 'string' && isSafeHref(href)) style.link = href;
        style.colour = LINK_BLUE;
        style.underline = true;
        break;
      }
      case MARK.textStyle: {
        const colour = colourFrom(attrs['color']);
        if (colour) style.colour = colour;
        if (typeof attrs['fontFamily'] === 'string' && attrs['fontFamily']) {
          style.family = builtinFamily(attrs['fontFamily']);
        }
        const size = sizeFrom(attrs['fontSize']);
        if (size !== null) style.size = size;
        break;
      }
      case MARK.wordRun: {
        const id = attrs['styleId'];
        const props = typeof id === 'string' && table ? propsOf(table.character, id) : undefined;
        if (props) applyProps(style, props);
        break;
      }
      case MARK.insertion:
        style.underline = true;
        tracked = true;
        break;
      case MARK.deletion:
        style.strike = true;
        tracked = true;
        break;
      default:
        break;
    }
  }
  // Last, so that a tracked change is recognisable whatever else the run wears.
  if (tracked) style.colour = CHANGE_RED;
  return style;
}
