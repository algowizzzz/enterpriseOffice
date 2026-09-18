# Handover

Everything a new session needs to pick this up. Written for an agent working on
a Mac with Claude Code, and for the person reading over its shoulder.

## What this is

DocForge is a browser-based word processor for air-gapped deployment: a Linux
server for a team, or one laptop running the same stack locally. It carries
accounts and roles, per-document sharing, version history and an audit trail,
and it reads and writes Word files.

It was built from nothing in this repository. There is no upstream, no fork and
no proprietary dependency. Every licence in the tree is MIT, BSD, Apache-2.0,
ISC, MPL-2.0 or SIL OFL, which is the reason it exists: OnlyOffice is AGPL, and
CKEditor 5 and TinyMCE put collaboration behind GPL or a commercial licence.

## Getting it running on a Mac

Node 22.5 or newer is required. The storage layer uses Node's built-in SQLite,
which does not exist in Node 20, and there is no native module to fall back on.

```sh
git clone https://github.com/algowizzzz/enterpriseOffice.git
cd enterpriseOffice
node -v                 # must be v22.5 or newer
npm ci
npm run verify          # about 40 seconds: everything must pass before you change anything
DOCFORGE_ADMIN_PASSWORD='Choose-A-Strong-One-1' npm run build
DOCFORGE_ADMIN_PASSWORD='Choose-A-Strong-One-1' npm start
```

Open `http://127.0.0.1:8080` and sign in as `admin@localhost` with that
password. The database lands in `./data/docforge.db`; delete it to start over.

For development, `npm run dev` runs the API on 8080 and the client on 5173 with
reload. If `npm run verify` fails on a clean clone, stop and fix that first:
everything below assumes it passes.

## Where it stands

| | |
|---|---|
| Commits | 38, all on `main` |
| Server tests | 380 |
| Client tests | 187 |
| End-to-end checks | 29 |
| Word round-trip fidelity | 1260 of 1260 measured items, across 50 documents |
| Verify runs clean | Five consecutive, repeatedly |

Six adversarial review rounds have been run against the code, each one reading
the previous round's fix. The defect table in `docs/05-testing.md` lists what
they found; it is worth reading before changing the document model, because
four of the six rounds found a variant of the same mistake.

## The one lesson worth carrying forward

Three consecutive rounds shipped a tightened validation rule on the server with
nothing on the client able to satisfy it. Each time, an ordinary document, one
with a pasted image or a percentage width or a telephone link, became impossible
to save, for ever, with nothing on screen to say which element was at fault.

So: **a validation rule is only half a change.** The other half is whatever
makes real content satisfy it. `validateDoc` and `repairDocument` in
`packages/model/src/index.ts` are two halves of one thing, and a property test
asserts that whatever goes into the repair comes out passing the rules.

The fourth round found the repair itself could empty a document rather than
refuse it, which is worse: a refusal is visible, silent loss is not. Hence the
`removed` flag and the message in the editor.

## Reading order

1. `CLAUDE.md` for how to work here: commands, invariants, conventions.
2. `docs/01-architecture.md` for why each piece is what it is, and the licence
   analysis behind every dependency.
3. `docs/05-testing.md` for the five testing layers and the defect table.
4. `docs/06-fidelity.md` for what survives a Word round trip, and what does not.
5. `docs/04-security.md` before touching authentication, sessions or uploads.
6. `docs/03-api-reference.md` when adding or changing an endpoint.
7. `docs/07-roadmap.md` for the open work, ranked, with the reasoning.
8. `docs/08-enterprise-deployment.md` for installing on an air-gapped Linux server.
10. `docs/10-product-requirements.md` for what the product has to be, its scope and
    its build order. It replaces the order in 07 and 09.
11. `docs/11-status.md` for where the build stands against it: done, partial, not
    built, and what to expect of PDF. **Read this one first.**
9. `docs/09-requirements-fit.md` for where the build stands against an enterprise
   policy workflow. Its build order replaces the roadmap's where they differ.

## What to do next

`docs/07-roadmap.md` has the detail. In short, ranked by value against effort:

1. **Real-time co-editing.** The one headline feature designed but not built.
   The model and storage were chosen so a CRDT layer drops in. Two to three
   weeks.
2. **Named styles and numbering definitions.** The largest remaining fidelity
   gap: a document's own styles are flattened into direct formatting.
3. **Print and PDF export.** The print stylesheet exists; pagination does not.
4. **Find and replace**, which every word processor has and this does not.
5. **Footnotes, comments and tracked changes**, in that order.

Do not start any of them by widening the model without reading
`CLAUDE.md`'s invariants. Each one needs the editor, the reader, the writer and
the validator moved together.

## How to hand the work to a local agent

Start Claude Code in the clone and give it something like this:

> Read `HANDOVER.md` and `CLAUDE.md`, then `docs/07-roadmap.md`. Run
> `npm run verify` to confirm the tree is green before you change anything.
> Then take on the first roadmap item. Keep `npm run verify` passing, add a
> regression test with every fix, and run the fidelity harness before and after
> anything that touches the Word reader or writer.

Point it at one roadmap item at a time. The work that went badly in this
project's history was always the work that changed a rule in one place and
nothing else.

## What is deliberately not here

- No real-time collaboration yet, only single-writer editing with optimistic
  concurrency and version history.
- No pagination: the editor shows one continuous page.
- Named styles, numbering definitions, fields, footnotes, comments, tracked
  changes, text boxes, shapes, charts and sections after the first are dropped
  on import. `docs/06-fidelity.md` says so plainly and measures the rest.
- No email. Password reset is an administrator action, by design: an air-gapped
  server has nowhere to send mail.
