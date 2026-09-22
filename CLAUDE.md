# Working on DocForge

Instructions for any agent working in this repository. Read `HANDOVER.md` first
for what the project is and where it stands.

## Autonomy

- Run commands, install dependencies, create and edit files without asking.
- Decide ordinary things yourself. Ask only when two readings of a request lead
  to materially different work.
- When something fails, debug and fix it before reporting back.
- Report what happened, including what failed. Never describe work as done that
  has not been run.

## The commands that matter

```sh
npm ci                  # once
npm run verify          # lint, typecheck, both suites, build, air-gap audit, end to end
npm test                # the two unit suites only
npm run dev             # API on 8080, client on 5173, both with reload
npm run build && npm start   # the built server, serving the built client
node scripts/fidelity/run.mjs          # 50-document Word round trip, scored
node scripts/fidelity/run.mjs --shots  # the same, photographing each document
node scripts/ui-walkthrough.mjs        # drive the built portal in a browser
npm run try -- <files or folders>      # round trip your own Word documents
sh scripts/fidelity/wide/make_all.sh data/wide-corpus   # 35 documents from three other producers, dev-only, uses LibreOffice
node scripts/seed-library.mjs          # load the test corpus into a running local instance to browse
npm run release                        # self-contained kits: Linux x64, Linux arm64, Windows x64, Node bundled in each
node scripts/generate-sbom.mjs         # CycloneDX bill of materials; kept in step with third-party-notices.mjs
```

`scripts/fidelity/wide/make_all.sh` is the one place LibreOffice appears anywhere
in this repository. It builds throwaway test documents on a developer's own
machine and is never invoked by `npm run release` or anything that ships. Do
not let it become a dependency of anything that runs on a target machine.

`npm run verify` is the gate. It must pass before any commit. It takes about
forty seconds.

Playwright is deliberately not a dependency: an air-gapped build should not
carry a browser. Install it where you need it with
`npm install --no-save playwright`, or point `DOCFORGE_CHROMIUM` at one you have.

## Invariants

Break any of these and something real breaks with it.

1. **Nothing is fetched at run time.** No CDN, no web font, no telemetry, no
   analytics, no remote image. `npm run audit:airgap` fails the build on a
   remote URL in the browser bundle, and the end-to-end run fails if the server
   opens a socket beyond loopback. If you need an asset, vendor it.
2. **Licences stay clean.** MIT, BSD, Apache-2.0, ISC, MPL-2.0 and SIL OFL only.
   No GPL or AGPL, at any depth. `npm run notices` enforces it. The two spelling
   dictionaries are under the SCOWL word-list terms, which are permissive but not
   an SPDX identifier; they are allowed by name in that script, with what the
   text says. Nothing else may be added there without reading what it ships. That rules out OnlyOffice, CKEditor 5 and
   TinyMCE's collaboration features, which is why this exists at all.
3. **A validation rule is only half a change.** The other half is whatever makes
   real content satisfy it. Three separate rounds of this project shipped a
   tightened rule on the server with nothing on the client able to meet it, and
   each time ordinary documents became permanently unsavable. If you add a rule
   to `validateDoc`, add the matching repair to `repairDocument` in the same
   change, and a test asserting the two agree.
4. **Never remove somebody's content silently.** If the repair takes something
   out, it reports `removed: true` and the editor says so. A visible refusal is
   better than invisible loss.
5. **No native modules.** Storage is `node:sqlite`, hashing is `node:crypto`.
   The target machine may have no compiler and no network.
6. **The model is the contract.** `packages/model` is shared by the browser and
   the server. Importer, exporter, editor and validator all speak it. A node or
   mark that exists in one and not the others is a document that opens blank.
   `apps/web/test/editor.test.tsx` asserts the vocabularies match.

7. **Preserve by default, edit what we understand.** The Word export patches the
   file that was uploaded: only `word/document.xml`, the comments parts and
   what the writer adds are touched. The reader keeps every node's Word
   identity (style, numbering, raw properties) by reference, and turns what the
   model has no node for into an opaque object. Do not "simplify" the writer
   into building a file from nothing: that is how a letterhead, a chart and a
   corporate style sheet were lost on every export. See `docs/10` section 3.
8. **Comments are not in the text.** They are anchored by quotation, so that a
   comment is never an edit. Do not move them into marks.
9. **The stored JSON is the truth; the shared document is how people reach the
   next one.** Everything reads the snapshot. A room writes it through the same
   repair and validation as any save.

## Conventions

- **Comments say why, not what.** Most comments here record a defect and the
  reasoning that fixed it. Keep that. Do not add comments that restate the code.
- **Test names describe behaviour a person would notice**, not function names:
  `refuses to remove the last active administrator`, not `updateUser works`.
- **A regression test goes in with every fix**, and its comment says what broke.
- **When a test fails, work out which side is wrong before changing either.**
  Several entries in the defect table exist because a test failed and the test
  turned out to be right.
- British spelling in prose. No em dashes.
- TypeScript is strict, ESLint is type-aware. `no-floating-promises` is an error
  on purpose: a promise nobody waits for is how a save quietly does not happen.

## Layout

```
packages/model/        the shared document model, validation and repair
apps/server/src/
  app.ts               Fastify factory, security headers, error handling
  db.ts                schema and migrations (append a migration, never edit one)
  routes/              HTTP, validation of the request, audit entries
  services/            all the real logic: users, sessions, documents, audit, workflow groups
                          (workflow groups are prompt configuration for a future document
                          assistant; no route or service calls a model, see docs/14)
  docx/ooxml/          the Word reader: xml.ts, package.ts, toDocument.ts
  docx/export.ts       the Word writer
apps/web/src/
  components/          the editor, its extensions, the ribbon
  pages/               sign in, documents, editor, administration
  lib/                 the API wrapper and the session provider
scripts/fidelity/      the Word round-trip harness
scripts/make-release.mjs        builds the self-contained kit for every platform
scripts/fetch-node-runtime.mjs  build-time only: downloads and verifies Node from nodejs.org
scripts/licence-policy.mjs      the one place a licence is resolved and checked; shared by
                                   third-party-notices.mjs and generate-sbom.mjs, keep them in step
docs/                  architecture, features, API, security, testing, fidelity
deploy/
  linux/     install.sh (systemd, needs root once), run-standalone.sh (no install, no root),
             preflight.sh, verify-install.sh
  windows/   start-docforge.cmd, double-click, no install
```

## Things that will bite you

- **Tiptap drops what its schema does not declare.** Add an attribute to the
  model and the editor loses it on the first save unless the extension declares
  it too. That is how table shading was lost for a whole round.
- **`editor.setEditable(value)` emits an update by default.** Pass `false` as
  the second argument or every opened document is marked dirty and autosaved.
- **`event.currentTarget` is null after an await.** Read the form first.
- **Sessions are opaque tokens hashed at rest.** Never log one, never return one
  in a response body other than at sign-in.
- **Migrations are append-only.** Existing databases have run the old ones.
