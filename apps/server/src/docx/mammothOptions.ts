/**
 * Options that widen what survives an import.
 *
 * Mammoth is built to turn a Word file into clean semantic HTML, so by design it
 * throws away presentation it considers noise. Two of those losses matter for a
 * word processor:
 *
 *   Underline is dropped, because in prose it is often used for emphasis that
 *   should be italic. In a document people are editing it is a formatting
 *   choice they made, so it is mapped straight through.
 *
 *   Paragraph alignment is dropped entirely, and there is no style-map syntax
 *   that can match on it. The transform below reads the alignment that mammoth
 *   does expose on each paragraph, and rewrites the paragraph's style name to a
 *   synthetic marker that the style map turns into a class. The original style
 *   is folded into the marker, so a centred Heading 2 stays both centred and a
 *   heading.
 *
 * Anything beyond this, including numbering definitions, headers, footers,
 * sections and unknown parts, needs the project's own OOXML codec.
 */

/** The alignments worth carrying. Left is the default, so it needs no marker. */
const ALIGNMENTS = ['center', 'right', 'justify'] as const;
type Alignment = (typeof ALIGNMENTS)[number];

/**
 * The paragraph kinds the marker can encode, and the element each becomes.
 * Keep in step with the plain style map below.
 */
const KINDS: { key: string; element: string }[] = [
  { key: 'body', element: 'p' },
  { key: 'h1', element: 'h1' },
  { key: 'h2', element: 'h2' },
  { key: 'h3', element: 'h3' },
  { key: 'h4', element: 'h4' },
  { key: 'h5', element: 'h5' },
  { key: 'h6', element: 'h6' },
  { key: 'quote', element: 'blockquote' },
];

export const MARKER_PREFIX = 'DocForgeAligned';

export const markerFor = (alignment: Alignment, kind: string): string =>
  `${MARKER_PREFIX}-${alignment}-${kind}`;

/**
 * Which paragraph kind a Word style name corresponds to.
 * Returns undefined for a style this importer does not model, so that the
 * paragraph is left exactly as mammoth found it.
 */
export function kindForStyleName(styleName: string | null | undefined): string | undefined {
  if (!styleName) return 'body';
  const heading = /^Heading\s*([1-6])$/iu.exec(styleName.trim());
  if (heading?.[1]) return `h${heading[1]}`;
  const normalized = styleName.trim().toLowerCase();
  if (normalized === 'title') return 'h1';
  if (normalized === 'subtitle') return 'h2';
  if (normalized === 'quote' || normalized === 'intense quote') return 'quote';
  return undefined;
}

/** Word writes justified text as "both". Everything else matches our names. */
export function normalizeAlignment(alignment: string | null | undefined): Alignment | undefined {
  if (!alignment) return undefined;
  const value = alignment.toLowerCase();
  if (value === 'both' || value === 'distribute') return 'justify';
  if (value === 'center' || value === 'right') return value;
  return undefined;
}

/** The full style map: the plain styles first, then one entry per marker. */
export function buildStyleMap(): string[] {
  const map = [
    "p[style-name='Title'] => h1:fresh",
    "p[style-name='Subtitle'] => h2:fresh",
    "p[style-name='Quote'] => blockquote:fresh",
    "p[style-name='Intense Quote'] => blockquote:fresh",
    'u => u',
  ];
  for (const alignment of ALIGNMENTS) {
    for (const kind of KINDS) {
      map.push(
        `p[style-name='${markerFor(alignment, kind.key)}'] => ${kind.element}.align-${alignment}:fresh`,
      );
    }
  }
  return map;
}

interface MammothParagraph {
  alignment?: string | null;
  styleId?: string | null;
  styleName?: string | null;
}

type ParagraphTransform = (paragraph: MammothParagraph) => MammothParagraph;

/**
 * Mammoth exposes `transforms` at run time but leaves it out of its published
 * type declarations, so the part of the shape this file relies on is written
 * out here rather than reached for with a bare cast at the call site.
 */
interface MammothTransforms {
  paragraph: (transform: ParagraphTransform) => (element: unknown) => unknown;
}

/** What a paragraph becomes once its alignment has been folded into its style. */
export function markParagraph(paragraph: MammothParagraph): MammothParagraph {
  // A file can name its own styles. One named like a marker would match the
  // generated style map and pick its own formatting, so the name is taken away
  // before anything else looks at it.
  if (paragraph.styleName?.startsWith(MARKER_PREFIX)) {
    return { ...paragraph, styleId: null, styleName: null };
  }
  const alignment = normalizeAlignment(paragraph.alignment);
  if (!alignment) return paragraph;
  const kind = kindForStyleName(paragraph.styleName);
  if (!kind) return paragraph;
  return { ...paragraph, styleId: null, styleName: markerFor(alignment, kind) };
}

/**
 * Rewrites an aligned paragraph's style name to a marker the style map knows.
 * A paragraph with no alignment, or with a style this importer does not model,
 * is returned untouched.
 *
 * If a future version of mammoth drops `transforms`, importing keeps working
 * and only loses alignment, rather than failing outright.
 */
export function alignmentTransform(mammoth: unknown): ((element: unknown) => unknown) | undefined {
  const transforms = (mammoth as { transforms?: MammothTransforms } | null)?.transforms;
  if (typeof transforms?.paragraph !== 'function') return undefined;
  return transforms.paragraph(markParagraph);
}
