/**
 * Which font draws which character.
 *
 * A PDF reader is guaranteed fourteen fonts, and they need no file: that is
 * what lets an air-gapped server with nothing installed still produce a PDF.
 * The price is their character set, which is Windows-1252 and nothing else. So
 * every character is sorted here into one of three kinds: one a built-in font
 * can draw, one that needs a real font file found on the machine, and one that
 * nothing available can draw, which becomes a question mark rather than the
 * wrong glyph or an exception.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type BuiltinFamily = 'Helvetica' | 'Times' | 'Courier';

const SERIF = /times|georgia|cambria|caladea|garamond|palatino|book antiqua|bookman|century|constantia|baskerville|didot|minion|tinos|serif/;
const MONO = /courier|consolas|mono|menlo|monaco|cousine|lucida console|typewriter|fixed/;

/** The built-in family nearest to a font the document names. */
export function builtinFamily(name: string | null | undefined): BuiltinFamily {
  if (!name) return 'Helvetica';
  const lower = name.toLowerCase();
  // "sans-serif" and "Liberation Sans" both contain a serif pattern's letters,
  // so the sans test has to come first or every sans font turns into Times.
  if (/sans/.test(lower)) return MONO.test(lower) ? 'Courier' : 'Helvetica';
  if (MONO.test(lower)) return 'Courier';
  if (SERIF.test(lower)) return 'Times';
  return 'Helvetica';
}

/** The PostScript name pdfkit knows a built-in face by. */
export function builtinFace(family: BuiltinFamily, bold: boolean, italic: boolean): string {
  if (family === 'Times') {
    if (bold && italic) return 'Times-BoldItalic';
    if (bold) return 'Times-Bold';
    return italic ? 'Times-Italic' : 'Times-Roman';
  }
  const slant = italic ? 'Oblique' : '';
  if (bold) return `${family}-Bold${slant}`;
  return italic ? `${family}-Oblique` : family;
}

/**
 * The part of Windows-1252 that lies outside Latin-1: the curly quotes, the
 * dashes, the ellipsis, the bullet, the euro. These are exactly the characters
 * a word processor inserts by itself, so getting them wrong would spoil nearly
 * every document.
 */
const WIN_ANSI_EXTRA = new Set([
  0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017d, 0x017e, 0x0192, 0x02c6, 0x02dc, 0x2013, 0x2014, 0x2018, 0x2019,
  0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x20ac, 0x2122,
]);

export function builtinCanDraw(codePoint: number): boolean {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return true;
  if (codePoint >= 0xa1 && codePoint <= 0xff) return codePoint !== 0xad;
  return WIN_ANSI_EXTRA.has(codePoint);
}

/**
 * Characters with a near-identical twin inside Windows-1252. A non-breaking
 * hyphen drawn as a hyphen is right; drawn as "?" it is a defect.
 */
const TWINS = new Map<number, string>([
  [0x00a0, ' '],
  [0x2000, ' '],
  [0x2001, ' '],
  [0x2002, ' '],
  [0x2003, ' '],
  [0x2004, ' '],
  [0x2005, ' '],
  [0x2006, ' '],
  [0x2007, ' '],
  [0x2008, ' '],
  [0x2009, ' '],
  [0x200a, ' '],
  [0x202f, ' '],
  [0x205f, ' '],
  [0x3000, ' '],
  [0x2010, '-'],
  [0x2011, '-'],
  [0x2012, '-'],
  [0x2015, '\u2014'],
  [0x2212, '-'],
  [0x2032, "'"],
  [0x2033, '"'],
  [0x2043, '-'],
  [0x25cf, '\u2022'],
  [0x2219, '\u00b7'],
  [0x22c5, '\u00b7'],
]);

export function builtinTwin(codePoint: number): string | null {
  return TWINS.get(codePoint) ?? null;
}

/** Characters that take up no room and that a built-in font has no glyph for. */
export function isInvisible(codePoint: number): boolean {
  return (
    codePoint === 0x00ad ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2064) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  );
}

/** Marks that belong to the character before them and must stay in its font. */
export function isJoining(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  );
}

export function isRightToLeft(codePoint: number): boolean {
  return (
    (codePoint >= 0x0590 && codePoint <= 0x08ff) ||
    (codePoint >= 0xfb1d && codePoint <= 0xfdff) ||
    (codePoint >= 0xfe70 && codePoint <= 0xfeff)
  );
}

/** Scripts written without spaces, where a line may break between any two characters. */
export function breaksAnywhere(codePoint: number): boolean {
  return (
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x20000 && codePoint <= 0x3ffff)
  );
}

const SYSTEM_FONT_DIRS = [
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  '/Library/Fonts',
  '/System/Library/Fonts/Supplemental',
  'C:\\Windows\\Fonts',
];

/** Best first. A broad, plain sans is wanted: it stands in for any script. */
const PREFERRED = ['dejavusans', 'notosans', 'liberationsans', 'arialunicode', 'arial'];

// A font tree can be enormous (a TeX installation, a designer's collection),
// and this runs inside a request. The scan is bounded so that the worst case
// is a fallback font not being found, never an export that hangs.
const MAX_DEPTH = 4;
const MAX_ENTRIES = 4000;
const MAX_FONT_BYTES = 40 * 1024 * 1024;

interface Candidate {
  path: string;
  rank: number;
}

function scan(dir: string, depth: number, budget: { left: number }, found: Candidate[]): void {
  if (depth > MAX_DEPTH || budget.left <= 0) return;
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (budget.left-- <= 0) return;
    const path = join(dir, name);
    const lower = name.toLowerCase();
    // Collections (.ttc) are left out: opening one needs the name of a face
    // inside it, and guessing wrong yields an object pdfkit cannot draw with.
    if (lower.endsWith('.ttf') || lower.endsWith('.otf')) {
      const key = lower.replace(/[\s_-]/g, '');
      // A bold or italic cut found first would draw every fallback run bold.
      const styled = /bold|italic|oblique|light|thin|black|condensed|narrow|medium|semi/.test(key);
      const preferred = PREFERRED.findIndex((wanted) => key.includes(wanted));
      const family = key.replace(/\.(ttf|otf)$/, '').replace(/regular$/, '');
      // "NotoSans-Regular" is the broad font that was asked for. "NotoSansAdlam"
      // merely contains its name and covers one script, so it must not come
      // ahead of a real match further down the list, such as Arial Unicode.
      // Any font is better than none, but one nobody chose goes to the back.
      const tier = preferred < 0 ? 20 : PREFERRED.includes(family) ? 0 : 10;
      const rank = tier + Math.max(0, preferred) + (styled ? 0.5 : 0);
      found.push({ path, rank });
      continue;
    }
    if (lower.includes('.')) continue;
    try {
      if (statSync(path).isDirectory()) scan(path, depth + 1, budget, found);
    } catch {
      // Unreadable entry: somebody else's permissions are not this export's problem.
    }
  }
}

function candidatesIn(dirs: readonly string[]): string[] {
  const found: Candidate[] = [];
  for (const dir of dirs) {
    try {
      scan(dir, 0, { left: MAX_ENTRIES }, found);
    } catch {
      // Carry on with the next directory.
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map((candidate) => candidate.path);
}

let systemCandidates: string[] | null = null;
const fontBytes = new Map<string, Buffer | null>();

function load(path: string): Buffer | null {
  const cached = fontBytes.get(path);
  if (cached !== undefined) return cached;
  let data: Buffer | null = null;
  try {
    if (statSync(path).size <= MAX_FONT_BYTES) data = readFileSync(path);
  } catch {
    data = null;
  }
  fontBytes.set(path, data);
  return data;
}

/**
 * Font files worth trying for text the built-in fonts cannot draw, best first.
 *
 * The system directories are walked once per process: fonts do not appear while
 * a server runs, and the walk is the expensive part. Directories named by the
 * caller are walked each time, because they are configuration and may differ.
 */
export function fallbackFontFiles(fontDirs: readonly string[], useSystem: boolean): string[] {
  const paths = candidatesIn(fontDirs);
  if (useSystem) {
    systemCandidates ??= candidatesIn(SYSTEM_FONT_DIRS);
    paths.push(...systemCandidates);
  }
  return paths;
}

export function readFontFile(path: string): Buffer | null {
  return load(path);
}

const SCRIPTS: Array<[number, number, string]> = [
  [0x0530, 0x058f, 'armenian'],
  [0x0590, 0x05ff, 'hebrew'],
  [0x0600, 0x077f, 'arabic'],
  [0x08a0, 0x08ff, 'arabic'],
  [0x0900, 0x097f, 'devanagari'],
  [0x0980, 0x09ff, 'bengali'],
  [0x0a00, 0x0a7f, 'gurmukhi'],
  [0x0a80, 0x0aff, 'gujarati'],
  [0x0b80, 0x0bff, 'tamil'],
  [0x0c00, 0x0c7f, 'telugu'],
  [0x0c80, 0x0cff, 'kannada'],
  [0x0d00, 0x0d7f, 'malayalam'],
  [0x0d80, 0x0dff, 'sinhala'],
  [0x0e00, 0x0e7f, 'thai'],
  [0x0e80, 0x0eff, 'lao'],
  [0x1000, 0x109f, 'myanmar'],
  [0x10a0, 0x10ff, 'georgian'],
  [0x1200, 0x139f, 'ethiopic'],
  [0x1780, 0x17ff, 'khmer'],
  [0x2e80, 0x9fff, 'cjk'],
  [0xac00, 0xd7af, 'kr'],
  [0xfb1d, 0xfb4f, 'hebrew'],
  [0xfb50, 0xfeff, 'arabic'],
];

/**
 * A word to look for in a font's file name. Noto, the family most servers
 * carry, is one file per script: on such a machine the first five "NotoSans"
 * files are five scripts nobody asked for, and the Arabic one is never reached
 * unless it is looked for by name.
 */
export function scriptKeyword(codePoint: number): string | null {
  for (const [low, high, word] of SCRIPTS) {
    if (codePoint >= low && codePoint <= high) return word;
  }
  return null;
}
