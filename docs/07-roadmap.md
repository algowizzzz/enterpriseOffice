# What to build next

Ranked by what it is worth against what it costs. Each item says why it matters,
what it touches, what makes it hard, and what "done" looks like. Sizes assume
somebody working with an agent, not a team.

Read `CLAUDE.md` before starting any of them. Every item below moves the
document model, and the model is shared by four things that must move together:
the editor's schema, the Word reader, the Word writer and the validator.

## 1. Real-time co-editing

**Why.** It is the one headline capability designed for and not built. Today two
people can hold the same document open; the second save is refused as a conflict
with an offer to reload. That is honest but it is not collaboration.

**Approach.** The document is ProseMirror JSON and the storage layer is narrow,
which was chosen for this. Two routes:

- *Yjs* (MIT) with `y-prosemirror`, a WebSocket provider and the update log
  persisted in SQLite. Least code, mature, and the CRDT handles the hard part.
- *ProseMirror's own collab module* with a central authority. Fewer moving
  parts and no new dependency, but you write the rebasing server.

Take Yjs unless the licence review says otherwise. Keep the JSON snapshot as the
stored form, with the update log beside it: the exporter, the validator and the
version history all read the snapshot.

**Hard parts.** Presence and cursors. Reconnection after a laptop sleeps.
Making an awareness update not count as an edit for the autosave and the
version history. Deciding what a "version" means once there is no single author.

**Done when.** Two browsers type into one document and see each other's text and
cursors; one can be disconnected for a minute and reconnect without losing a
keystroke; the audit trail records who changed what; `npm run verify` is green
and the fidelity harness is unchanged.

**Size.** Two to three weeks.

## 2. Named styles and numbering definitions

**Why.** The largest remaining fidelity gap. A document's own styles are read
for headings and quotations and otherwise flattened into direct formatting, so a
corporate template comes back looking right and losing its structure. Numbering
comes back as a list of the right kind, not with the source's scheme.

**Approach.** Read `word/styles.xml` into a style table carried beside the
document, the way page setup now is. Add a `styleId` attribute to paragraph and
heading nodes. Resolve a style to direct formatting for display, but keep the
name so the writer can put it back.

**Hard parts.** Style inheritance (`basedOn`), and the interaction between a
style and direct formatting on the same run. Numbering restarts and levels.

**Done when.** A document with a corporate template round-trips with its style
names intact, and the fidelity harness grows a `styles` and a `numbering`
feature that score 100%.

**Size.** One to two weeks.

## 3. Pagination, print and PDF

**Why.** The editor shows one continuous page. People expect page numbers, a
page count, and a print that matches. There is a print stylesheet and a page
break that breaks, but no pagination.

**Approach.** Measure rendered blocks in the browser and insert page boundaries
as decorations, not as content: the document model must not learn about pages.
For PDF, print through the browser first, and only write a layout engine if that
proves inadequate. `pdf-lib` and `pdfkit` are both MIT if it comes to that.

**Hard parts.** Tables and images that straddle a boundary. Performance on a
long document. Keeping the boundary out of the stored content.

**Done when.** The page count in the status bar matches what prints, a page
break lands where it is drawn, and a fifty-page document stays responsive.

**Size.** One to two weeks for pagination and print; longer for a real PDF
writer.

## 4. Find and replace

**Why.** Every word processor has it and this does not. It is the most obvious
gap for anybody using the editor for real work.

**Approach.** A ProseMirror plugin with decorations for the matches, a panel in
the ribbon, whole-word and case options, and replace-all as one transaction so a
single undo puts it back.

**Done when.** Find, find next, replace and replace all work across a document
with tables and lists, undo is one step, and the match count is live.

**Size.** Two to three days.

## 5. Footnotes, comments and tracked changes

**Why.** These are what makes a document reviewable, and they are what a legal
or policy team asks about first. They are grouped because each needs the same
thing: content that is anchored to a range but is not in the flow.

**Approach.** Start with footnotes: a node plus a numbered store beside the
document, written to `word/footnotes.xml`. Comments are the same shape with an
author and a timestamp. Tracked changes are the hardest and should wait for
co-editing, because both are about attributing a change to a person.

**Done when.** Each survives a Word round trip and appears in the fidelity
table.

**Size.** A week each for footnotes and comments. Tracked changes is a project.

## Smaller things worth doing

| Item | Why | Size |
|---|---|---|
| Document folders or tags | The list is flat and will not stay usable | 2 days |
| Full-text search across documents | SQLite FTS5 is built in | 2 days |
| Import `.doc`, `.odt`, `.rtf` | LibreOffice headless as a separate process, MPL-2.0, not linked | 3 days |
| Templates | Start from a stored document rather than a blank one | 2 days |
| Bulk export | A zip of a person's documents, for leaving or archiving | 1 day |
| Keyboard shortcut reference | The bindings exist, nothing documents them in the app | 1 day |

## Things to resist

- **Widening the document model without moving all four sides.** Editor schema,
  reader, writer, validator. Every regression in this project's history came
  from moving one.
- **Adding a dependency that reaches the network at run time.** The air gap is
  enforced by tests that will fail, but the cost is discovering it late.
- **Taking a GPL or AGPL library for a hard problem.** It ends the project's
  licence story. Write it or choose another.
