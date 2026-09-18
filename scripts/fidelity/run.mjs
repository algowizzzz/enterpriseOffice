#!/usr/bin/env node
/**
 * Round-trip fidelity harness.
 *
 * Fifty Word documents covering headings, fonts, colour, alignment, lists,
 * tables with shading and merged cells, inline and full-width images, headers,
 * footers, landscape pages, quotes, rules and page breaks are uploaded to a
 * running build, exported again, and the two files are compared as OOXML.
 *
 *   npm run build
 *   node scripts/fidelity/run.mjs            # upload, export, compare
 *   node scripts/fidelity/run.mjs --shots    # and photograph each document
 *
 * Output goes to DOCFORGE_FIDELITY_DIR, /tmp/docforge-fidelity by default:
 * the corpus, every exported file, a JSON result and a Markdown report.
 *
 * This is not part of `npm run verify`. It measures how much of a Word document
 * survives the conversion, which is a number to track, not a pass or a fail.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorpus, packDocument, FEATURES } from './corpus.mjs';
import { profileDocx } from './profile.mjs';
import { compareProfiles } from './compare.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BUNDLE = join(ROOT, 'apps/server/dist/server.mjs');
const WEB_ROOT = join(ROOT, 'apps/web/dist');
const PORT = Number(process.env['DOCFORGE_FIDELITY_PORT'] ?? 8131);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env['DOCFORGE_FIDELITY_DIR'] ?? join(tmpdir(), 'docforge-fidelity');
const ADMIN_EMAIL = 'admin@localhost';
const ADMIN_PASSWORD = 'Fidelity-Harness-1';
const WANT_SHOTS = process.argv.includes('--shots');

if (!existsSync(BUNDLE)) {
  console.error(`Missing ${BUNDLE}. Run "npm run build" first.`);
  process.exit(1);
}

mkdirSync(join(OUT, 'source'), { recursive: true });
mkdirSync(join(OUT, 'exported'), { recursive: true });
if (WANT_SHOTS) mkdirSync(join(OUT, 'screenshots'), { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let cookie = '';

async function call(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body !== undefined && !(options.body instanceof FormData)
        ? { 'content-type': 'application/json' }
        : {}),
      ...(cookie ? { cookie } : {}),
      ...(options.headers ?? {}),
    },
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return response;
}

async function waitForHealth(attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return true;
    } catch {
      /* still starting */
    }
    await sleep(250);
  }
  return false;
}

const dataDir = join(OUT, 'data');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const server = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', BUNDLE],
  {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DOCFORGE_PORT: String(PORT),
      DOCFORGE_HOST: '127.0.0.1',
      DOCFORGE_DB: join(dataDir, 'docforge.db'),
      DOCFORGE_WEB_ROOT: WEB_ROOT,
      DOCFORGE_ADMIN_EMAIL: ADMIN_EMAIL,
      DOCFORGE_ADMIN_PASSWORD: ADMIN_PASSWORD,
      DOCFORGE_SECURE_COOKIES: '0',
      // The harness uploads fifty files in a row, which the ordinary limits are
      // not meant for. They are exercised by the test suite instead.
      DOCFORGE_IMPORT_RATE_LIMIT: '100000',
      DOCFORGE_EXPORT_RATE_LIMIT: '100000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
const serverLog = [];
server.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
server.stderr.on('data', (chunk) => serverLog.push(String(chunk)));

const results = [];
let browser = null;

try {
  if (!(await waitForHealth())) {
    console.error(serverLog.join('').slice(-1000));
    throw new Error('the server never became healthy');
  }
  const signIn = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!signIn.ok) throw new Error(`sign in failed: ${signIn.status}`);

  if (WANT_SHOTS) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      executablePath: process.env['DOCFORGE_CHROMIUM'] ?? undefined,
    });
  }

  const corpus = buildCorpus();
  console.log(`Uploading ${corpus.length} documents…\n`);

  for (const entry of corpus) {
    const source = await packDocument(entry);
    writeFileSync(join(OUT, 'source', `${entry.name}.docx`), source);

    const form = new FormData();
    form.append('file', new Blob([source]), `${entry.name}.docx`);
    const uploaded = await call('/api/documents/import', { method: 'POST', body: form });
    const body = await uploaded.json();
    if (!uploaded.ok) {
      results.push({ name: entry.name, features: entry.features, error: body?.error?.message ?? uploaded.status });
      console.log(`  ${entry.name}: upload failed (${uploaded.status})`);
      continue;
    }

    const id = body.document.id;
    const exported = Buffer.from(
      await (await call(`/api/documents/${id}/export?format=docx`)).arrayBuffer(),
    );
    writeFileSync(join(OUT, 'exported', `${entry.name}.docx`), exported);

    const scores = compareProfiles(profileDocx(source), profileDocx(exported), entry.features);
    const totals = Object.values(scores).reduce(
      (sum, score) => ({
        expected: sum.expected + score.expected,
        preserved: sum.preserved + score.preserved,
      }),
      { expected: 0, preserved: 0 },
    );

    results.push({
      name: entry.name,
      features: entry.features,
      scores,
      totals,
      messages: body.messages ?? [],
      documentId: id,
    });

    if (browser) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      await page.context().addCookies([
        { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: BASE },
      ]);
      await page.goto(`${BASE}/documents/${id}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('[role="textbox"]', { timeout: 15000 }).catch(() => {});
      await sleep(250);
      await page.screenshot({ path: join(OUT, 'screenshots', `${entry.name}.png`), fullPage: true });
      await page.close();
    }

    const percent = totals.expected === 0 ? 100 : (totals.preserved / totals.expected) * 100;
    console.log(`  ${entry.name}: ${percent.toFixed(1)}% (${totals.preserved}/${totals.expected})`);
  }
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}

/** Aggregate per feature across every document that contained it. */
const byFeature = {};
for (const result of results) {
  for (const [feature, score] of Object.entries(result.scores ?? {})) {
    byFeature[feature] ??= { expected: 0, preserved: 0, documents: 0 };
    byFeature[feature].expected += score.expected;
    byFeature[feature].preserved += score.preserved;
    if (score.expected > 0) byFeature[feature].documents += 1;
  }
}

const overall = Object.values(byFeature).reduce(
  (sum, score) => ({
    expected: sum.expected + score.expected,
    preserved: sum.preserved + score.preserved,
  }),
  { expected: 0, preserved: 0 },
);

const percent = (score) =>
  score.expected === 0 ? '—' : `${((score.preserved / score.expected) * 100).toFixed(1)}%`;

const lines = [
  '# Round-trip fidelity',
  '',
  `${results.length} Word documents uploaded, exported and compared as OOXML on ${new Date().toISOString().slice(0, 10)}.`,
  '',
  `**Overall: ${percent(overall)} of the measured items survived** (${overall.preserved} of ${overall.expected}).`,
  '',
  '## By feature',
  '',
  '| Feature | Documents | Items | Preserved | Score |',
  '|---|---:|---:|---:|---:|',
  ...Object.entries(byFeature)
    .sort((a, b) => a[1].preserved / (a[1].expected || 1) - b[1].preserved / (b[1].expected || 1))
    .map(
      ([feature, score]) =>
        `| ${FEATURES[feature] ?? feature} | ${score.documents} | ${score.expected} | ${score.preserved} | ${percent(score)} |`,
    ),
  '',
  '## By document',
  '',
  '| Document | Score | Items | Notes |',
  '|---|---:|---:|---|',
  ...results.map((result) =>
    result.error
      ? `| ${result.name} | failed | — | ${result.error} |`
      : `| ${result.name} | ${percent(result.totals)} | ${result.totals.preserved}/${result.totals.expected} | ${(result.messages ?? []).join(' ') || ''} |`,
  ),
  '',
];

writeFileSync(join(OUT, 'report.md'), lines.join('\n'));
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ byFeature, overall, results }, null, 2));

console.log(`\nOverall: ${percent(overall)} (${overall.preserved}/${overall.expected})`);
console.log(`Report:  ${join(OUT, 'report.md')}`);
