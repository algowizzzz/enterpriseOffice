#!/usr/bin/env node
/**
 * End-to-end smoke test against a real running server.
 *
 * The unit and integration suites use in-process injection. This one starts the
 * bundled server as a separate process, talks to it over HTTP, and walks the
 * whole journey a user takes: sign in, create an account, start a document,
 * type into it, export it as .docx, upload that file back, and read it again.
 *
 * Run it after `npm run build` and before shipping a release.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'apps/server/dist/server.mjs');
const WEB_ROOT = join(ROOT, 'apps/web/dist');
const PORT = Number(process.env['SMOKE_PORT'] ?? 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = 'admin@localhost';
const ADMIN_PASSWORD = 'Smoke-Test-Admin-1';

let passed = 0;
const failures = [];

function check(description, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${description}`);
  } else {
    failures.push(description);
    console.error(`  FAIL ${description}${detail ? `\n         ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A cookie jar, so the run exercises the same session mechanism a browser uses. */
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

const asJson = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

async function waitForHealth(attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      // The server is still starting.
    }
    await sleep(250);
  }
  return false;
}

if (!existsSync(BUNDLE)) {
  console.error(`Missing ${BUNDLE}. Run the server build first.`);
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), 'docforge-smoke-'));
// The probe appends a line here for every attempt to reach a non-loopback
// address. An air-gapped build must leave it empty.
const outboundLog = join(dataDir, 'outbound.log');
writeFileSync(outboundLog, '');
const server = spawn(
  process.execPath,
  [
    '--disable-warning=ExperimentalWarning',
    '--import',
    join(ROOT, 'scripts/no-outbound-preload.mjs'),
    BUNDLE,
  ],
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
      DOCFORGE_OUTBOUND_LOG: outboundLog,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

const serverLog = [];
server.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
server.stderr.on('data', (chunk) => serverLog.push(String(chunk)));

function shutdown() {
  server.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
}

try {
  console.log('Starting the bundled server…');
  const healthy = await waitForHealth();
  check('the server starts and answers its health check', healthy, serverLog.join('').slice(-800));
  if (!healthy) throw new Error('server never became healthy');

  console.log('\nSeed administrator');
  const bootstrap = await asJson(await call('/api/auth/bootstrap'));
  check('the seed administrator was created from configuration', bootstrap.needsSetup === false);

  const signIn = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const admin = await asJson(signIn);
  check('the administrator can sign in', signIn.status === 200 && admin.user?.role === 'admin');

  const badSignIn = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: 'definitely-wrong' }),
  });
  check('a wrong password is rejected', badSignIn.status === 401);

  console.log('\nUser management');
  const createUser = await call('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      email: 'writer@localhost',
      name: 'Wendy Writer',
      password: 'Smoke-Test-Writer-1',
      role: 'editor',
    }),
  });
  check('an administrator can create an account', createUser.status === 201);

  const adminCookie = cookie;
  cookie = '';
  const writerSignIn = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'writer@localhost', password: 'Smoke-Test-Writer-1' }),
  });
  check('the new account can sign in', writerSignIn.status === 200);

  console.log('\nStart a document from scratch');
  const created = await asJson(
    await call('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ title: 'Smoke test report' }),
    }),
  );
  const documentId = created.document?.id;
  check('a blank document is created', Boolean(documentId));

  const typed = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: 'Smoke test report' }],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Typed in the editor with ' },
          { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' text.' },
        ],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A bullet point' }] }],
          },
        ],
      },
    ],
  };
  const saved = await asJson(
    await call(`/api/documents/${documentId}`, {
      method: 'PUT',
      body: JSON.stringify({ content: typed, expectedRevision: created.document.revision }),
    }),
  );
  check('edits are saved and the revision advances', saved.document?.revision === 2);
  check('the word count is recalculated on save', saved.document?.wordCount > 5);

  const staleSave = await call(`/api/documents/${documentId}`, {
    method: 'PUT',
    body: JSON.stringify({ content: typed, expectedRevision: 1 }),
  });
  check('a stale save is refused as a conflict', staleSave.status === 409);

  console.log('\nExport');
  const exported = await call(`/api/documents/${documentId}/export?format=docx`);
  const docxBytes = Buffer.from(await exported.arrayBuffer());
  check('the export returns a Word content type', exported.status === 200);
  check(
    'the exported file is a real zip container',
    docxBytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
  );
  check(
    'the export is offered as a download with the document title',
    (exported.headers.get('content-disposition') ?? '').includes('Smoke test report.docx'),
  );

  console.log('\nUpload the exported file back');
  const form = new FormData();
  form.append(
    'file',
    new Blob([docxBytes], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
    'Smoke test report.docx',
  );
  const imported = await asJson(
    await call('/api/documents/import', { method: 'POST', body: form }),
  );
  const importedText = JSON.stringify(imported.document?.content ?? {});
  check('the upload creates a document', imported.document?.origin === 'import');
  check('the uploaded title comes from the file name', imported.document?.title === 'Smoke test report');
  check('the heading survived the round trip', importedText.includes('Smoke test report'));
  check('the bullet survived the round trip', importedText.includes('A bullet point'));
  check('bold formatting survived the round trip', importedText.includes('"bold"'));

  const rejectedUpload = await (async () => {
    const bad = new FormData();
    bad.append('file', new Blob(['a,b,c'], { type: 'text/csv' }), 'figures.csv');
    return call('/api/documents/import', { method: 'POST', body: bad });
  })();
  check('a file that is neither Word nor PDF is rejected', rejectedUpload.status === 415);

  console.log('\nOriginal, PDF, comments and comparison');
  const importedId = imported.document?.id;
  const original = await call(`/api/documents/${importedId}/export?format=original`);
  const originalBytes = Buffer.from(await original.arrayBuffer());
  check('the file that was uploaded can be downloaded again, byte for byte', originalBytes.equals(Buffer.from(docxBytes)));

  const asPdf = await call(`/api/documents/${importedId}/export?format=pdf`);
  const pdfBytes = Buffer.from(await asPdf.arrayBuffer());
  check('the document exports as a PDF', asPdf.ok && pdfBytes.subarray(0, 5).toString() === '%PDF-');

  const pdfForm = new FormData();
  pdfForm.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'Round trip.pdf');
  const fromPdf = await asJson(await call('/api/documents/import', { method: 'POST', body: pdfForm }));
  check(
    'a PDF uploads as a document that can be edited',
    JSON.stringify(fromPdf.document?.content ?? {}).includes('A bullet point'),
  );
  // Removed again, so that the checks further down still count what they expect.
  if (fromPdf.document?.id) await call(`/api/documents/${fromPdf.document.id}`, { method: 'DELETE' });

  const commented = await call(`/api/documents/${importedId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: 'Checked by the smoke test.' }),
  });
  const threads = await asJson(await call(`/api/documents/${importedId}/comments`));
  check('a comment is kept and listed', commented.status === 201 && threads.threads?.length === 1);

  const current = await asJson(await call(`/api/documents/${importedId}`));
  const changed = JSON.parse(JSON.stringify(current.document.content));
  changed.content.push({ type: 'paragraph', content: [{ type: 'text', text: 'Added since the original.' }] });
  await call(`/api/documents/${importedId}`, {
    method: 'PUT',
    body: JSON.stringify({ content: changed, expectedRevision: current.document.revision }),
  });
  const redline = await asJson(await call(`/api/documents/${importedId}/compare?from=1`));
  check(
    'a comparison with the original marks what was added',
    JSON.stringify(redline.content ?? {}).includes('"insertion"'),
  );
  check('the document says which shared session to join', Number(current.document?.collab?.epoch) >= 1);

  console.log('\nAccess control');
  const writerCookie = cookie;
  cookie = adminCookie;
  const adminWrite = await call(`/api/documents/${documentId}`, {
    method: 'PUT',
    body: JSON.stringify({ title: 'Renamed by an administrator' }),
  });
  check('an administrator cannot silently edit another person document', adminWrite.status === 403);

  cookie = '';
  const anonymous = await call('/api/documents');
  check('an anonymous request is refused', anonymous.status === 401);

  cookie = writerCookie;
  const listed = await asJson(await call('/api/documents'));
  check('the owner sees both documents', listed.documents?.length === 2);

  console.log('\nVersion history');
  const versions = await asJson(await call(`/api/documents/${documentId}/versions`));
  check('every save is kept as a version', versions.versions?.length === 2);

  console.log('\nWeb client');
  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  check('the single-page client is served', page.status === 200 && html.includes('<div id="root">'));
  check(
    'a content security policy confines the page to this origin',
    (page.headers.get('content-security-policy') ?? '').includes("default-src 'self'"),
  );
  const deepLink = await fetch(`${BASE}/documents/${documentId}`);
  check('a deep link falls through to the client router', deepLink.status === 200);

  console.log('\nAir gap');
  const outbound = readFileSync(outboundLog, 'utf8').trim();
  check(
    'the server made no connection beyond the loopback interface',
    outbound.length === 0,
    outbound.split('\n').slice(0, 5).join('\n         '),
  );

  console.log('\nSign out');
  const signOut = await call('/api/auth/logout', { method: 'POST' });
  check('sign out succeeds', signOut.status === 200);
  const afterSignOut = await call('/api/documents');
  check('the session no longer works after sign out', afterSignOut.status === 401);
} catch (error) {
  failures.push(`unexpected error: ${error.message}`);
  console.error(error);
} finally {
  shutdown();
}

console.log(`\n${passed} checks passed, ${failures.length} failed.`);
if (failures.length > 0) {
  console.error('Failed checks:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('Smoke test passed.');
