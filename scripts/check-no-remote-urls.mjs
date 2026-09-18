#!/usr/bin/env node
// Air-gap guard: fails the build if any bundled asset references a remote URL.
// Run after `npm run build`, in CI and before packaging a release tarball.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['apps/web/dist', 'apps/server/dist'];
const TEXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.map', '.svg']);
const ALLOW = [/https?:\/\/(www\.)?w3\.org/, /https?:\/\/(www\.)?schemas\.openxmlformats\.org/, /https?:\/\/purl\.org/, /https?:\/\/schemas\.microsoft\.com/];
const URL_RE = /https?:\/\/[^\s"'`)\\]+/g;

const findings = [];
function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!TEXT.has(extname(p))) continue;
    const text = readFileSync(p, 'utf8');
    for (const match of text.match(URL_RE) ?? []) {
      if (ALLOW.some((re) => re.test(match))) continue;
      findings.push(`${p}: ${match}`);
    }
  }
}

ROOTS.forEach(walk);
if (findings.length) {
  console.error('Air-gap check FAILED. Remote URLs found in build output:');
  for (const f of new Set(findings)) console.error('  ' + f);
  process.exit(1);
}
console.log('Air-gap check passed: no remote URLs in build output.');
