#!/usr/bin/env node
/**
 * Assemble the release: one archive that installs on a server with no network.
 *
 *   npm run release            # verify, then package
 *   npm run release -- --skip-verify   # package what is already built
 *
 * The archive holds the server bundle, the browser client, the systemd unit,
 * the installer and its two checkers, the settings template, the third-party
 * notices, this project's licence, the deployment guide and a SHA256SUMS over
 * all of it. It does not hold Node: the runtime is somebody else's binary, and
 * most organisations have their own approved copy and their own way of getting
 * it onto a machine. The installer takes the official archive as it comes.
 *
 * Nothing in the archive was fetched at install time, because nothing is
 * fetched at install time. `npm` runs here, on the build machine, and never on
 * the target.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
const capture = (command, args) => execFileSync(command, args, { cwd: ROOT, encoding: 'utf8' }).trim();

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
if (process.argv.includes('--skip-verify')) {
  if (!existsSync(join(ROOT, 'apps/server/dist/server.mjs')) || !existsSync(join(ROOT, 'apps/web/dist/index.html'))) {
    console.error('Nothing is built. Run "npm run build", or drop --skip-verify.');
    process.exit(1);
  }
} else {
  // A release that has not passed the gate is not a release.
  run(npm, ['run', 'verify']);
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
let commit = 'unknown';
let dirty = false;
try {
  commit = capture('git', ['rev-parse', '--short=10', 'HEAD']);
  dirty = capture('git', ['status', '--porcelain']).length > 0;
} catch {
  /* built from an exported tree with no repository */
}
const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const version = `${manifest.version}+${stamp}.${commit}${dirty ? '.dirty' : ''}`;
const name = `docforge-${manifest.version}-${stamp}-${commit}${dirty ? '-dirty' : ''}`;

const OUT = join(ROOT, 'release');
const STAGE = join(OUT, name);
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const put = (from, to = from) => cpSync(join(ROOT, from), join(STAGE, to), { recursive: true });
put('apps/server/dist/server.mjs', 'server.mjs');
put('apps/web/dist', 'web');
put('deploy/systemd/docforge.service', 'docforge.service');
put('deploy/linux/install.sh', 'install.sh');
put('deploy/linux/preflight.sh', 'preflight.sh');
put('deploy/linux/verify-install.sh', 'verify-install.sh');
put('.env.example', 'env.example');
put('docs/08-enterprise-deployment.md', 'DEPLOY.md');
put('LICENSE');
for (const script of ['install.sh', 'preflight.sh', 'verify-install.sh']) chmodSync(join(STAGE, script), 0o755);

run(process.execPath, ['scripts/third-party-notices.mjs', join(STAGE, 'THIRD-PARTY-NOTICES.txt')], { stdio: 'ignore' });
writeFileSync(join(STAGE, 'VERSION'), `${version}\n`);

// Proof the staged copy runs with nothing beside it: no node_modules, no source
// tree, and no DOCFORGE_WEB_ROOT, so it has to find the client next to itself
// the way it will in /opt/docforge. This is the state it is in on the target.
await standaloneCheck();

async function standaloneCheck() {
  const work = mkdtempSync(join(tmpdir(), 'docforge-release-'));
  const port = 8133;
  const env = { PATH: process.env.PATH ?? '', NODE_ENV: 'production', DOCFORGE_PORT: String(port), DOCFORGE_DB: join(work, 'check.db'), DOCFORGE_SECURE_COOKIES: '0' };
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(STAGE, 'server.mjs')], { cwd: work, env, stdio: 'ignore' });
  try {
    let page = null;
    for (let i = 0; i < 60 && !page; i += 1) {
      await new Promise((done) => setTimeout(done, 250));
      page = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
    }
    const html = page ? await page.text() : '';
    if (!page?.ok || !html.includes('<div id="root"')) {
      throw new Error(`the staged release did not serve its page (status ${page?.status ?? 'none'})`);
    }
    console.log('The staged release starts on its own and serves the page.');
  } finally {
    server.kill();
    await new Promise((done) => setTimeout(done, 200));
    rmSync(work, { recursive: true, force: true });
  }
}

function walk(dir, found = []) {
  for (const item of readdirSync(dir).sort()) {
    const path = join(dir, item);
    if (statSync(path).isDirectory()) walk(path, found);
    else found.push(path);
  }
  return found;
}
// The format `sha256sum -c` reads: hash, two spaces, path.
const sums = walk(STAGE)
  .map((path) => `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${relative(STAGE, path).split('\\').join('/')}`)
  .join('\n');
writeFileSync(join(STAGE, 'SHA256SUMS'), `${sums}\n`);

const archive = join(OUT, `${name}.tar.gz`);
rmSync(archive, { force: true });
// COPYFILE_DISABLE stops macOS tar adding "._name" files that mean nothing on
// Linux and that SHA256SUMS does not list.
run('tar', ['-czf', archive, '-C', OUT, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${digest}  ${name}.tar.gz\n`);

console.log(`\n${name}.tar.gz  ${(statSync(archive).size / 1024 / 1024).toFixed(1)} MB`);
console.log(`sha256 ${digest}`);
console.log(`version ${version}`);
if (dirty) console.log('\nBuilt from a tree with uncommitted changes. Fine for a trial, not for a record.');
console.log('\nCopy the archive and an official Linux archive of Node 22 to the server, then follow DEPLOY.md inside it.');
