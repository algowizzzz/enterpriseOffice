# Testing

Four layers, all runnable offline. `npm run verify` runs the first three in
order and is what must pass before anything ships.

```
npm run verify
```

| Step | What it does |
|---|---|
| `typecheck` | TypeScript across the server and the client |
| `test` | Server and client suites |
| `build` | Browser bundle, then the single-file server bundle |
| `audit:airgap` | Fails on an unreviewed remote URL in the browser bundle |
| `test:e2e` | Drives the built server over HTTP with an outbound probe attached |

Current state:

| Suite | Tests | Statements | Branches |
|---|---|---|---|
| Server | 272 | 96% | 87% |
| Client | 147 | 96% | 83% |
| End to end | 29 checks | n/a | n/a |

Coverage numbers come from `npx vitest run --coverage` in either workspace.

## Server suite

`apps/server/test`. Fastify in-process injection against a fresh in-memory
database per test, so tests share no state and run in any order.

| File | Covers |
|---|---|
| `auth.test.ts` | Sign in and out, session lifetime, password change, timing equality |
| `users.test.ts` | Account creation, roles, the last-administrator rule, audit visibility |
| `documents.test.ts` | Access control, optimistic concurrency, versions, sharing |
| `documents-advanced.test.ts` | Rename, limits, version retention, export naming, audit paging |
| `app.test.ts` | Wiring, security headers, rate limiting, seed administrator, static client |
| `db.test.ts` | Migrations, constraints, transaction rollback |
| `config.test.ts` | Environment parsing and defaults |
| `docx.test.ts` | Export and import through the portal |
| `docx-roundtrip.test.ts` | Structure, formatting and images through a full round trip |
| `html-mapping.test.ts` | The HTML to model mapping, including hostile input |
| `mammoth-options.test.ts` | The style map and alignment transform |
| `model.test.ts` | Document model helpers and password hashing |
| `validation.test.ts` | Email rules and the seed administrator |
| `robustness.test.ts` | Large documents, non-Latin scripts, deep nesting, two people editing at once |

### Robustness

`robustness.test.ts` is deliberately unlike the others. It uses documents the
size a real report reaches rather than three-line fixtures, and content that
breaks naive implementations: right-to-left Urdu and Arabic, Chinese, emoji
outside the basic plane, combining accents, the characters that matter in XML,
a five-thousand-character unbroken word, and mixed direction in one line.

It also covers two people editing the same document: the first save wins, the
second is refused rather than silently discarding the first, and the refused
writer succeeds once they have caught up. Both authors appear in the history.

## Client suite

`apps/web/test`. React Testing Library in jsdom. The server module is replaced,
so the pages are exercised without a network.

| File | Covers |
|---|---|
| `api.test.ts` | The fetch wrapper: methods, headers, error shapes, downloads |
| `session.test.tsx` | The session provider and the router |
| `pages.test.tsx` | Sign in, documents, editor and administration pages |
| `toolbar.test.tsx` | Every ribbon control |
| `editor.test.tsx` | The editing surface, autosave, counts, shortcuts |

One rule is worth keeping: several client tests assert that what the editor
produces passes `validateDoc`, the same function the server applies on save. An
extension added to the editor without teaching the server about it fails the
client suite, rather than failing in production on somebody's document.

## End-to-end smoke test

`scripts/smoke-test.mjs` starts the bundled server as a separate process and
drives it over HTTP with a cookie jar, the way a browser would. It covers the
whole journey: seed the administrator, create an account, start a document,
type, save, refuse a stale save, export `.docx`, upload that file back, confirm
the heading, bullet and bold survived, check access control, read the version
history, load the client, and sign out.

It also asserts that the server opened no connection beyond loopback, using
`scripts/no-outbound-preload.mjs`.

```
npm run build && npm run test:e2e
```

## Browser walkthrough

`scripts/ui-walkthrough.mjs` drives the built portal in real Chromium and writes
a screenshot of each screen. It is not part of `verify`, because it needs
Playwright and a browser that the shipped build deliberately does not carry.

```
npm run build
npm install --no-save playwright
node scripts/ui-walkthrough.mjs
```

`DOCFORGE_CHROMIUM` points at a browser elsewhere; `DOCFORGE_SHOT_DIR` chooses
where the images go.

It also watches every request the page makes and fails if any address other
than its own origin is asked for, whatever asked for it: our code, a dependency,
or a document somebody uploaded. Like the server probe, this was checked against
a page that deliberately loads a remote image, so it cannot pass vacuously.

This layer earns its place. It caught the editor header scrolling out of view
and a missing `Ctrl+End` binding, neither of which any assertion had noticed.

## Stability

A suite that fails now and then is worse than no suite, because people learn to
re-run it rather than read it. The whole pipeline is run five times in a row
before any claim about it is made.

| Run | Result | Time |
|---|---|---|
| 1 to 5 | 272 server, 147 client, 29 end-to-end, no unhandled errors | about 28 seconds each |

Two things keep it that way. Each server test gets its own in-memory database,
so no test can depend on another having run first. And an unhandled promise
rejection anywhere fails the run rather than printing a warning, which is how
the failed sign out in the table below was caught.

## What testing has found

Worth recording, because it says what these layers are for.

| Defect | Found by |
|---|---|
| The seed administrator could never sign in, because the email rule rejected a single-label domain | End-to-end smoke test |
| Sign out was broken: the client declared a JSON body on a request that had none | End-to-end smoke test |
| Opening a document marked it dirty and saved a phantom revision | Client suite |
| Word counts read zero until something changed | Client suite |
| The ribbon never refreshed its pressed and enabled states | Client suite |
| Creating an account reported failure while having succeeded | Client suite |
| A failed sign out escaped as an unhandled rejection | Client suite |
| Underline and alignment were lost on every round trip | Server suite |
| Centred headings lost their centring | Server suite |
| The editor header scrolled out of view; `Ctrl+End` did nothing | Browser walkthrough |

## Conventions

**Name the behaviour, not the function.** `refuses to remove the last active
administrator` rather than `updateUser works`.

**Assert what a person would notice.** Prefer a role or a label over a class
name, so a rewrite of the markup does not break a test that still holds.

**A test that needed a fixture contorted into an unnatural shape is usually
pointing at a seam that belongs in the code.** The HTML mapping was extracted
from the importer for exactly that reason: the branches that decide what happens
to hostile input could not be reached from any `.docx` fixture.

**When a test fails, work out which side is wrong before changing either.**
Several entries in the table above were found because a test failed and the
test turned out to be right.
