/**
 * What licence a shipped package is under, and whether that is allowed.
 *
 * Shared by third-party-notices.mjs (the notice a person reads) and
 * generate-sbom.mjs (the same list a scanner reads): both describe the same
 * set of shipped packages, so both must resolve an ambiguous or missing
 * licence field the same way, or a reviewer comparing the two documents
 * finds them disagreeing about what is actually in the archive. This module
 * is the one place that resolution happens.
 */

/** SPDX identifiers the project accepts. See CLAUDE.md, invariant 2. */
export const ALLOWED = new Set([
  'MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0',
  'MPL-2.0', 'OFL-1.1', 'BlueOak-1.0.0', 'Zlib', 'CC0-1.0', 'Unlicense',
]);

/**
 * Whether an SPDX expression can be satisfied from the allowed set. "A OR B"
 * needs one side, "A AND B" needs both. jszip is "MIT OR GPL-3.0-or-later": it
 * is taken under MIT, and the notice says so.
 */
export function allowed(expression) {
  const clean = expression.replace(/[()]/gu, '').trim();
  if (/\sOR\s/u.test(clean)) return clean.split(/\sOR\s/u).some((side) => allowed(side));
  if (/\sAND\s/u.test(clean)) return clean.split(/\sAND\s/u).every((side) => allowed(side));
  return ALLOWED.has(clean);
}

/** Which side of an "A OR B" expression is taken, when it is one this ships under. */
export const electedFrom = (expression) =>
  expression.replace(/[()]/gu, '').split(/\sOR\s/u).map((side) => side.trim()).find((side) => allowed(side));

/**
 * Licences read by a person, with what they found. Add to this only after
 * reading the text the package ships, and say what it says. These are not
 * SPDX identifiers and never will be, so they carry their own plain-text
 * description rather than an `allowed`-checkable expression.
 */
export const REVIEWED = {
  'dictionary-en': {
    name: 'SCOWL word list terms (not an SPDX licence)',
    description:
      'The SCOWL word lists (Kevin Atkinson and contributors). Permission to use, copy, modify, distribute and sell for any purpose without fee, with the notices kept; parts are public domain; the WordNet notice is the same kind of grant. No copyleft. The same lists ship in Firefox and LibreOffice.',
  },
  'dictionary-en-gb': {
    name: 'SCOWL word list terms (not an SPDX licence)',
    description: 'The SCOWL word lists, British spelling, on the same terms as dictionary-en, plus the UKACD list, which may be redistributed freely with its notice.',
  },
};

/** The licence a text is, when it is unmistakably one of the common permissive ones. */
export function recogniseLicence(text) {
  const flat = text.replace(/\s+/gu, ' ');
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/u.test(flat) && /THE SOFTWARE IS PROVIDED "AS IS"/u.test(flat)) return 'MIT';
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee/u.test(flat)) return 'ISC';
  if (/Apache License,? Version 2\.0/u.test(flat)) return 'Apache-2.0';
  if (/Redistribution and use in source and binary forms/u.test(flat)) {
    return /Neither the name of/u.test(flat) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  }
  return null;
}

/**
 * Resolve one package's declared licence to what it should be recorded as.
 * `dir` is the package's own folder, so a licence file can be read when the
 * manifest says nothing. Returns `{ resolved, fromFile, reviewed, problem }`:
 * `resolved` is an SPDX id/expression to record, unless `reviewed` is set, in
 * which case use its `name`/`description` instead; `problem` is set when
 * neither the manifest, a recognised licence file, nor a hand review account
 * for what this package ships, which should stop a release.
 */
export function resolveLicence(name, declared, readLicenceFile) {
  const reviewed = REVIEWED[name];
  let resolved = declared;
  let fromFile = false;
  if (resolved === 'UNKNOWN' || !resolved) {
    const text = readLicenceFile();
    const recognised = text ? recogniseLicence(text) : null;
    if (recognised) {
      resolved = recognised;
      fromFile = true;
    }
  }
  const elected = /\sOR\s/u.test(resolved ?? '') ? electedFrom(resolved) : null;
  const problem = !reviewed && !allowed(resolved ?? 'UNKNOWN') ? `${name}: ${resolved ?? 'UNKNOWN'}` : null;
  return { resolved: resolved ?? 'UNKNOWN', fromFile, elected, reviewed, problem };
}
