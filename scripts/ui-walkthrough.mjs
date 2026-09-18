/**
 * Browser walkthrough. Drives the built portal in a real browser and writes a
 * screenshot of each screen, so a change that breaks the layout is visible
 * rather than merely untested.
 *
 * Playwright is not a project dependency: an air-gapped build should not carry
 * a browser download. Install it where you need it and point this at the
 * Chromium you already have.
 *
 *   npm install --no-save playwright
 *   node scripts/ui-walkthrough.mjs
 *
 * Set DOCFORGE_CHROMIUM if Chromium lives somewhere other than the default
 * below, and DOCFORGE_SHOT_DIR to choose where the images are written.
 *
 * Run `npm run build` first. This is not part of `npm run verify`, because it
 * needs a browser that the verified build deliberately does not ship.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env['DOCFORGE_SHOT_DIR'] ?? join(tmpdir(), 'docforge-shots');
mkdirSync(OUT, { recursive: true });

const dataDir = mkdtempSync(join(tmpdir(), 'docforge-shots-'));
const server = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', join(ROOT, 'apps/server/dist/server.mjs')],
  {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DOCFORGE_PORT: String(PORT),
      DOCFORGE_HOST: '127.0.0.1',
      DOCFORGE_DB: join(dataDir, 'd.db'),
      DOCFORGE_WEB_ROOT: join(ROOT, 'apps/web/dist'),
      DOCFORGE_ADMIN_EMAIL: 'admin@localhost',
      DOCFORGE_ADMIN_PASSWORD: 'Demo-Admin-Pass-1',
      DOCFORGE_SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
const log = [];
server.stdout.on('data', (c) => log.push(String(c)));
server.stderr.on('data', (c) => log.push(String(c)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60; i += 1) {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) break;
  } catch {}
  await sleep(250);
}

const chromiumPath = process.env['DOCFORGE_CHROMIUM'] ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ executablePath: chromiumPath });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

// The air gap, checked from the browser's side. The build-time audit looks for
// URL strings and the server probe watches its sockets; this watches what the
// page actually asks for. Anything not served by this origin is a violation,
// whether it came from our code, a dependency, or a document somebody uploaded.
const offOrigin = [];
page.on('request', (request) => {
  const url = request.url();
  if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) return;
  offOrigin.push(`${request.method()} ${url}`);
});

try {
  // 1. Sign in
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${OUT}/1-signin.png` });

  await page.getByLabel('Email').fill('admin@localhost');
  await page.getByLabel('Password').fill('Demo-Admin-Pass-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForSelector('text=Documents', { timeout: 15000 });
  await sleep(500);
  await page.screenshot({ path: `${OUT}/2-empty-documents.png` });

  // 2. Create a document and type into it
  await page.getByRole('button', { name: 'New blank document' }).click();
  await page.waitForSelector('[role="textbox"]', { timeout: 15000 });
  await sleep(800);

  await page.getByLabel('Document title').fill('Quarterly Operations Review');

  const body = page.locator('[role="textbox"]');
  await body.click();
  await page.keyboard.type('Quarterly Operations Review');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Prepared for the leadership team. This document was written in DocForge and can be exported to Word.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Key findings');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Throughput improved across all three regions.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Error rates fell for the fourth quarter running.');
  await sleep(300);

  // Make the first line a Heading 1
  await body.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift');
  await page.keyboard.press('End');
  await page.keyboard.up('Shift');
  await page.selectOption('#tb-style', '1');
  await sleep(300);

  await page.screenshot({ path: `${OUT}/3-editor.png` });

  // 3. Insert a table to show the ribbon working
  await body.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Insert table' }).click();
  await sleep(500);
  await page.screenshot({ path: `${OUT}/4-editor-table.png` });

  // Wait for autosave to settle
  await page.waitForSelector('text=All changes saved', { timeout: 15000 });

  // 4. Version history
  await page.getByRole('button', { name: 'History' }).click();
  await sleep(600);
  await page.screenshot({ path: `${OUT}/5-history.png` });
  await page.getByRole('button', { name: 'History' }).click();

  // 5. Documents list with the document in it
  await page.getByRole('button', { name: '← Documents' }).click();
  await page.waitForSelector('table.grid', { timeout: 15000 });
  await sleep(500);
  await page.screenshot({ path: `${OUT}/6-documents.png` });

  // 6. Administration
  await page.getByRole('button', { name: 'Administration' }).click();
  await page.waitForSelector('text=Audit trail', { timeout: 15000 });
  await sleep(600);
  await page.screenshot({ path: `${OUT}/7-admin.png`, fullPage: true });

  console.log('Screenshots written to', OUT);
  console.log('Console errors:', errors.length === 0 ? 'none' : errors.slice(0, 10));

  if (offOrigin.length > 0) {
    console.error('\nAIR GAP VIOLATION: the page requested addresses it does not serve:');
    for (const request of [...new Set(offOrigin)]) console.error(`  ${request}`);
    process.exitCode = 1;
  } else {
    console.log('Air gap: the page requested nothing beyond its own origin.');
  }
} catch (error) {
  console.error('FAILED:', error.message);
  await page.screenshot({ path: `${OUT}/failure.png` }).catch(() => {});
  console.error('server log tail:', log.join('').slice(-1500));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
}
