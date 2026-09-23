#!/usr/bin/env node
/**
 * Assemble releases that need nothing installed on the machine they run on:
 * the Node runtime, the server, the client, and a launcher, all in one
 * archive per platform.
 *
 *   npm run release                    # verify, then package all platforms
 *   npm run release -- --skip-verify   # package what is already built
 *   npm run release -- --platform linux-x64,windows-x64
 *
 * Every archive is complete on its own: unpack it and run the launcher inside
 * it, with no other software fetched or installed first. What is NOT
 * self-contained is this script itself: it downloads the official Node
 * runtime for each target platform from nodejs.org, which needs the BUILD
 * machine to have internet access. That happens here, once, and is verified
 * against the checksums Node itself publishes (see fetch-node-runtime.mjs).
 * Nothing downloaded here is fetched again on the machine the release is
 * installed on; that machine only ever unpacks a file it was handed.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeRuntime } from './fetch-node-runtime.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
const capture = (command, args) => execFileSync(command, args, { cwd: ROOT, encoding: 'utf8' }).trim();

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};

/** Every platform this can produce a self-contained kit for. */
const PLATFORMS = {
  'linux-x64': { label: 'Linux, x86-64', kind: 'targz' },
  'linux-arm64': { label: 'Linux, ARM64', kind: 'targz' },
  'windows-x64': { label: 'Windows, x86-64', kind: 'zip' },
};
const wanted = (flag('platform') ?? Object.keys(PLATFORMS).join(',')).split(',').map((p) => p.trim());
for (const platform of wanted) {
  if (!PLATFORMS[platform]) {
    console.error(`Unknown platform "${platform}". Known: ${Object.keys(PLATFORMS).join(', ')}`);
    process.exit(2);
  }
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
if (args.includes('--skip-verify')) {
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

const OUT = join(ROOT, 'release');
mkdirSync(OUT, { recursive: true });

/** Files every platform's kit carries, independent of OS or CPU. */
function stageCommon(stage) {
  const put = (from, to = from) => cpSync(join(ROOT, from), join(stage, to), { recursive: true });
  put('apps/server/dist/server.mjs', 'server.mjs');
  put('apps/web/dist', 'web');
  put('LICENSE');
  run(process.execPath, ['scripts/third-party-notices.mjs', join(stage, 'THIRD-PARTY-NOTICES.txt')], { stdio: 'ignore' });
  run(process.execPath, ['scripts/generate-sbom.mjs', join(stage, 'sbom.cdx.json')], { stdio: 'ignore' });
  writeFileSync(join(stage, 'VERSION'), `${version}\n`);
}

function walk(dir, found = []) {
  for (const item of readdirSync(dir).sort()) {
    const path = join(dir, item);
    if (statSync(path).isDirectory()) walk(path, found);
    else found.push(path);
  }
  return found;
}

function writeChecksums(stage) {
  // The format `sha256sum -c` reads: hash, two spaces, path. Windows carries
  // no such tool by default, but the same file still lets anyone compare a
  // hash by hand, and PowerShell's Get-FileHash reads the same hex.
  const sums = walk(stage)
    .map((path) => `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${relative(stage, path).split('\\').join('/')}`)
    .join('\n');
  writeFileSync(join(stage, 'SHA256SUMS'), `${sums}\n`);
}

/**
 * Prove the staged copy runs with nothing beside it: no node_modules, no
 * source tree, no DOCFORGE_WEB_ROOT. This uses THIS machine's own Node, as a
 * stand-in for the platform's own bundled binary, because a cross-platform
 * binary (an arm64 Linux build, say) cannot literally be executed here. What
 * it proves is that server.mjs and web/ are correct and self-sufficient,
 * which is the part that is identical on every platform; the interpreter
 * binary itself is a separate, official download, checked by hash instead
 * (see fetch-node-runtime.mjs), and by actually running it under Docker on
 * Linux (see docs/08-enterprise-deployment.md for how that was done).
 */
async function standaloneCheck(stage) {
  const work = mkdtempSync(join(tmpdir(), 'docforge-release-'));
  const port = 8133;
  const env = { PATH: process.env.PATH ?? '', NODE_ENV: 'production', DOCFORGE_PORT: String(port), DOCFORGE_DB: join(work, 'check.db'), DOCFORGE_SECURE_COOKIES: '0' };
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(stage, 'server.mjs')], { cwd: work, env, stdio: 'ignore' });
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
  } finally {
    server.kill();
    await new Promise((done) => setTimeout(done, 200));
    rmSync(work, { recursive: true, force: true });
  }
}

const built = [];

for (const platform of wanted) {
  console.log(`\n=== ${PLATFORMS[platform].label} ===`);
  const name = `docforge-${manifest.version}-${stamp}-${commit}${dirty ? '-dirty' : ''}-${platform}`;
  const stage = join(OUT, name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  stageCommon(stage);

  console.log('  fetching and verifying the Node runtime for this platform (build machine only)...');
  const runtimeKey = platform === 'windows-x64' ? 'win-x64' : platform;
  const { dir: runtimeDir, version: nodeVersion, sha256: nodeSha256 } = await nodeRuntime(runtimeKey);
  cpSync(runtimeDir, join(stage, 'node'), { recursive: true, filter: (src) => !src.endsWith('.complete') });
  writeFileSync(
    join(stage, 'NODE-VERSION.txt'),
    `Node v${nodeVersion}, official ${runtimeKey} build from nodejs.org\n` +
      `Verified against nodejs.org's own SHASUMS256.txt: sha256 ${nodeSha256}\n`,
  );

  if (platform === 'windows-x64') {
    cpSync(join(ROOT, 'deploy/windows/start-docforge.cmd'), join(stage, 'start-docforge.cmd'));
    cpSync(join(ROOT, 'docs/13-windows-quickstart.md'), join(stage, 'README-FIRST.md'));
  } else {
    for (const script of ['run-standalone.sh', 'install.sh', 'preflight.sh', 'verify-install.sh']) {
      cpSync(join(ROOT, 'deploy/linux', script), join(stage, script));
      chmodSync(join(stage, script), 0o755);
    }
    cpSync(join(ROOT, 'deploy/systemd/docforge.service'), join(stage, 'docforge.service'));
    cpSync(join(ROOT, '.env.example'), join(stage, 'env.example'));
    cpSync(join(ROOT, 'docs/08-enterprise-deployment.md'), join(stage, 'DEPLOY.md'));
  }
  chmodSync(join(stage, 'node', platform === 'windows-x64' ? 'node.exe' : 'bin/node'), 0o755);

  // The server.mjs/web pairing is identical across platforms and is what this
  // machine's own Node can actually execute; see the function's own comment.
  await standaloneCheck(stage);
  console.log('  the staged server runs on its own and serves the page');

  writeChecksums(stage);

  const archivePath = join(OUT, `${name}.${PLATFORMS[platform].kind === 'zip' ? 'zip' : 'tar.gz'}`);
  rmSync(archivePath, { force: true });
  if (PLATFORMS[platform].kind === 'zip') {
    run('zip', ['-rq', archivePath, name], { cwd: OUT });
  } else {
    // COPYFILE_DISABLE stops macOS tar adding "._name" files that mean
    // nothing on Linux and that SHA256SUMS does not list.
    run('tar', ['-czf', archivePath, '-C', OUT, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  }
  const digest = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  writeFileSync(`${archivePath}.sha256`, `${digest}  ${relative(OUT, archivePath)}\n`);
  console.log(`  ${relative(OUT, archivePath)}  ${(statSync(archivePath).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  sha256 ${digest}`);
  built.push({ platform, archivePath, digest });
}

console.log(`\nversion ${version}`);
if (dirty) console.log('Built from a tree with uncommitted changes. Fine for a trial, not for a record.');
console.log('\nEach archive under release/ is complete on its own: copy it and nothing');
console.log('else across the gap, unpack it, and run the launcher inside it.');
console.log('  Linux, as a systemd service (needs root once):    sudo sh install.sh');
console.log('  Linux, no install at all, run as your own user:   sh run-standalone.sh');
console.log('  Windows, double-click:                            start-docforge.cmd');
