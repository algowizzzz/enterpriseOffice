#!/usr/bin/env node
/**
 * Load the test corpus into a running DocForge instance, as the seed
 * administrator, so a person can open and review each document from the
 * ordinary documents list instead of running the fidelity harness.
 *
 *   node scripts/seed-library.mjs                       # http://127.0.0.1:8080
 *   node scripts/seed-library.mjs --base http://host:port
 *
 * Idempotent: a title already in the account is left alone and reported as
 * skipped, so running this twice does not duplicate the library. Nothing here
 * touches the fidelity harness or its scoring; it only uploads files that
 * already exist on disk.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const BASE = flag('base', 'http://127.0.0.1:8080');

/** Every source folder to draw from, and the label shown beside each upload. */
const SOURCES = [
  { dir: join(ROOT, 'data/test-docs'), docType: 'Policy', note: 'hand-built, feature-dense' },
  { dir: join(ROOT, 'data/test-docs/lo'), docType: 'Policy', note: 'LibreOffice-rendered' },
  { dir: join(ROOT, 'data/wide-corpus'), docType: undefined, note: 'wide corpus: 3 independent producers' },
];

/** A document type guessed from the file name, for the wide corpus. */
function guessType(name) {
  if (/comments|references|tracked/iu.test(name)) return 'Policy';
  if (/tables|big-table/iu.test(name)) return 'Standard';
  if (/builtin-styles|style-lists|character|paragraph/iu.test(name)) return 'Guideline';
  return 'Other';
}

async function login() {
  const passwordFile = join(ROOT, 'data/.admin-password');
  if (!existsSync(passwordFile)) {
    console.error(`No admin password file at ${passwordFile}. Start the server once to create the seed account.`);
    process.exit(1);
  }
  const password = readFileSync(passwordFile, 'utf8').trim();
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@localhost', password }),
  });
  if (!response.ok) {
    console.error(`Sign-in failed (${response.status}). Is the server running at ${BASE}?`);
    process.exit(1);
  }
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) {
    console.error('Signed in but no session cookie came back.');
    process.exit(1);
  }
  return cookie;
}

async function existingTitles(cookie) {
  const response = await fetch(`${BASE}/api/documents`, { headers: { cookie } });
  if (!response.ok) throw new Error(`Could not list documents (${response.status})`);
  const { documents } = await response.json();
  return new Set(documents.map((doc) => doc.title));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Upload one file, waiting out the server's own import rate limit rather than
 * giving up. Converting a Word file is CPU bound, so the server deliberately
 * caps imports per minute; a full corpus upload runs past that cap and should
 * finish anyway rather than report a wall of failures.
 */
async function upload(cookie, filePath, docType) {
  const name = basename(filePath);
  const body = readFileSync(filePath);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const form = new FormData();
    if (docType) form.append('docType', docType);
    form.append('file', new Blob([body]), name);
    const response = await fetch(`${BASE}/api/documents/import`, { method: 'POST', headers: { cookie }, body: form });
    if (response.status !== 429) {
      const parsed = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, body: parsed };
    }
    if (attempt === 0) process.stdout.write('  (waiting out the import rate limit) ');
    process.stdout.write('.');
    await sleep(5000);
  }
  return { ok: false, status: 429, body: { error: { message: 'still rate limited after waiting' } } };
}

const cookie = await login();
const already = await existingTitles(cookie);
console.log(`Signed in. ${already.size} document(s) already in the library.\n`);

let uploaded = 0;
let skipped = 0;
let failed = 0;

for (const source of SOURCES) {
  if (!existsSync(source.dir)) {
    console.log(`(missing) ${source.dir} — run its generator first, see docs`);
    continue;
  }
  const files = readdirSync(source.dir)
    .filter((name) => name.toLowerCase().endsWith('.docx') && !name.includes('roundtrip'))
    .sort();
  if (files.length === 0) continue;
  console.log(`${source.dir.replace(ROOT + '/', '')}  (${source.note})`);
  for (const name of files) {
    const title = name.replace(/\.docx$/iu, '');
    if (already.has(title)) {
      console.log(`  = skip     ${name}  (already in the library)`);
      skipped += 1;
      continue;
    }
    const docType = source.docType ?? guessType(name);
    const result = await upload(cookie, join(source.dir, name), docType);
    if (result.ok) {
      console.log(`  + uploaded ${name}  [${docType}]`);
      uploaded += 1;
    } else {
      console.log(`  ! failed   ${name}  (${result.status} ${result.body?.error?.message ?? ''})`);
      failed += 1;
    }
  }
  console.log('');
}

console.log(`${uploaded} uploaded, ${skipped} already present, ${failed} failed.`);
console.log(`Open ${BASE} and sign in to browse the library.`);
if (failed > 0) process.exit(1);
