/**
 * A document's own styles, resolved into what each one looks like.
 *
 * Almost nothing in a real Word document is formatted directly. A heading is
 * blue, large and bold because its style says so; the body is 11 point Calibri
 * because the document defaults say so. Reading only the formatting written on
 * a run showed every such document in the editor's default font with plain
 * black headings, and "my formatting changed" was the first thing anybody said.
 *
 * The styles are not flattened into the text. The paragraph keeps the name of
 * its style, the file keeps `styles.xml`, and this table only tells the editor
 * how to draw them, so what goes back to Word is the style and not an imitation
 * of it.
 */
import type { StyleProps, StyleTable } from '@docforge/model';
import { attrOf, child, childrenNamed, type XmlElement } from './xml.js';

export type { StyleProps, StyleTable };

const ALIGNMENTS: Record<string, StyleProps['textAlign']> = {
  left: 'left',
  start: 'left',
  center: 'center',
  right: 'right',
  end: 'right',
  both: 'justify',
  distribute: 'justify',
};

export interface ThemeFonts {
  major?: string;
  minor?: string;
}

/** The two fonts a theme names, which most documents use without saying which. */
export function readThemeFonts(theme: XmlElement | undefined): ThemeFonts {
  const scheme = child(theme, 'a:themeElements', 'a:fontScheme');
  return {
    major: attrOf(scheme, ['a:majorFont', 'a:latin'], 'typeface') || undefined,
    minor: attrOf(scheme, ['a:minorFont', 'a:latin'], 'typeface') || undefined,
  };
}

const onOff = (properties: XmlElement | undefined, name: string): boolean | undefined => {
  const element = child(properties, name);
  if (!element) return undefined;
  const value = element.attrs['w:val'];
  return value !== '0' && value !== 'false' && value !== 'off';
};

const number = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** What a `w:rPr` says, in the editor's terms. Absent means "not stated". */
export function runProps(properties: XmlElement | undefined, theme: ThemeFonts): StyleProps {
  if (!properties) return {};
  const props: StyleProps = {};

  const fonts = child(properties, 'w:rFonts');
  if (fonts) {
    const named = fonts.attrs['w:ascii'] ?? fonts.attrs['w:hAnsi'];
    const themed = fonts.attrs['w:asciiTheme'] ?? fonts.attrs['w:hAnsiTheme'];
    if (named) props.fontFamily = named;
    else if (themed) props.fontFamily = themed.startsWith('major') ? theme.major : theme.minor;
  }
  const halfPoints = number(attrOf(properties, ['w:sz'], 'w:val'));
  if (halfPoints && halfPoints > 0) props.fontSize = halfPoints / 2;

  const colour = attrOf(properties, ['w:color'], 'w:val');
  if (colour && /^[0-9a-f]{6}$/iu.test(colour)) props.color = `#${colour.toLowerCase()}`;
  else if (colour === 'auto') props.color = 'auto';

  const bold = onOff(properties, 'w:b');
  if (bold !== undefined) props.bold = bold;
  const italic = onOff(properties, 'w:i');
  if (italic !== undefined) props.italic = italic;
  const strike = onOff(properties, 'w:strike');
  if (strike !== undefined) props.strike = strike;
  const caps = onOff(properties, 'w:caps');
  if (caps !== undefined) props.caps = caps;
  const smallCaps = onOff(properties, 'w:smallCaps');
  if (smallCaps !== undefined) props.smallCaps = smallCaps;

  const underline = child(properties, 'w:u');
  if (underline) props.underline = (underline.attrs['w:val'] ?? 'single') !== 'none';

  return props;
}

/** What a `w:pPr` says, in the editor's terms. Measurements stay in twips. */
export function paragraphProps(properties: XmlElement | undefined): StyleProps {
  if (!properties) return {};
  const props: StyleProps = {};

  const alignment = attrOf(properties, ['w:jc'], 'w:val');
  if (alignment && ALIGNMENTS[alignment]) props.textAlign = ALIGNMENTS[alignment];

  const indent = child(properties, 'w:ind');
  if (indent) {
    const left = number(indent.attrs['w:left'] ?? indent.attrs['w:start']);
    const right = number(indent.attrs['w:right'] ?? indent.attrs['w:end']);
    const firstLine = number(indent.attrs['w:firstLine']);
    const hanging = number(indent.attrs['w:hanging']);
    if (left !== undefined) props.indentLeft = left;
    if (right !== undefined) props.indentRight = right;
    // One signed number: a hanging indent is a negative first line.
    if (hanging !== undefined && hanging !== 0) props.indentFirstLine = -hanging;
    else if (firstLine !== undefined) props.indentFirstLine = firstLine;
  }

  const spacing = child(properties, 'w:spacing');
  if (spacing) {
    const before = number(spacing.attrs['w:before']);
    const after = number(spacing.attrs['w:after']);
    const line = number(spacing.attrs['w:line']);
    if (before !== undefined) props.spacingBefore = before;
    if (after !== undefined) props.spacingAfter = after;
    if (line !== undefined && line > 0) {
      const rule = spacing.attrs['w:lineRule'] ?? 'auto';
      // "auto" counts in 240ths of a line; the other rules count in twips.
      if (rule === 'auto') props.lineHeight = Math.round((line / 240) * 100) / 100;
      else props.lineExact = line;
    }
  }

  const fill = attrOf(properties, ['w:shd'], 'w:fill');
  if (fill && /^[0-9a-f]{6}$/iu.test(fill)) props.background = `#${fill.toLowerCase()}`;

  const outline = number(attrOf(properties, ['w:outlineLvl'], 'w:val'));
  if (outline !== undefined && outline >= 0 && outline <= 8) props.outlineLevel = outline;

  return props;
}

const merge = (base: StyleProps, over: StyleProps): StyleProps => ({ ...base, ...over });

/**
 * Resolve every style: defaults, then its ancestors oldest first, then itself.
 * A chain longer than Word allows, or one that loops, stops rather than hangs.
 */
export function readStyleTable(styles: XmlElement | undefined, themeXml: XmlElement | undefined): StyleTable {
  const theme = readThemeFonts(themeXml);
  const table: StyleTable = { defaults: {}, paragraph: {}, character: {} };
  if (!styles) return table;

  const defaults = child(styles, 'w:docDefaults');
  table.defaults = merge(
    runProps(child(defaults, 'w:rPrDefault', 'w:rPr'), theme),
    paragraphProps(child(defaults, 'w:pPrDefault', 'w:pPr')),
  );

  interface Raw {
    id: string;
    type: string;
    name: string;
    basedOn?: string;
    own: StyleProps;
    isDefault: boolean;
  }
  const raw = new Map<string, Raw>();
  for (const style of childrenNamed(styles, 'w:style')) {
    const id = style.attrs['w:styleId'];
    const type = style.attrs['w:type'] ?? 'paragraph';
    if (!id || (type !== 'paragraph' && type !== 'character')) continue;
    raw.set(id, {
      id,
      type,
      name: attrOf(style, ['w:name'], 'w:val') ?? id,
      basedOn: attrOf(style, ['w:basedOn'], 'w:val'),
      own: merge(paragraphProps(child(style, 'w:pPr')), runProps(child(style, 'w:rPr'), theme)),
      isDefault: style.attrs['w:default'] === '1' || style.attrs['w:default'] === 'true',
    });
  }

  const resolve = (id: string): StyleProps => {
    const chain: Raw[] = [];
    const seen = new Set<string>();
    let current = raw.get(id);
    while (current && !seen.has(current.id) && chain.length < 20) {
      seen.add(current.id);
      chain.unshift(current);
      current = current.basedOn ? raw.get(current.basedOn) : undefined;
    }
    return chain.reduce((props, style) => merge(props, style.own), {} as StyleProps);
  };

  for (const style of raw.values()) {
    const props = resolve(style.id);
    const entry = { name: style.name, props };
    if (style.type === 'paragraph') {
      table.paragraph[style.id] = entry;
      if (style.isDefault) table.defaultParagraph = style.id;
    } else {
      table.character[style.id] = entry;
    }
  }
  return table;
}
