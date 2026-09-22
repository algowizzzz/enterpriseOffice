#!/usr/bin/env node
/**
 * Write a software bill of materials in CycloneDX 1.5 JSON: the machine-
 * readable list a security team's own scanning tool reads, as opposed to
 * THIRD-PARTY-NOTICES.txt, which is the same list for a person to read.
 *
 *   node scripts/generate-sbom.mjs [output path]
 *
 * The two files answer the same question and must agree, so this walks
 * package-lock.json with the same production-only filter third-party-
 * notices.mjs uses (node_modules paths, not dev, not optional, a
 * package.json present, not this workspace's own @docforge/* packages): if
 * you change what counts as "ships" in one of these files, change it in the
 * other, or a reviewer comparing the two will find them disagreeing about
 * what is actually in the archive.
 *
 * No network access and no new dependency: everything here comes from the
 * lockfile already on disk, which is itself the record of what a connected
 * build machine resolved and pinned.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLicence } from './licence-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const licenceOf = (value) =>
  typeof value === 'string' ? value : (value?.type ?? null);

const components = [];
const problems = [];
for (const [path, meta] of Object.entries(lock.packages)) {
  if (!path.includes('node_modules/') || meta.dev || meta.link || meta.optional) continue;
  const dir = join(ROOT, path);
  const packageJsonPath = join(dir, 'package.json');
  if (!existsSync(packageJsonPath)) continue;
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const name = path.replace(/^.*node_modules\//u, '');
  if (name.startsWith('@docforge/')) continue;

  const declared = licenceOf(pkg.license) ?? pkg.licenses?.map((entry) => entry.type).join(' OR ') ?? 'UNKNOWN';
  const licenceFile = readdirSync(dir).find((item) => /^(?:licen[cs]e|copying)(?:[.-].*)?$/iu.test(item));
  const { resolved, elected, reviewed, problem } = resolveLicence(name, declared, () =>
    licenceFile ? readFileSync(join(dir, licenceFile), 'utf8') : null,
  );
  if (problem) problems.push(problem);

  const scope = name.startsWith('@') ? name.split('/')[0].slice(1) : null;
  const bareName = name.startsWith('@') ? name.split('/')[1] : name;
  // purl: the standard way a scanner cross-references a component against its
  // own vulnerability feed, so this is worth getting right even in a hand-
  // written generator.
  const purl = `pkg:npm/${scope ? `%40${scope}%2F` : ''}${bareName}@${pkg.version}`;
  // CycloneDX wants either an SPDX id/expression, or, for a licence that is
  // not SPDX at all (the two dictionaries), a plain name instead.
  const licenceField = reviewed
    ? { license: { name: reviewed.name } }
    : { license: elected ? { id: elected } : /\sOR\s|\sAND\s/u.test(resolved) ? { expression: resolved } : { id: resolved } };

  components.push({
    type: 'library',
    'bom-ref': `${name}@${pkg.version}`,
    name,
    version: pkg.version,
    purl,
    licenses: [licenceField],
    ...(pkg.homepage || pkg.repository
      ? {
          externalReferences: [
            {
              type: 'website',
              url: (pkg.homepage ?? (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url) ?? '')
                .replace(/^git\+/u, '')
                .replace(/\.git$/u, ''),
            },
          ],
        }
      : {}),
  });
}
components.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

if (problems.length > 0) {
  console.error('These packages ship under a licence the project does not accept:\n');
  for (const line of problems) console.error(`  ${line}`);
  console.error('\nSame check third-party-notices.mjs runs; that one is the release gate. Fix there first.');
  process.exit(1);
}

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: 'application',
      name: manifest.name ?? 'docforge',
      version: manifest.version,
    },
    // What runs on the target is server.mjs and web/: this whole tree, minus
    // build and test tooling, was compiled or copied into those two things.
    // Nothing here is a native binary; the Node runtime bundled alongside is
    // a separate, official artefact and is not one of npm's own packages, so
    // it is not listed as a component here (see NODE-VERSION.txt instead).
    properties: [
      { name: 'docforge:runtime', value: 'server.mjs runs under Node.js; no native modules' },
      { name: 'docforge:generated-by', value: 'scripts/generate-sbom.mjs' },
    ],
  },
  components,
};

const output = process.argv[2] ?? join(ROOT, 'sbom.cdx.json');
writeFileSync(output, `${JSON.stringify(bom, null, 2)}\n`);
console.log(`${components.length} components written to ${output}`);
