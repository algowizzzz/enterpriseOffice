#!/usr/bin/env node
/**
 * Air-gap guard.
 *
 * The product must never reach the network at runtime: no CDN, no web fonts,
 * no telemetry. This scans the build output for remote URLs and fails the build
 * when it finds one that has not been reviewed.
 *
 * Two different standards are applied, because a URL means different things in
 * different files:
 *
 *   Markup and stylesheets (.html, .css, .svg)
 *     A URL here is a resource the browser will fetch. Any remote URL fails,
 *     with no allowlist. Only XML namespace identifiers are permitted, since
 *     those are names rather than addresses and are never dereferenced.
 *
 *   Scripts (.js, .mjs, .cjs, .json, .map)
 *     A URL here may be a resource to fetch, or it may sit inside an error
 *     message, a comment or documentation text. Static analysis cannot tell
 *     them apart reliably, so every distinct URL must appear in
 *     scripts/air-gap-allowlist.json with a written reason. A new URL fails the
 *     build until somebody looks at it and records why it is harmless.
 *
 * Scope: the browser bundle only. In a page, a URL string can become a request
 * the browser makes, so it is worth auditing every one. The server bundle is
 * deliberately not scanned this way: it inherits hundreds of specification and
 * documentation links from inside its dependencies, none of which are ever
 * dialled, and an allowlist that long would be rubber-stamped rather than read.
 * The server is checked by a stronger method instead. `scripts/smoke-test.mjs`
 * runs it with `scripts/no-outbound-preload.mjs`, which wraps the socket and
 * name-resolution layers and fails the run if the process reaches for any
 * address beyond the loopback interface.
 *
 * Run this after `npm run build`, in continuous integration, and before
 * packaging a release tarball.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOTS = ['apps/web/dist'];
const MARKUP = new Set(['.html', '.css', '.svg']);
const SCRIPT = new Set(['.js', '.mjs', '.cjs', '.json', '.map']);
/**
 * A remote URL needs a dotted host to be fetchable. Requiring one keeps bare
 * scheme fragments, such as the "http://, https:// or mailto:" in a validation
 * message, from being reported as network references.
 */
const URL_PATTERN = /https?:\/\/[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+[^\s"'`),\\<>]*/g;

/** Namespace identifiers. These name a vocabulary and are never fetched. */
const NAMESPACES = [
  /^https?:\/\/(www\.)?w3\.org\//,
  /^https?:\/\/schemas\.openxmlformats\.org\//,
  /^https?:\/\/schemas\.microsoft\.com\//,
  /^https?:\/\/purl\.org\//,
];

const isNamespace = (url) => NAMESPACES.some((pattern) => pattern.test(url));

function loadAllowlist() {
  const file = join(ROOT, 'scripts/air-gap-allowlist.json');
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed.allowed)) {
    throw new Error('air-gap-allowlist.json must contain an "allowed" array');
  }
  for (const entry of parsed.allowed) {
    if (typeof entry.url !== 'string' || typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new Error(
        `Allowlist entry needs a url and a non-empty reason: ${JSON.stringify(entry)}`,
      );
    }
  }
  return parsed.allowed;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const allowed = loadAllowlist();
const allowedUrls = new Set(allowed.map((entry) => entry.url));
const failures = [];
const usedAllowances = new Set();
let scanned = 0;

for (const scanRoot of SCAN_ROOTS) {
  const absolute = join(ROOT, scanRoot);
  if (!existsSync(absolute)) continue;
  for (const path of walk(absolute)) {
    const extension = extname(path);
    const isMarkup = MARKUP.has(extension);
    const isScript = SCRIPT.has(extension);
    if (!isMarkup && !isScript) continue;

    scanned += 1;
    const text = readFileSync(path, 'utf8');
    for (const match of text.match(URL_PATTERN) ?? []) {
      if (isNamespace(match)) continue;
      if (isScript) {
        if (allowedUrls.has(match)) {
          usedAllowances.add(match);
          continue;
        }
        failures.push({
          file: relative(ROOT, path),
          url: match,
          why: 'not in scripts/air-gap-allowlist.json',
        });
      } else {
        failures.push({
          file: relative(ROOT, path),
          url: match,
          why: 'markup and stylesheets may not reference any remote URL',
        });
      }
    }
  }
}

if (scanned === 0) {
  console.error('Air-gap check found nothing to scan. Run the build first.');
  process.exit(1);
}

const stale = allowed.filter((entry) => !usedAllowances.has(entry.url));

if (failures.length > 0) {
  console.error(`Air-gap check FAILED. ${failures.length} unreviewed remote URL reference(s):`);
  const seen = new Set();
  for (const failure of failures) {
    const key = `${failure.file}::${failure.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.error(`  ${failure.file}\n    ${failure.url}\n    ${failure.why}`);
  }
  console.error(
    '\nIf a URL is only ever part of an error message or comment, add it to\n' +
      'scripts/air-gap-allowlist.json with a reason. If the page would actually\n' +
      'fetch it, remove the dependency or vendor the resource instead.',
  );
  process.exit(1);
}

console.log(`Air-gap check passed. Scanned ${scanned} file(s) in the build output.`);
if (stale.length > 0) {
  console.log(
    `Note: ${stale.length} allowlist entr${stale.length === 1 ? 'y is' : 'ies are'} no longer present and can be removed:`,
  );
  for (const entry of stale) console.log(`  ${entry.url}`);
}
