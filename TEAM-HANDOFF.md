# Handing DocForge over to an enterprise team

This is the one document to read before any other. It is written for the
people taking this over — an IT/infrastructure team deploying it on an
air-gapped Windows PC and a Linux server with no Docker and no compiler on
either target, and a development team continuing to build on it. Everything
else in this repository is detail; this file tells you which detail matters
and in what order to read it.

Branch: `enterprise-deploy-kit`. This is the branch to take over from — it is
ahead of `main` and carries everything described below. Do not start from
`main` without first checking whether it has been merged; as of this handover
it has not.

## What DocForge is, in one paragraph

A browser-based word processor, built for organisations that cannot use a
cloud SaaS product for document editing: no data ever leaves the machine it
runs on, there is no telemetry, no CDN, no web font, and the server refuses to
make an outbound network connection at all (this is enforced by an automated
test, not a policy on paper). It reads and writes real Word (`.docx`) files,
keeps a full version history, supports multiple people editing the same
document at once, has accounts and roles, an audit trail, and an optional
AI assistant that only ever talks to a model endpoint on your own private
network, never the public internet. It is MIT licensed end to end, with no
GPL or AGPL dependency anywhere in the tree, which is the whole reason it was
built from nothing rather than adopting an existing editor (OnlyOffice is
AGPL; CKEditor 5 and TinyMCE put collaboration behind GPL or a paid licence).

## Where this stands today

Verified on this machine immediately before this handover was written:

| | |
|---|---|
| Server tests | 643, all passing |
| Client tests | 293, all passing |
| End-to-end smoke checks | 35, all passing |
| `npm run verify` (lint, types, both suites, build, air-gap audit, e2e) | Clean |
| Word round-trip fidelity | Measured against a 40-document corpus now checked into `data/` (see below) |
| Commits on `enterprise-deploy-kit` beyond `main` | 46 |

Everything in the feature table below is built and has test coverage, not
planned. Where a document elsewhere in this repository (`docs/07-roadmap.md`
in particular) describes something below as not yet built, trust this file
and `docs/11-status.md` instead — both are kept current; the roadmap document
is a historical record of the original plan, superseded piece by piece.

| Area | State |
|---|---|
| Accounts, roles, sessions | Built. Administrator/editor/viewer, seed administrator on first start, self-registration closed after that, password reset, disable/enable, session revocation, rate-limited sign-in |
| Documents | Built. Create blank, upload `.docx` or PDF, autosave, rename, delete (soft), search, filter by access |
| Editing | Built. A formatting ribbon (five tabs: Review, Access, Export, AI, History), tables, images, links, headings, lists, the usual character formatting |
| Real-time co-editing | Built. Multiple people in one document at once, with a same-origin WebSocket; degrades to ordinary optimistic-concurrency saves if the network will not carry WebSockets |
| Comments and track changes | Built. Anchored comments, tracked insertions/deletions with accept/reject, a redline comparison view against the original |
| Version history | Built. Every save kept, restorable |
| Sharing | Built. Per-document view/edit grants, ownership transfer, an access-request workflow for someone who wants in |
| Export | Built. `.docx` (as edited, with tracked changes resolved either way, or as a redline Word can accept/reject), PDF, plain text, and a **Standardized export** that applies an administrator-defined house style (header/footer/heading fonts, logo, table borders and shading, table-of-contents styling) regardless of the document's own formatting |
| Audit trail | Built. Every account, document, sharing and export action, readable by an administrator, with names resolved (who did it, and to which document) rather than raw ids |
| AI (optional, opt-in per installation) | Built. Chat and a configurable "Analysis" workflow (a named set of prompts an administrator writes per document type) both call a registered LLM endpoint that **must** be on a private network address — the server refuses a public one outright. Nothing is sent anywhere unless an administrator has explicitly registered an endpoint |
| Administration console | Built. A tabbed console (Users / AI / Export / Audit) rather than one long page |
| Windows desktop use | Built. Double-click to start, no install, no admin rights, no network |
| Linux server deployment | Built. A release archive with the Node runtime bundled in, a systemd installer, a no-install "run now" script, and a preflight checker |

What is **not** built, by decision or not yet: pagination in the editor
(print/PDF export do paginate; the screen shows one continuous page), named
Word styles and numbering definitions (flattened to direct formatting on
import), editing inside a text box, single sign-on, and clustering (storage
is one SQLite file, so one server instance). See `docs/11-status.md` for the
full, current list.

## Deploying it — the actual instructions

Both target environments are air-gapped, have no Docker, and have no
compiler. This is exactly the case the release process was built for: **you
compile once, on a separate machine that has internet or a package mirror,
and carry the result across by hand.** Nothing is compiled, downloaded or
installed on either target machine.

### The build machine (needs network, once, to produce the release)

```sh
git clone https://github.com/algowizzzz/enterpriseOffice.git
cd enterpriseOffice
git checkout enterprise-deploy-kit
node -v                     # must print v22.5.0 or newer
npm ci                      # exact versions from package-lock.json
npm run verify              # ~40 seconds; everything must pass before shipping
npm run release             # writes release/docforge-<version>-<date>-<commit>-<platform>.tar.gz or .zip
```

This one command produces a self-contained kit for Linux x64, Linux arm64
**and** Windows x64, each with its own copy of the Node.js runtime already
inside it (downloaded once from nodejs.org and checksum-verified — the only
point in this whole process where the network is used, and it is this build
machine, never a target). Building only one platform:
`npm run release -- --platform linux-x64`.

If this build machine sits behind an internal npm mirror rather than the
public registry: `npm config set registry https://<your-mirror>/` before
`npm ci`. If `nodejs.org` itself is unreachable from the build machine, place
an already-obtained, approved Node 22.5+ binary under
`.cache/node-runtimes/v<version>-<platform>/` in the layout
`scripts/fetch-node-runtime.mjs` expects (`docs/08-enterprise-deployment.md`
§3 has the exact path). Full detail on both, and on what to do if the mirror
is missing a package: `docs/08-enterprise-deployment.md` §3.

### Carrying it across

Copy exactly one file per target: the matching release archive
(`docforge-*-linux-x64.tar.gz` or `docforge-*-windows-x64.zip`) and its
`.sha256` file. On the target, verify the checksum before doing anything else
— `docs/08-enterprise-deployment.md` §4 has the exact commands for both
platforms (PowerShell's `Get-FileHash` on Windows, since there is no
`sha256sum` there by default).

### The Windows PC (no install, no admin rights, no network, ever)

Unpack the archive. Double-click `start-docforge.cmd`. That is the entire
install. **Full walkthrough for the person actually running it, written for
someone with no technical background: `docs/13-windows-quickstart.md`** — it
covers setting the first administrator's password, where the database lives
(`%LOCALAPPDATA%\DocForge\docforge.db`), everyday use, and what to do if the
port is already taken. Hand that document to the end user directly; it needs
nothing else.

### The Linux server (no Docker, works on RHEL/Rocky/Alma/Oracle 8+,
### Ubuntu 20.04+, Debian 10+, or SLES 15 SP3+ — anything with glibc 2.28+)

```sh
tar -xzf docforge-*-linux-x64.tar.gz && cd docforge-*/
sh preflight.sh              # checks the machine, no root, changes nothing
sh run-standalone.sh         # try it now, any user, foreground, Ctrl+C to stop
# or, for a persistent service that survives a reboot (root once):
sudo sh install.sh
sudoedit /etc/docforge/docforge.env      # set DOCFORGE_ADMIN_PASSWORD, first start only
sudo systemctl enable --now docforge
sh verify-install.sh
```

**The full guide, and it is thorough — read it before the first real
install: `docs/08-enterprise-deployment.md`.** It covers, in order: exactly
what is being deployed and why nothing on the target needs installing;
putting TLS in front with nginx or Apache (including the WebSocket rule
real-time co-editing needs, and what happens if the network cannot carry
WebSockets at all — nothing breaks, it falls back automatically); accounts;
backup and restore (one SQLite file); upgrade and rollback; monitoring
(`/api/health`, structured JSON logs to the systemd journal); a full
troubleshooting table keyed by symptom; and a section written specifically
for a security or licence reviewer (data at rest, sandboxing, upload limits,
the full dependency licence list). Do not re-derive any of this by hand —
every command in that document is exactly what the installer runs, this
handoff file is only the summary.

### Verifying either install actually works

`deploy/README.md`'s "Verify an install" section is five `curl` commands that
prove: the service answers, the client is served (not just the API), the
seed administrator can sign in, a document can be created and exported as a
genuine Word file (checked by its zip magic bytes), and nothing was left
behind. Run it on every fresh install before calling it done.

### Trying the organisation's own documents before a rollout

```sh
npm run try -- --keep roundtrip/ /path/to/some/real/documents
```
On the build machine, before shipping. Starts a private, temporary copy of
the server, round-trips every `.docx` it is given, and reports per feature
what survived and what the document contained that the editor cannot yet
represent (so nobody discovers a gap from an angry reviewer). Nothing leaves
the machine. `docs/08-enterprise-deployment.md` §13 has the detail; the same
tool underlies the 40-document corpus in `data/` (below).

## The knowledge base: everything in the codebase, and where to read about it

Seventeen documents already exist under `docs/`, each with a specific job.
Read them in this order — this is also the order `HANDOVER.md` (written for
a development agent picking this up, complementary to this file) recommends:

1. **`CLAUDE.md`** — the rules that are not negotiable when changing this
   codebase: no compiled dependency, no CDN, no npm at the target, PostgreSQL
   is irrelevant here (this project uses SQLite, not PostgreSQL — do not
   confuse it with the sibling Consilium project if your organisation runs
   both), and the testing/documentation conventions this whole tree follows.
2. **`docs/01-architecture.md`** — why every piece is what it is: the licence
   analysis behind picking ProseMirror/Tiptap over the AGPL/GPL alternatives,
   the two architectures that were considered, the full dependency stack, and
   a system diagram.
3. **`docs/05-testing.md`** — the five testing layers (server suite, client
   suite, a real-browser walkthrough, the end-to-end smoke test, and the Word
   fidelity harness) and a defect table: real bugs six adversarial review
   rounds found, several of them the same mistake recurring. Worth reading
   before touching the document model.
4. **`docs/06-fidelity.md`** — precisely what survives a Word round trip and
   what does not, measured, not asserted.
5. **`docs/04-security.md`** — trust boundaries and controls, before touching
   authentication, sessions or uploads.
6. **`docs/03-api-reference.md`** — every HTTP endpoint, its error shape,
   which role can call it, and its limits.
7. **`docs/08-enterprise-deployment.md`** and **`docs/13-windows-quickstart.md`**
   — deployment, covered above.
8. **`docs/09-requirements-fit.md`**, **`docs/10-product-requirements.md`**,
   **`docs/11-status.md`** — what the product has to be, in what order it was
   built, and exactly where it stands against that today. Read `11` first of
   the three; it supersedes the other two's build ordering.
9. **`docs/12-requirements-and-bom.md`** — the plain-language requirements
   list and full bill of materials, written to hand directly to a security or
   infrastructure review.
10. **`docs/14-word-like-shell.md`**, **`docs/15-enterprise-redesign.md`** —
    what "make it look like Word" and "make it look enterprise-grade" broke
    down into, and which parts of each are built (most of both, by now — see
    the feature table above and `docs/11-status.md`).
11. **`docs/16-ai-integration.md`** — the AI feature end to end: why it is
    safe in an air-gapped context (private-network-only endpoints, no
    per-document opt-out, no exception process, all decided and built, not
    open questions any more), and the five build phases.
12. **`docs/17-standardized-export.md`** — the administrator-configurable
    house-style export, built in four phases, all complete: header/footer/
    heading fonts, a footer logo, table borders and shading, and
    table-of-contents styling.
13. **`docs/02-feature-matrix.md`**, **`docs/07-roadmap.md`** — historical.
    The feature matrix maps every Word/OnlyOffice ribbon feature to how it
    was built here; the roadmap is the original build order, almost entirely
    superseded (see the "cleanup" section below).

### The repository itself, tour by directory

```
packages/model/         The shared document model: node/mark vocabulary, validation,
                         repair, word count, outline. Used by both the client and
                         the server so an editor extension cannot exist without the
                         server also learning its shape (packages/model/src/index.ts,
                         changes.ts).
apps/server/src/
  app.ts                 Fastify app factory: security headers, CORS, error handling
  db.ts                  Schema and the append-only migrations list
  config.ts              Every environment variable, in one place
  routes/                One file per resource: auth, documents, comments, access
                          requests, collaboration, users, LLM endpoints, workflow
                          groups, the export template, word-count helpers
  services/               The actual logic behind each route: documents, comments,
                          access requests, sessions, users, the audit trail, chat,
                          chat settings, workflow groups, LLM endpoints, the export
                          template, media (pictures over a size threshold)
  docx/                   The Word reader and writer (OOXML parsing, `toDocument`,
                          the one shared `write.ts` every export path uses),
                          plus PDF reading/writing (pdf/) and standardized-export's
                          own seed-template builder (standardTemplate.ts)
  collab/                 The real-time collaboration layer (Yjs-based)
  lib/                    Small shared helpers (ids, etc.)
apps/web/src/
  pages/                  SignInPage, DocumentsPage, EditorPage, AdminPage — the
                          whole application is four pages
  components/             DocumentEditor (the Tiptap-based editor itself), Toolbar
                          (the formatting ribbon), ReviewPanel, CommentsPanel,
                          AiPanel/ChatPanel/AnalysisPanel, NavigationPane, FindBar,
                          RowMenu, and the editor extensions (spellcheck, track
                          changes, heading numbers, search/replace, word navigation)
  lib/                    The API client (api.ts, one function per endpoint and
                          every response type), the session provider
  styles/                 One stylesheet, design tokens as CSS custom properties,
                          a switchable light/dark theme
scripts/                  Build (bundle-server.mjs, make-release.mjs), the two
                          air-gap enforcement checks (check-no-remote-urls.mjs,
                          no-outbound-preload.mjs), the Node runtime fetcher, the
                          licence policy and third-party-notices/SBOM generators,
                          the end-to-end smoke test, the fidelity harness
                          (scripts/fidelity/), and seed-library.mjs (loads the test
                          corpus into a running instance to browse)
data/                     The Word-fidelity test corpus: 4 hand-built, feature-dense
                          documents plus 2 LibreOffice-rendered ones (test-docs/),
                          and 36 more spanning three independent producers
                          (LibreOffice, python-docx, and a Mac word processor's
                          RTF/HTML export) under wide-corpus/, used by
                          scripts/fidelity/run.mjs and npm run try. Checked into
                          the repository as of this handover (see below); a local
                          server's own runtime database, secrets and logs, and the
                          corpus's own regenerated round-trip output, are not —
                          see .gitignore.
deploy/                   Linux installer scripts, the systemd unit, the Windows
                          start script, and an optional Dockerfile (not needed for
                          either target environment in this handover, but present
                          if some other deployment ever wants it)
```

## Keeping it working: the testing discipline

`npm run verify` is the one command that must pass before any change ships.
It runs lint, both TypeScript projects, both test suites, the production
build, the air-gap audit (fails the build if the browser bundle references
a remote URL), and the end-to-end smoke test (fails if the running server
opens a socket beyond loopback). It takes about 40 seconds and needs no
network access to run.

The one rule that has caused the most real damage, twice, per `HANDOVER.md`:
**a validation rule is only half a change.** If a rule is tightened on the
server, ordinary existing content has to be repairable to satisfy it, or an
existing document becomes permanently unsavable with no visible reason. If
you touch `validateDoc` in `packages/model/src/index.ts`, touch
`repairDocument` in the same change, and keep the property test that asserts
the two agree.

## Cleanup and known technical debt — read this before assuming anything is stale

A deliberate pass was made before this handover to find genuine cruft: there
is none of the usual kind. No `TODO`/`FIXME` markers, no stray debug
`console.log`, no committed `.DS_Store`, no secrets or generated files ever
accidentally committed. The codebase is, as of this handover, clean in that
sense. What is worth the new team's attention instead:

1. **`README.md`'s numbers are stale.** It quotes older test counts (380/187)
   and describes real-time co-editing as "designed but not built," which was
   true when it was written and has not been since. `HANDOVER.md` and this
   file have the current numbers; update `README.md` to match, or point it at
   whichever of the two documents your team keeps current, rather than
   maintaining three sources of truth.
2. **`docs/07-roadmap.md` is superseded, not wrong.** It was the original
   build order; nearly everything on it has since shipped in a different
   order than it lists. `docs/11-status.md` is the live source of truth for
   what exists. Read `07` for the reasoning behind early decisions, never for
   what to build next.
3. **`node:sqlite` is a release candidate, not yet a stable Node API.** The
   storage layer is narrow and sits behind one module
   (`apps/server/src/db.ts`), specifically so that moving to
   `better-sqlite3` or PostgreSQL later is a contained change if Node's own
   API ever moves under it. Worth a periodic check against whatever Node LTS
   line is bundled in the release your team builds (`NODE-VERSION.txt` inside
   every release archive records exactly which one, and its checksum).
4. **No clustering.** Storage is one SQLite file, so this is one server
   instance per deployment. Fine for a team; not a multi-region design. If
   that ever needs to change, it is a storage-layer change, not an
   application-architecture one, for the same reason as above.
5. **The AI feature is opt-in per installation, and stays that way by
   design** (`docs/16-ai-integration.md` §7, §12) — it will not silently
   start making outbound calls just because an endpoint exists somewhere on
   the network; an administrator has to register one explicitly, and the
   server refuses anything that is not a private-network address. Worth a
   periodic reminder to whoever owns security review that this is a decision,
   re-confirmed, not a gap being tracked.
6. **`scripts/fidelity/wide/make_all.sh`** is the one place LibreOffice
   appears anywhere in this repository, and it runs on a developer's own
   machine to regenerate part of the `data/wide-corpus/` test fixtures. It is
   never invoked by `npm run release`, `npm run verify`, or anything that
   ships. Do not let it become a dependency of anything that runs on a target
   machine — this is a `CLAUDE.md` invariant, not a suggestion.
None of the above blocks a deployment. They are the honest list of what a
new team should look at first, not defects found on inspection.

## First week checklist for the new team

1. Clone `enterprise-deploy-kit`, run `npm ci && npm run verify`, confirm it
   is green on your own machine before changing anything.
2. Read this file, then `HANDOVER.md`, then `CLAUDE.md`.
3. Do one real build-and-deploy rehearsal end to end on a machine that
   matches your actual Windows and Linux targets as closely as possible,
   including the checksum verification and the five-command install check in
   `deploy/README.md` — before it matters that it works.
4. Read `docs/04-security.md` and `docs/12-requirements-and-bom.md` and hand
   both to whoever owns security/compliance sign-off; they were written for
   exactly that reader.
5. Decide who owns the "cleanup" list above, and whether to fold `README.md`
   and `HANDOVER.md` into whatever your team's own operating rhythm expects,
   rather than leaving both authored by a departed hand.
6. If continuing development with an AI coding agent, `HANDOVER.md`'s
   "How to hand the work to a local agent" section is a ready-made prompt;
   if with a human team, `CONTRIBUTING.md` has the setup and the same
   non-negotiable rules restated for a person rather than an agent.

## Support

There is no vendor and no support contract: this is source code, handed
over. Everything needed to operate, extend, audit or replace any part of it
is either in this repository or named explicitly where it is not (Node.js,
from nodejs.org, is the one external thing the build process reaches for,
and only at build time). `docs/08-enterprise-deployment.md`'s "What to send
back" section (§14) is written for exactly the situation of one team member
asking another for help with an install — use that shape internally too.
