/**
 * Compare what went in with what came out.
 *
 * Every check counts items, not documents: a document with twelve coloured
 * cells of which nine survive scores nine of twelve, not zero or one. A feature
 * a document never contained is not counted at all, so the score cannot be
 * flattered by documents that had nothing to lose.
 */

const normalise = (text) => text.replace(/\s+/gu, ' ').trim().toLowerCase();
const words = (text) => normalise(text).split(' ').filter(Boolean);

/** How much of the source text is present in the exported text. */
export function textRecall(source, exported) {
  const wanted = words(source);
  if (wanted.length === 0) return { expected: 0, preserved: 0 };
  const available = new Map();
  for (const word of words(exported)) available.set(word, (available.get(word) ?? 0) + 1);
  let found = 0;
  for (const word of wanted) {
    const left = available.get(word) ?? 0;
    if (left > 0) {
      available.set(word, left - 1);
      found += 1;
    }
  }
  return { expected: wanted.length, preserved: found };
}

const sameText = (a, b) => normalise(a) === normalise(b);

/** Runs carrying a property, flattened with the paragraph they came from. */
const allRuns = (profile) =>
  profile.paragraphs.flatMap((paragraph) =>
    paragraph.runs.filter((run) => run.text.length > 0).map((run) => ({ ...run, paragraph })),
  );

function count(expected, predicate) {
  let preserved = 0;
  for (const item of expected) if (predicate(item)) preserved += 1;
  return { expected: expected.length, preserved };
}

const CHECKS = {
  headings(source, exported) {
    const wanted = source.paragraphs.filter((p) => p.heading !== null && p.text);
    return count(wanted, (p) =>
      exported.paragraphs.some((q) => q.heading === p.heading && sameText(q.text, p.text)),
    );
  },

  characterFormatting(source, exported) {
    const marks = ['bold', 'italic', 'underline', 'strike'];
    const wanted = allRuns(source).filter((run) => marks.some((mark) => run[mark]));
    const exportedRuns = allRuns(exported);
    return count(wanted, (run) =>
      exportedRuns.some(
        (other) =>
          sameText(other.text, run.text) && marks.every((mark) => Boolean(other[mark]) === Boolean(run[mark])),
      ),
    );
  },

  fonts(source, exported) {
    const wanted = allRuns(source).filter((run) => run.font || run.size);
    const exportedRuns = allRuns(exported);
    return count(wanted, (run) =>
      exportedRuns.some(
        (other) =>
          sameText(other.text, run.text) &&
          (!run.font || other.font === run.font) &&
          (!run.size || other.size === run.size),
      ),
    );
  },

  colour(source, exported) {
    const wanted = allRuns(source).filter(
      (run) => (run.colour && run.colour !== 'auto') || run.highlight,
    );
    const exportedRuns = allRuns(exported);
    return count(wanted, (run) =>
      exportedRuns.some(
        (other) =>
          sameText(other.text, run.text) &&
          (!run.colour || run.colour === 'auto' || other.colour === run.colour) &&
          (!run.highlight || other.highlight === run.highlight),
      ),
    );
  },

  alignment(source, exported) {
    const wanted = source.paragraphs.filter((p) => p.alignment && p.text);
    return count(wanted, (p) =>
      exported.paragraphs.some(
        (q) => sameText(q.text, p.text) && normaliseAlignment(q.alignment) === normaliseAlignment(p.alignment),
      ),
    );
  },

  lists(source, exported) {
    const wanted = source.paragraphs.filter((p) => p.numbered && p.text);
    return count(wanted, (p) => exported.paragraphs.some((q) => q.numbered && sameText(q.text, p.text)));
  },

  table(source, exported) {
    const wanted = source.tables.flatMap((table) => table.cells.filter((cell) => cell.text));
    const available = exported.tables.flatMap((table) => table.cells);
    const structure = count(source.tables, (table) => {
      const other = exported.tables[source.tables.indexOf(table)];
      return Boolean(other) && other.rows === table.rows && other.columns === table.columns;
    });
    const cells = count(wanted, (cell) => available.some((other) => sameText(other.text, cell.text)));
    return {
      expected: structure.expected + cells.expected,
      preserved: structure.preserved + cells.preserved,
    };
  },

  tableShading(source, exported) {
    const wanted = source.tables
      .flatMap((table) => table.cells)
      .filter((cell) => cell.fill && cell.fill !== 'auto');
    const available = exported.tables.flatMap((table) => table.cells);
    return count(wanted, (cell) =>
      available.some((other) => sameText(other.text, cell.text) && other.fill === cell.fill),
    );
  },

  tableMerge(source, exported) {
    const wanted = source.tables
      .flatMap((table) => table.cells)
      .filter((cell) => cell.gridSpan > 1 || cell.verticalMerge);
    const available = exported.tables.flatMap((table) => table.cells);
    return count(wanted, (cell) =>
      available.some(
        (other) =>
          (cell.text ? sameText(other.text, cell.text) : true) &&
          other.gridSpan === cell.gridSpan &&
          other.verticalMerge === cell.verticalMerge,
      ),
    );
  },

  image(source, exported) {
    const wanted = source.images;
    const available = [...exported.images];
    let preserved = 0;
    for (const picture of wanted) {
      const index = available.findIndex(
        (other) =>
          Math.abs(other.width - picture.width) <= picture.width * 0.05 &&
          Math.abs(other.height - picture.height) <= picture.height * 0.05,
      );
      if (index >= 0) {
        available.splice(index, 1);
        preserved += 1;
      }
    }
    return { expected: wanted.length, preserved };
  },

  fullPageImage(source, exported) {
    const widest = Math.max(0, ...source.images.map((picture) => picture.width));
    if (widest === 0) return { expected: 0, preserved: 0 };
    const out = Math.max(0, ...exported.images.map((picture) => picture.width));
    return { expected: 1, preserved: Math.abs(out - widest) <= widest * 0.05 ? 1 : 0 };
  },

  header(source, exported) {
    return count(source.headerText, (text) =>
      exported.headerText.some((other) => sameText(other, text)),
    );
  },

  footer(source, exported) {
    return count(source.footerText, (text) =>
      exported.footerText.some((other) => sameText(other, text)),
    );
  },

  landscape(source, exported) {
    if (!source.landscape) return { expected: 0, preserved: 0 };
    return { expected: 1, preserved: exported.landscape ? 1 : 0 };
  },

  pageBreak(source, exported) {
    const wanted = source.paragraphs.filter((p) => p.pageBreak);
    const available = exported.paragraphs.filter((p) => p.pageBreak);
    return { expected: wanted.length, preserved: Math.min(wanted.length, available.length) };
  },

  quote(source, exported) {
    const wanted = source.paragraphs.filter((p) => /quote/iu.test(p.style ?? '') && p.text);
    return count(wanted, (p) =>
      exported.paragraphs.some(
        (q) => sameText(q.text, p.text) && (q.indented || /quote/iu.test(q.style ?? '')),
      ),
    );
  },

  rule(source, exported) {
    const wanted = source.paragraphs.filter((p) => p.bottomBorder);
    const available = exported.paragraphs.filter((p) => p.bottomBorder);
    return { expected: wanted.length, preserved: Math.min(wanted.length, available.length) };
  },
};

const normaliseAlignment = (value) => {
  if (value === 'start') return 'left';
  if (value === 'end') return 'right';
  if (value === 'both') return 'justify';
  return value;
};

/** Score one document: every feature it declared, plus its text. */
export function compareProfiles(source, exported, features) {
  const scores = {};
  for (const feature of features) {
    const check = CHECKS[feature];
    if (check) scores[feature] = check(source, exported);
  }
  scores.text = textRecall(source.text, exported.text);
  return scores;
}

export const CHECK_NAMES = Object.keys(CHECKS);
