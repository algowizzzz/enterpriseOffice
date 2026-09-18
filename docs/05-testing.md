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
| Server | 420 | 97% | 89% |
| Client | 185 | 96% | 84% |
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
| `failure-paths.test.ts` | Internal errors, upload limits, re-enabling an account, service edge cases |
| `security-hardening.test.ts` | Entity decoding, forwarded addresses, rate-limit evasion |
| `attribute-validation.test.ts` | Every attribute value that reaches the Word serializer |
| `hardening.test.ts` | The registration race, nesting depth, upload and password limits |
| `docx-fidelity.test.ts` | Nested tables, blocks inside quotes, image sizing, spans |
| `zip-guard.test.ts` | What an uploaded archive declares it expands to |
| `second-review.test.ts` | The defects a second review found, including one the first round introduced |
| `sanitize.test.ts` | That the repair fixes everything the rules refuse |

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
| `paste-safety.test.tsx` | That nothing pasted can produce a document which cannot be saved |
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
| 1 to 5 | 420 server, 185 client, 29 end-to-end, no unhandled errors, no lint findings | about 40 seconds each |

Two things keep it that way. Each server test gets its own in-memory database,
so no test can depend on another having run first. And an unhandled promise
rejection anywhere fails the run rather than printing a warning, which is how
the failed sign out in the table below was caught.

## What testing has found

Worth recording, because it says what these layers are for.

| Defect | Found by |
|---|---|
| Sign-in rate limiting could be bypassed and audit addresses forged, because a forwarded header was trusted with no proxy in front | Adversarial review |
| Importing silently corrupted text: entity decoding ran in passes, so a literal `&lt;` became `<` | Adversarial review |
| A numeric character reference outside the Unicode range crashed the import with an opaque server error | Adversarial review |
| The editor could get permanently stuck and stop saving after two of your own writes overlapped | Adversarial review |
| Autosave destroyed the whole version history, the as-imported original included, in about a minute | Adversarial review |
| A table inside a table imported with its rows doubled | Adversarial review |
| A list or table inside a quote flattened into one run-on paragraph | Adversarial review |
| Every image was written back at a fixed size, resizing and distorting all of them | Adversarial review |
| Two registrations arriving together could both become administrators | Adversarial review |
| Attribute values were never checked, so anything could reach the Word serializer | Adversarial review |
| The fix for that then rejected images pasted from a web page, making a document permanently unsavable | Second review |
| The editor still claimed everything was saved while keystrokes were pending, and the unload warning was keyed on the same state | Second review |
| Restoring a version while a save was in flight let the stale answer undo the restore | Second review |
| Exporting was unlimited although it costs as much as importing, which is limited | Second review |
| Two administrators adding the same address got a server error rather than a conflict | Second review |
| Changing your own password signed you out as well as your other devices | Second review |
| The fix for that then rejected pasted remote images, stranding documents the same way again | Third review |
| An edit made after restoring a version could be left unsent while the badge claimed it was saved | Third review |
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
| The repair for that emptied a document whose only content it had to remove, so it opened blank and the first save wrote the blankness back | Fourth review |
| A stored document whose content or marks were not a list threw out of the editor's start-up and took the whole page down | Fourth review |
| The repair could discard the very attribute a node cannot do without, making it unrepairable | Fourth review |
| The repair left a non-document root and a text node's children in place, both of which the rules refuse | Fourth review |
| A document past the node limit was repaired into an identical one, still too large to save | Fourth review |
| Content was removed on the way in and out with nothing said about it | Fourth review |
| Two documents created in the same millisecond shared a timestamp, so the list ordered them arbitrarily | Server suite |
| The new message became a permanent banner after pasting a telephone or relative link, pointing at a link still visible on screen that was silently dropped from every save | Fifth review |
| Restoring a version was the one write path with no repair, so tightening a rule made an old version impossible to restore for ever | Fifth review |
| A document holding a page break opened completely blank, because the model had a node the editor did not | Fifth review |
| The repair deleted empty tables and lists that the rules accepted, then reported content as lost | Fifth review |
| The message claimed content had been left out when the repair had only filled an empty quote | Fifth review |
| The repair stopped one level shallower than the rules, and did not count the paragraphs it added against the node budget | Fifth review |
| An imported list item holding only a nested list was a shape the editor's schema does not allow | Fifth review |

## Review

Tests find the defects you thought to look for. A reading of the code by
somebody trying to break it finds the ones you did not, and the table above is
mostly that. Each finding was reproduced before anything was changed, and
several turned out to be worth less than they first looked; the ones that
survived are all in the table, each with a regression test beside the fix.

Two of them are worth singling out, because both were invisible to every layer
of testing. The rate-limit bypass needed somebody to ask what happens when the
header the limiter keys on is supplied by the attacker. The stuck editor needed
somebody to trace what the revision does after a save fails, which no test
exercised because no test made two saves overlap.

A second pass was run afterwards, asked specifically whether the fixes had
introduced anything. It had: the new attribute rules rejected images pasted from
a web page, which made a document permanently unsavable from the moment somebody
pasted one. That is the ordinary cost of a change made under a security
argument, and the reason for looking again rather than assuming a fix is free.
The same pass also found that a comment written in the first round claimed a
save-state problem was fixed when it was not.

A third pass found the second round had done it again, for the same reason: a
rule was tightened on the server with nothing on the client able to satisfy it.
Checking properly showed six of seven ordinary paste cases produced a document
that could never be saved. Patching each would only have set up the next one, so
the rules and the repair now live together and the editor repairs what it is
given and what it hands over. One test asserts the two agree, and found a place
where they did not the moment it was written.

A fourth pass read the repair itself, and found five ways it could produce a
document the rules still refuse or the editor shows as blank. The worst was the
plainest: a document whose only content had to be removed came back with no
content at all, which ProseMirror builds without complaint, so the person saw an
empty page and the first autosave stored it. The repair now fills anything that
cannot be empty, drops containers that mean nothing when empty, forces a
document root, keeps required attributes first, holds to the same node budget as
the checker, and recovers the words when a value is too malformed to walk. Two
properties are asserted against five hundred generated documents rather than
case by case: whatever goes in, the repair returns without throwing and its
output satisfies the rules, and a second repair changes nothing. The same pass
noted that removing content silently is worse than the refusal it replaced, so
the editor now says when something was left out.

A fifth pass read the repair again and cleared it: twenty thousand generated
values, and nothing it returned was refused. The damage had moved to the message
beside it. A pasted telephone or relative link is kept by the editor and stripped
by the model, so the repair reported a removal on every autosave: an amber banner
after every keystroke, about a link the person could still see. The rule now
lives in one place and the editor refuses those targets as they arrive. The same
pass found the one write path with no repair in front of it, restore-from-version,
where a tightened rule made an old version permanently unrestorable, and a node
the model knew that the editor did not, which made any document holding a page
break open blank. The message is now keyed on something being taken away rather
than on anything changing, which it was not before.

The lesson is worth stating plainly, because it took three rounds to learn:
a validation rule is only half a change. The other half is the thing that makes
content satisfy it. A rule shipped without that half does not reject bad
documents, it rejects people's work.

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
