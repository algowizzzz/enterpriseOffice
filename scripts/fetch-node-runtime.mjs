/**
 * Fetch an official Node.js runtime for one platform, verified against the
 * checksums Node itself publishes, and cache it.
 *
 * This runs on the BUILD machine only, which has internet access, exactly
 * once per version and platform. Nothing it does happens on the machine the
 * release is installed on: that machine receives the already-downloaded,
 * already-verified binary inside the release archive and fetches nothing of
 * its own. This is what lets "the build machine needs the network" and "the
 * target machine never does" both be true at once.
 *
 * Only the interpreter binary is kept from each official archive (`node.exe`
 * on Windows, `bin/node` elsewhere), not the copy of npm bundled alongside
 * it: the target runs `node server.mjs` and never `npm`, so npm's own
 * dependency tree would be dead weight and one more thing for a security
 * review to ask about.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, cpSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = join(ROOT, '.cache', 'node-runtimes');

/** Platform identifiers Node publishes, and what each release kit needs from them. */
export const RUNTIMES = {
  'linux-x64': { asset: 'linux-x64.tar.xz', kind: 'tar', binPath: 'bin/node', destPath: 'bin/node' },
  'linux-arm64': { asset: 'linux-arm64.tar.xz', kind: 'tar', binPath: 'bin/node', destPath: 'bin/node' },
  'win-x64': { asset: 'win-x64.zip', kind: 'zip', binPath: 'node.exe', destPath: 'node.exe' },
};

async function sha256(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

/** The exact version DocForge already requires as its floor, so the two never drift apart. */
function requiredNodeRange() {
  const { engines } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return engines?.node ?? '>=22.5';
}

/**
 * Resolve a version string to an exact release. "lts" picks the newest
 * release Node itself currently marks as LTS, which is a stronger, more
 * stable choice than this project's own 22.5 floor: `node:sqlite`, which
 * storage depends on, is further out of "experimental" on the LTS line than
 * on the floor version, and there is no reason to ship the shakier one when a
 * steadier one satisfies the same floor.
 */
async function resolveVersion(want) {
  if (/^\d+\.\d+\.\d+$/u.test(want)) return want;
  const response = await fetch('https://nodejs.org/dist/index.json');
  if (!response.ok) throw new Error(`Could not reach nodejs.org to resolve a version (${response.status})`);
  const releases = await response.json();
  const ltsOnly = releases.filter((entry) => entry.lts);
  ltsOnly.sort((a, b) => (a.date < b.date ? 1 : -1));
  const chosen = ltsOnly[0];
  if (!chosen) throw new Error('nodejs.org listed no LTS release');
  return chosen.version.replace(/^v/u, '');
}

async function officialChecksums(version) {
  const response = await fetch(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`);
  if (!response.ok) throw new Error(`Could not fetch SHASUMS256.txt for v${version} (${response.status})`);
  const text = await response.text();
  const byName = new Map();
  for (const line of text.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/u);
    if (hash && name) byName.set(name, hash);
  }
  return byName;
}

async function downloadArchive(version, assetName, destination) {
  const url = `https://nodejs.org/dist/v${version}/node-v${version}-${assetName}`;
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Could not download ${url} (${response.status})`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

/**
 * The interpreter binary for one platform, at a path good to bundle from,
 * fetched and verified once and cached for every later release build.
 *
 * Returns the local path to a directory containing exactly the destination
 * layout (e.g. `bin/node`, or `node.exe`), so a release script can copy it
 * straight into the archive it is assembling.
 */
export async function nodeRuntime(platform, wantVersion = requiredNodeRange().replace(/^[^\d]*/u, '') || 'lts') {
  const spec = RUNTIMES[platform];
  if (!spec) throw new Error(`Unknown runtime platform "${platform}". Known: ${Object.keys(RUNTIMES).join(', ')}`);

  const version = await resolveVersion(/^\d/u.test(wantVersion) ? wantVersion : 'lts');
  const staged = join(CACHE_DIR, `v${version}-${platform}`);
  const marker = join(staged, '.complete');
  if (existsSync(marker)) {
    const recorded = /sha256 ([0-9a-f]{64})/u.exec(readFileSync(marker, 'utf8'))?.[1];
    return { dir: staged, version, sha256: recorded };
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  const assetName = spec.asset;
  const archivePath = join(CACHE_DIR, `node-v${version}-${assetName}`);

  if (!existsSync(archivePath)) {
    console.log(`  fetching node-v${version}-${assetName} from nodejs.org (build machine only)`);
    await downloadArchive(version, assetName, archivePath);
  }

  const checksums = await officialChecksums(version);
  const expected = checksums.get(`node-v${version}-${assetName}`);
  if (!expected) throw new Error(`nodejs.org's own SHASUMS256.txt for v${version} does not list ${assetName}`);
  const actual = await sha256(archivePath);
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for node-v${version}-${assetName}: expected ${expected}, got ${actual}. ` +
        'The download is corrupt or was tampered with; delete .cache/node-runtimes and try again.',
    );
  }

  mkdirSync(staged, { recursive: true });
  const unpacked = join(CACHE_DIR, `unpack-v${version}-${platform}`);
  mkdirSync(unpacked, { recursive: true });

  if (spec.kind === 'zip') {
    // unzip ships on every macOS and Linux build host; avoids a new dependency
    // for something run at build time only, never on the target machine.
    execFileSync('unzip', ['-q', '-o', archivePath, '-d', unpacked]);
  } else {
    execFileSync('tar', ['-xJf', archivePath, '-C', unpacked]);
  }
  const topLevel = `node-v${version}-${assetName.replace(/\.(?:zip|tar\.xz)$/u, '')}`;
  const sourceBin = join(unpacked, topLevel, spec.binPath);
  if (!existsSync(sourceBin)) throw new Error(`Expected ${spec.binPath} inside the archive, did not find it at ${sourceBin}`);

  const destBin = join(staged, spec.destPath);
  mkdirSync(dirname(destBin), { recursive: true });
  cpSync(sourceBin, destBin);
  if (spec.kind === 'tar') chmodSync(destBin, 0o755);

  const licenseSource = join(unpacked, topLevel, 'LICENSE');
  if (existsSync(licenseSource)) cpSync(licenseSource, join(staged, 'LICENSE-node.txt'));

  // The full unpacked tree (npm and its own dependencies, headers, docs) was
  // only ever a source to copy the interpreter out of; nothing here ships.
  rmSync(unpacked, { recursive: true, force: true });

  writeFileSync(marker, `sha256 ${expected}\nfetched ${new Date().toISOString()}\n`);
  return { dir: staged, version, sha256: expected };
}
