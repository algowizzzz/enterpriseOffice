#!/usr/bin/env node
/**
 * Write THIRD-PARTY-NOTICES.txt: every package that ships, with its licence.
 *
 * MIT, BSD and ISC all ask for one thing, that the copyright notice travels
 * with the software. The server bundle and the browser bundle inline a hundred
 * and fifty packages and carried the notices of a handful, which is the kind of
 * gap a licence review finds in its first hour. This is also the list such a
 * review asks for, so it doubles as the bill of materials.
 *
 * Only what ships is listed: the production dependencies of the workspaces, at
 * any depth. Build tools and test runners never reach the target machine.
 *
 * It fails, loudly, on a licence outside the project's allowed set. That is the
 * point of running it in the release: a transitive dependency that changes its
 * licence stops the release instead of reaching a customer.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowed, electedFrom, recogniseLicence, REVIEWED } from './licence-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));

const entries = [];
const problems = [];
for (const [path, meta] of Object.entries(lock.packages)) {
  if (!path.includes('node_modules/') || meta.dev || meta.link) continue;
  // An optional dependency is one the bundle is built without. The only one
  // here is a native canvas that a PDF library would use to draw pages, which
  // this project never does, and native code does not ship: see CLAUDE.md.
  if (meta.optional) continue;
  const dir = join(ROOT, path);
  if (!existsSync(join(dir, 'package.json'))) continue; // an optional package for another platform
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const name = path.replace(/^.*node_modules\//u, '');
  if (name.startsWith('@docforge/')) continue;
  let licence =
    typeof manifest.license === 'string'
      ? manifest.license
      : (manifest.license?.type ?? manifest.licenses?.map((item) => item.type).join(' OR ') ?? 'UNKNOWN');
  const file = readdirSync(dir).find((item) => /^(?:licen[cs]e|copying)(?:[.-].*)?$/iu.test(item));
  // A manifest that says nothing is not the same as no licence: some packages
  // ship the text and never filled in the field. The text is what binds, so it
  // is read, and the notice says that is where the answer came from.
  let fromFile = false;
  if (licence === 'UNKNOWN' && file) {
    const recognised = recogniseLicence(readFileSync(join(dir, file), 'utf8'));
    if (recognised) {
      licence = recognised;
      fromFile = true;
    }
  }
  // A package whose licence is not an identifier the gate can read, and which
  // somebody has read instead. By name, never by label: "BSD" on its own says
  // nothing about which text a package ships.
  const reviewed = REVIEWED[name];
  if (!allowed(licence) && !reviewed) problems.push(`${name}@${manifest.version}: ${licence}`);

  const notice = readdirSync(dir).find((item) => /^notice(?:\..*)?$/iu.test(item));
  entries.push({
    name,
    version: manifest.version,
    licence,
    fromFile,
    elected: /\sOR\s/u.test(licence) ? electedFrom(licence) : null,
    homepage: typeof manifest.repository === 'string' ? manifest.repository : (manifest.repository?.url ?? manifest.homepage ?? ''),
    text: file ? readFileSync(join(dir, file), 'utf8').trim() : null,
    notice: notice ? readFileSync(join(dir, notice), 'utf8').trim() : null,
  });
}

if (problems.length > 0) {
  console.error('These packages ship under a licence the project does not accept:\n');
  for (const line of problems) console.error(`  ${line}`);
  console.error('\nReplace them, or make the case for the licence in CLAUDE.md first.');
  process.exit(1);
}

entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const counts = {};
for (const entry of entries) counts[entry.elected ?? entry.licence] = (counts[entry.elected ?? entry.licence] ?? 0) + 1;

const lines = [
  'DocForge: third-party notices',
  '',
  'DocForge itself is released under the MIT licence; see LICENSE.',
  `The ${entries.length} packages below are compiled into server.mjs or into the browser`,
  'client. Nothing else ships. None of them is under the GPL, the AGPL or any',
  'other licence that places conditions on the software that uses it.',
  '',
  ...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([licence, n]) => `  ${String(n).padStart(4)}  ${licence}`),
  '',
];
for (const entry of entries) {
  lines.push('='.repeat(78), `${entry.name} ${entry.version}`, `Licence: ${entry.licence}`);
  if (REVIEWED[entry.name]) lines.push(`Reviewed by hand: ${REVIEWED[entry.name].description}`);
  if (entry.fromFile) lines.push('The package manifest declares no licence. This is the licence of the text it ships, below.');
  if (entry.elected) lines.push(`Offered under a choice of licences. DocForge uses it under: ${entry.elected}`);
  if (entry.homepage) lines.push(`Source: ${entry.homepage.replace(/^git\+/u, '').replace(/\.git$/u, '')}`);
  lines.push('');
  lines.push(entry.text ?? `(The package carries no licence file. Its manifest declares ${entry.licence}.)`);
  if (entry.notice) lines.push('', '--- NOTICE ---', entry.notice);
  lines.push('');
}

const out = process.argv[2] ?? join(ROOT, 'THIRD-PARTY-NOTICES.txt');
writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`${entries.length} packages, ${Object.keys(counts).length} licences, written to ${out}`);
for (const [licence, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${licence}`);
