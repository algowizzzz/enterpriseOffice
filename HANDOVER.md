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
| Commits | 57, all on `main` |
| Server tests | 549 |
| Client tests | 238 |
| End-to-end checks | 35 |
| Word round-trip fidelity | 1260 of 1260 measured items, across 50 documents, plus 35 from a wide corpus of three other producers |
| Verify runs clean | Repeatedly, most recently 2026-09-22 |

This section used to say 38 commits and describe comments, track changes and
real-time co-editing as not built. Nineteen commits did exactly that in
between, and this file was not updated to match: **`docs/11-status.md` is the
current source of truth for what exists**, not this section or
`docs/07-roadmap.md`'s "what to do next". Read it first.

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
7. `docs/07-roadmap.md` for the reasoning behind the original build order. Its
   ranked list itself is superseded twice over by items 9 and 10 below, and
   most of it has since been built regardless (see item 11): read it for
   context, not for what to do next.
8. `docs/08-enterprise-deployment.md` for installing on an air-gapped Linux server,
   or `docs/13-windows-quickstart.md` for a Windows laptop. Neither needs anything
   installed on the target first: the release archive already carries Node.
9. `docs/09-requirements-fit.md` for where the build stands against an enterprise
   policy workflow. Its build order replaces the roadmap's where they differ.
10. `docs/10-product-requirements.md` for what the product has to be, its scope and
    its build order. It replaces the order in 07 and 09.
11. `docs/11-status.md` for where the build stands against it: done, partial, not
    built, and what to expect of PDF. **Read this one first.**
12. `docs/12-requirements-and-bom.md` for the plain-language requirements list and
    full bill of materials to hand to a security or infrastructure review.
13. `docs/14-word-like-shell.md` for what "make it look like Word" breaks down
    into, what of that was already built before anyone asked, and the plan for
    the one large piece left: a genuine tabbed ribbon.
14. `docs/15-enterprise-redesign.md` for the plan to take the interface from
    "functional" to enterprise-grade: a design-token system, the documents
    home and administration console reconsidered, the rename to DocAI, and
    the house-style/branding system, planned in technical detail but not yet
    built. Read this before doing any further UI work: it sets the order.
15. `docs/16-ai-integration.md`, decided 2026-09-22: **AI is now in scope**,
    superseding the "out of scope by decision" framing in `docs/11-status.md`
    and the "no model behind this yet" framing in `docs/14`'s "A document
    assistant" section and in `docs/15`. This is a build spec, not a plan
    only, and it is the first feature in this product's history that makes
    an outbound network call by design — read its §7 before touching
    anything that calls out to a model, and its §12 for the two questions
    still waiting on a decision that is not the codebase's to make.

## What to do next

Ignore `docs/07-roadmap.md`'s ranked list: every item on it except named styles
and numbering is now built (see `docs/11-status.md`). What is actually left,
in order of value against effort:

1. **The editor's own look.** Word-like functionality (comments, track
   changes, co-editing, admin approval) is done; the shell around it is not.
   There is no tabbed ribbon (Home/Insert/Layout/Review/View), no title bar in
   Word's sense, and until 2026-09-22 no navigation pane, which
   `docs/10-product-requirements.md` calls for and the UI did not have. A
   Navigation pane (jump to a heading) and a zoom control were added that day;
   a real tabbed ribbon was deliberately not attempted in the same pass,
   because `Toolbar.tsx`'s 438 lines of tests exercise every control in one
   render without switching tabs, so a genuine show/hide ribbon needs those
   tests reworked alongside it, not as an afterthought.
2. **Named styles and numbering definitions.** The largest remaining fidelity
   gap: a document's own styles are flattened into direct formatting.
3. Two things nobody has asked for yet, noted in `docs/11-status.md`: editing
   the text inside a text box, and controls for margins, columns and section
   breaks.

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

- No pagination: the editor shows one continuous page. Print and PDF export
  paginate; the screen does not.
- Named styles and numbering definitions are flattened into direct formatting
  on import, along with text boxes, shapes, charts, SmartArt, embedded objects
  and equations, which arrive, display and leave untouched but are not
  editable here. `docs/11-status.md` lists exactly what is kept but not
  editable, and `docs/06-fidelity.md` measures it.
- No email. Password reset is an administrator action, by design: an air-gapped
  server has nowhere to send mail.
- No AI features, OCR of scanned PDFs, macros, mail merge or single sign-on:
  out of scope by decision, not by omission.
- Real-time co-editing, comments and tracked changes **are** here (see
  `docs/11-status.md`); this file said otherwise until 2026-09-22.
