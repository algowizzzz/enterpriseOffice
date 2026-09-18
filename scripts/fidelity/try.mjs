#!/usr/bin/env node
/**
 * Round trip your own Word documents and see what survives.
 *
 *   npm run build
 *   node scripts/fidelity/try.mjs path/to/a.docx path/to/folder ...
 *
 * The corpus harness beside this file scores documents this project generated,
 * which proves the reader and the writer agree with each other and nothing
 * more. This script takes documents from anywhere else, which is the test that
 * matters before a rollout: a corporate template, a policy that has been edited
 * by twenty people, a file last saved by a different word processor.
 *
 * Nothing is kept. It starts its own server on a spare port against a database
 * in a temporary directory, with an account that exists only for the run, and
 * removes both afterwards. The documents never leave the machine.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { profileDocx } from './profile.mjs';
import { compareProfiles, CHECK_NAMES } from './compare.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BUNDLE = join(ROOT, 'apps/server/dist/server.mjs');
const WEB_ROOT = join(ROOT, 'apps/web/dist');
const PORT = Number(process.env['DOCFORGE_TRY_PORT'] ?? 8132);
const BASE = `http://127.0.0.1:${PORT}`;

const args = process.argv.slice(2);
const keepIndex = args.indexOf('--keep');
const KEEP = keepIndex === -1 ? null : resolve(args[keepIndex + 1] ?? 'try-output');
const inputs = args.filter((_, index) => keepIndex === -1 || (index !== keepIndex && index !== keepIndex + 1));

if (inputs.length === 0) {
  console.error('Usage: node scripts/fidelity/try.mjs [--keep <dir>] <file.docx | folder> ...');
  process.exit(2);
}
if (!existsSync(BUNDLE)) {
  console.error(`Missing ${BUNDLE}. Run "npm run build" first.`);
  process.exit(1);
}

const files = [];
for (const input of inputs) {
  const path = resolve(input);
  if (!existsSync(path)) {
    console.error(`No such file or folder: ${input}`);
    process.exit(2);
  }
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      // "~$name.docx" is the lock file Word leaves beside an open document.
      if (name.toLowerCase().endsWith('.docx') && !name.startsWith('~$')) files.push(join(path, name));
    }
  } else {
    files.push(path);
  }
}

/**
 * Things the model has no place for yet. They are counted in the source so the
 * report can say "this document had nine comments and they are gone" instead of
 * leaving somebody to find out from a reviewer.
 */
function unsupportedIn(buffer) {
  const parts = unzipSync(new Uint8Array(buffer));
  const xml = parts['word/document.xml'] ? strFromU8(parts['word/document.xml']) : '';
  const count = (pattern) => (xml.match(pattern) ?? []).length;
  const sections = count(/<w:sectPr[\s>]/gu);
  return {
    'tracked insertions': count(/<w:ins\s/gu),
    'tracked deletions': count(/<w:del\s/gu),
    comments: count(/<w:commentReference\s/gu),
    footnotes: count(/<w:footnoteReference\s/gu),
    endnotes: count(/<w:endnoteReference\s/gu),
    'fields (contents, page numbers, dates)': count(/<w:fldChar\s[^>]*w:fldCharType="begin"/gu) + count(/<w:fldSimple\s/gu),
    'text boxes and shapes': count(/<w:txbxContent[\s>]/gu) + count(/<wps:wsp[\s>]/gu),
    'charts and SmartArt': count(/<c:chart\s/gu) + count(/<dgm:relIds\s/gu),
    'embedded objects': count(/<w:object[\s>]/gu),
    'content controls': count(/<w:sdt[\s>]/gu),
    'sections after the first': Math.max(0, sections - 1),
    'multi-column sections': count(/<w:cols\s[^>]*w:num="(?:[2-9]|\d{2,})"/gu),
    'tables inside tables': count(/<w:tc>(?:(?!<\/w:tc>).)*<w:tbl>/gsu),
  };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let cookie = '';
async function call(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body !== undefined && !(options.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return response;
}

const work = mkdtempSync(join(tmpdir(), 'docforge-try-'));
const email = 'trial@localhost';
const password = `Try-${randomBytes(12).toString('hex')}-A1`;
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', BUNDLE], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    DOCFORGE_PORT: String(PORT),
    DOCFORGE_HOST: '127.0.0.1',
    DOCFORGE_DB: join(work, 'docforge.db'),
    DOCFORGE_WEB_ROOT: WEB_ROOT,
    DOCFORGE_ADMIN_EMAIL: email,
    DOCFORGE_ADMIN_PASSWORD: password,
    DOCFORGE_SECURE_COOKIES: '0',
    DOCFORGE_IMPORT_RATE_LIMIT: '100000',
    DOCFORGE_EXPORT_RATE_LIMIT: '100000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
server.stdout.on('data', (chunk) => log.push(String(chunk)));
server.stderr.on('data', (chunk) => log.push(String(chunk)));

let failed = 0;
try {
  let healthy = false;
  for (let i = 0; i < 80 && !healthy; i += 1) {
    try {
      healthy = (await fetch(`${BASE}/api/health`)).ok;
    } catch {
      await sleep(250);
    }
  }
  if (!healthy) throw new Error(`the server never became healthy\n${log.join('').slice(-800)}`);
  const signIn = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  if (!signIn.ok) throw new Error(`sign in failed: ${signIn.status}`);
  if (KEEP) mkdirSync(KEEP, { recursive: true });

  for (const file of files) {
    const name = basename(file);
    const source = readFileSync(file);
    console.log(`\n${name}  (${(source.length / 1024).toFixed(0)} KB)`);

    const started = Date.now();
    const form = new FormData();
    form.append('file', new Blob([source]), name);
    const uploaded = await call('/api/documents/import', { method: 'POST', body: form });
    const body = await uploaded.json();
    if (!uploaded.ok) {
      failed += 1;
      console.log(`  REFUSED (${uploaded.status}): ${body?.error?.message ?? 'no message'}`);
      continue;
    }
    const importMs = Date.now() - started;
    const id = body.document.id;

    // Save it straight back, unchanged. An upload that the server's own
    // validator then refuses to save is the worst outcome there is: the
    // document opens and can never be kept.
    const opened = await (await call(`/api/documents/${id}`)).json();
    const saved = await call(`/api/documents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        title: opened.document.title,
        content: opened.document.content,
        expectedRevision: opened.document.revision,
      }),
    });
    const savedBody = saved.ok ? null : await saved.json();

    const exportStarted = Date.now();
    const exported = Buffer.from(await (await call(`/api/documents/${id}/export?format=docx`)).arrayBuffer());
    const exportMs = Date.now() - exportStarted;
    if (KEEP) writeFileSync(join(KEEP, name.replace(/\.docx$/iu, '.roundtrip.docx')), exported);

    const scores = compareProfiles(profileDocx(source), profileDocx(exported), CHECK_NAMES);
    console.log(`  imported in ${importMs} ms, exported in ${exportMs} ms`);
    console.log(`  saves unchanged: ${saved.ok ? 'yes' : `NO (${saved.status}) ${savedBody?.error?.message ?? ''}`}`);
    if (!saved.ok) failed += 1;
    for (const [feature, score] of Object.entries(scores)) {
      if (score.expected === 0) continue;
      const mark = score.preserved === score.expected ? 'ok  ' : 'LOST';
      console.log(`  ${mark} ${feature}: ${score.preserved} of ${score.expected}`);
    }
    const dropped = Object.entries(unsupportedIn(source)).filter(([, n]) => n > 0);
    if (dropped.length > 0) {
      console.log('  not carried (no place in the model yet):');
      for (const [what, n] of dropped) console.log(`       ${n} x ${what}`);
    }
    for (const message of body.messages ?? []) console.log(`  note: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
  }
} finally {
  server.kill();
  await sleep(200);
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${files.length} document(s) tried${failed ? `, ${failed} with a problem that blocks use` : ''}.`);
if (KEEP) console.log(`Round-tripped copies are in ${KEEP}. Open them in Word beside the originals.`);
process.exit(failed ? 1 : 0);
