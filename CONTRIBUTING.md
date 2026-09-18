# Contributing

## Getting set up

Node 22 or newer. Nothing else.

```
npm ci
npm run verify
DOCFORGE_ADMIN_PASSWORD='Choose-A-Strong-One-1' npm start
```

For day-to-day work run the two sides separately, so both reload on change:

```
npm run dev:server     # http://127.0.0.1:8080
npm run dev:web        # http://127.0.0.1:5173, proxies the API
```

## Before you push

`npm run verify` must pass. It typechecks, runs both suites, builds, audits the
browser bundle for remote URLs and drives the built server end to end.

If you touched the editor or any page, run the browser walkthrough too. Several
layout and keyboard problems have only ever been caught there.

```
npm install --no-save playwright
node scripts/ui-walkthrough.mjs
```

## The rules that are not negotiable

**Nothing may be fetched at run time.** No CDN, no web fonts, no telemetry, no
update check. A dependency that phones home cannot be used, whatever it offers.
Both air-gap checks exist to catch this and neither may be weakened to make a
build pass.

**Only permissive licences.** MIT, BSD, Apache-2.0, ISC, MPL-2.0 at file level,
and SIL OFL for fonts. No GPL, LGPL or AGPL in the bundle. A GPL tool may be run
as a separate process, which is how LibreOffice is used for format conversion,
but its code may not be linked in. Check the licence before adding a dependency,
not after.

**No native modules.** The target machine may have no compiler and no network.
This is why the database is Node's own SQLite and passwords use scrypt from the
standard library.

**The server never trusts the client.** Every rule that matters is enforced
again on the server. The editor enforcing something is a convenience for the
person using it, not a control.

**The editor and the server share one vocabulary.** Adding an extension to the
editor means teaching `packages/model` about its nodes and marks, or the server
will refuse to save documents that use it. The client suite fails if you forget.

## Writing code

Match the surrounding style; there is no separate style guide to consult.

Comment why, not what. A comment earns its place when it records a decision, a
constraint or a trap somebody would otherwise fall into again. Several comments
in this codebase name the bug that made the line necessary, which is exactly the
kind worth writing.

Keep messages to the person readable. "This document was changed by someone
else. Reload before saving." rather than a status code.

## Writing tests

See `docs/05-testing.md` for the layers and conventions. In short: name the
behaviour rather than the function, assert what a person would notice, and when
a test fails work out which side is wrong before changing either.

A new endpoint needs tests for the happy path, the refusal, and who is not
allowed to call it. A new editor control needs a test that its output still
passes the server's validator.

## Commits

Explain what changed and why it needed changing. When a change fixes something
that testing found, say what the defect actually did to a person using the
product; that is the part worth remembering a year later.

## Where things live

```
packages/model/   Node and mark vocabulary, validation, helpers. Pure TypeScript.
apps/server/      Fastify API, SQLite storage, docx import and export.
apps/web/         React client, Tiptap editor, ribbon.
scripts/          Build, air-gap audit, outbound probe, smoke test, walkthrough.
deploy/           Docker, systemd, Windows.
docs/             Architecture, feature matrix, API, security, testing.
```

The model package is shared on purpose. Put anything both sides must agree on
there, and nothing else.

## What to work on next

`docs/01-architecture.md` has the phased plan and `docs/02-feature-matrix.md`
tags every Word feature as out-of-box, config or custom. The two largest pieces
still ahead are the page layout engine, which unlocks most of the Layout and
Design tabs, and the project's own OOXML codec, which is what makes a round trip
lossless. Both are described there.
