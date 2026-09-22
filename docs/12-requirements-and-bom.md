# Requirements and bill of materials

What to hand a security or infrastructure review before installing DocForge.
There is no `requirements.txt` because there is no Python in this product;
this document, `sbom.cdx.json` (machine-readable) and `THIRD-PARTY-NOTICES.txt`
(human-readable) are the equivalent for a Node.js application distributed as
one compiled file.

## What has to already be on the target machine

**Nothing.** Each release archive under `release/` is complete: the
application, the browser client, and the exact Node.js runtime it needs, all
in one file per platform. Unpack it and run the launcher inside it.

| | Windows laptop | Linux server |
|---|---|---|
| Runtime | Bundled in the archive | Bundled in the archive |
| Install step | None: double-click `start-docforge.cmd` | None: `sh run-standalone.sh`, as any user, no root |
| Optional persistent service | Not applicable (a person starts it when they need it) | `sudo sh install.sh` registers it with systemd, if wanted |
| Administrator rights | Not needed | Not needed for `run-standalone.sh`; needed once for `install.sh` |
| Network access | None, ever | None, ever |
| Other software | None | None |

A reverse proxy (nginx, httpd, or the organisation's own) is optional, needed
only to put TLS in front of it for more than one person on a network; see
`docs/08-enterprise-deployment.md` §7.

## What building a release needs (a different machine, with internet)

This is the machine that produces the archives, not the machine they run on.
It needs internet access once, to download the official Node.js runtime for
each target platform directly from `nodejs.org`, verified against the
checksums Node's own project publishes before anything is used. Building it
again needs:

- Node.js 22.5 or newer and npm (to run the build tools below)
- Access to the public npm registry, or an internal mirror of it, to install
  about 640 packages, most of which are compilers, linters and test runners
  that never leave this machine
- `tar`, `zip`, `unzip` (standard on Linux and macOS)

None of this reaches the target machine. What reaches it is the finished
archive: two files (`server.mjs`, a folder of static web assets) plus the
Node runtime, none of which make a network connection once running — this is
checked automatically on every build (`npm run audit:airgap` and an end-to-end
run that fails if the server opens a socket beyond `127.0.0.1`).

## What is inside the running application

| Layer | What it is | Notes |
|---|---|---|
| Runtime | Node.js (LTS), official build from nodejs.org | Bundled, not installed. `NODE-VERSION.txt` in each release records the exact version and its checksum |
| Storage | `node:sqlite`, built into Node | One file on disk. No database server |
| Web server | Fastify and its own plugins | |
| Document editor | Tiptap, on ProseMirror | |
| Interface | React | |
| Real-time co-editing | Yjs and its WebSocket transport | |
| Word reading and writing | This project's own code, plus `docx` and `fflate` for the zip container | |
| PDF reading | `pdfjs-dist` (the engine behind Firefox's PDF viewer) | |
| PDF writing | `pdfkit` | |
| Spelling | `nspell`, with British and English dictionaries | Loaded only if spelling is switched on |
| Validation | `zod` | |

Everything above is compiled or copied into the two files that ship; nothing
is a separate process, a separate service, or a native binary.

## The full bill of materials

- **`sbom.cdx.json`** (inside each release archive, and regenerable with
  `node scripts/generate-sbom.mjs`): every one of the 203 packages compiled
  into the application, in CycloneDX 1.5 format, the standard a vulnerability
  scanner or software composition analysis tool reads. Each entry carries its
  name, version, licence and a package URL (`purl`) for cross-referencing
  against a vulnerability database.
- **`THIRD-PARTY-NOTICES.txt`** (same archive, or `npm run notices`): the
  same 203 packages, for a person to read, with the licence text each one
  requires to travel with it.

## Licences

| Licence | Packages |
|---|---|
| MIT | 179 |
| ISC | 8 |
| BlueOak-1.0.0 | 6 |
| BSD-3-Clause | 4 |
| Apache-2.0 | 2 |
| SCOWL word list terms (see below) | 2 |
| MIT AND Zlib | 1 |
| 0BSD | 1 |

All permissive. **None is GPL, LGPL or AGPL**, at any depth. A build step
(`npm run notices`) reads every package's declared licence and fails the
release outright if one falls outside this list — a dependency that changes
its licence in a future update stops the release, rather than reaching
anyone.

Two packages (the spelling dictionaries) are not under a standard SPDX
licence identifier. They were read by hand: the SCOWL word lists, permission
to use, copy, modify and distribute for any purpose without fee, with the
notice kept; no copyleft; the same word lists ship inside Firefox. Full text
in `THIRD-PARTY-NOTICES.txt`.

## LibreOffice, and anything else not generic

**LibreOffice is not used anywhere in the running application, in either
direction.** PDF reading and PDF writing are both plain JavaScript, compiled
into the same `server.mjs` as everything else. It appears exactly once in
this whole codebase: a developer's own test-fixture generator
(`scripts/fidelity/wide/make_all.sh`), which builds throwaway sample
documents to test against **on a developer's own machine only**. It is never
invoked by the build, never packaged into a release, and never reaches a
target machine of any kind.

The same is true of every other generic-sounding thing worth naming
explicitly for a review: no Docker, no Python, no Java, no MariaDB or
PostgreSQL, no Redis, no message queue, no telemetry or analytics service, no
CDN reference anywhere in the served pages (checked automatically on every
build), no outbound network call of any kind once the process is running
(checked automatically on every build).

## Proof, not assertion

Everything above was run, not only read from a manifest, on 2026-09-22:

- The Linux x86-64 archive was unpacked and run inside a bare `debian:12-slim`
  container with nothing pre-installed — no Node, no npm — as a non-root
  user, using only `run-standalone.sh`. It created its database, started, and
  answered a real HTTP request.
- The same archive was installed with `sudo sh install.sh` inside a
  systemd-enabled container: it found its own bundled Node runtime, created
  the service account, wrote and registered a systemd unit, and the resulting
  service reported `active (running)` and `enabled` (survives a reboot).
- A deliberately corrupted checksum was used to prove `install.sh` leaves an
  existing installation completely untouched when a check fails partway
  through, rather than partially overwriting it.
- Every file in each archive was independently re-hashed and matched against
  the `SHA256SUMS` it ships with.
- The Windows and Linux ARM64 Node binaries were verified byte-for-byte
  against the checksums `nodejs.org` itself publishes; the Windows binary
  could not be executed on this development machine (a Mac), so it is
  checksum-verified rather than run.

`npm run verify` — lint, type checking, both automated test suites (549 +
232 tests), a production build, the air-gap audit, and a 35-point end-to-end
run against a live instance — passed with no failures on the same date.
