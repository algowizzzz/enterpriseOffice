#!/usr/bin/env node
/**
 * Bundle the server into a single file for air-gapped deployment.
 *
 * The output has no `node_modules` requirement, so a release tarball is the
 * bundle, the built web client, the fonts and a Node runtime. Native modules
 * are avoided on purpose: the database is `node:sqlite`, which ships with Node.
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'apps/server');
const outfile = join(SERVER, 'dist/server.mjs');

mkdirSync(join(SERVER, 'dist'), { recursive: true });

const result = await build({
  entryPoints: [join(SERVER, 'src/index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  minify: false,
  legalComments: 'external',
  // Node's own modules stay external; everything else is inlined.
  // The native canvas is an optional dependency of the PDF reader, wanted only
  // to draw pages, which the server never does. It is left out so that the
  // bundle stays free of native code; the reader copes without it.
  external: ['node:*', '@napi-rs/canvas', 'canvas'],
  alias: {
    '@docforge/model': join(ROOT, 'packages/model/src/index.ts'),
  },
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  metafile: true,
  logLevel: 'info',
});

const bytes = readFileSync(outfile).length;
writeFileSync(join(SERVER, 'dist/meta.json'), JSON.stringify(result.metafile));
console.log(`Bundled server: ${(bytes / 1024 / 1024).toFixed(2)} MB at apps/server/dist/server.mjs`);
