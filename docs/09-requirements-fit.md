# Fit against an enterprise policy-document workflow

Where the build stands against a representative set of enterprise requirements
for a policy document tool: upload Word, edit in the browser, comment, compare,
export, with ownership and administration around it. Assessed on 2026-09-18
against the code, not the documentation, and against four awkward Word documents
made with a different library from the one this project tests itself with.

## Scope, as agreed

| In | Out |
|---|---|
| Word upload, editing, save, versions | AI analysis, prompts, chatbot, knowledge-base connectors |
| Comments and threaded discussion | PDF **upload**, OCR, multi-column PDF layout |
| A redline comparison view, exportable | Real-time co-editing (two cursors in one document) |
| Export to Word; export to PDF | Single sign-on (accounts are managed by hand for now) |
| Ownership, sharing, roles, deletion, audit | Cloud monitoring integrations |
| Air-gapped Linux deployment | |

Taking real-time co-editing out is the largest change to the plan. It was item 1
of `07-roadmap.md` at two to three weeks. What the workflow asks for instead is
turn-based collaboration: several people with access to one document, comments,
and a record of what changed. The conflict-safe save that already exists is the
right foundation for that, and nothing needs a WebSocket.

## What the trial run showed

`npm run try` on four documents: a board report with a colour-coded heat map and
merged cells; a policy with a table inside a table and three-level lists; a
contract with tracked changes, fields and a landscape section; a multilingual
notice with a 120-row shaded register.

| | Result |
|---|---|
| Upload, save unchanged, export | 4 of 4. Imports in 20 to 35 ms each |
| Headings, bold, italic, underline, strike, super and subscript | All kept |
| Fonts, sizes, alignment | All kept |
| Tables, cell shading, merged cells, a nested table | All kept: 720 cells, 165 shaded |
| Pictures, header, footer, page break, landscape | All kept |
| Arabic, Chinese, Japanese, Hindi, symbols, emoji, markup-like text | Kept, and escaped |
| Text colour | 17 of 18 runs |
| **Hyperlinks** | **Lost on export. Fixed in this change**, with regression tests |
| Tracked changes | Read as if accepted: insertions kept, deletions dropped. No markup survives |
| Fields (contents, page number, date) | Flattened to their last shown text. A contents table arrives as plain text |
| Second section | Content kept; the section's own page setup is not |

So the editor core is sound on documents it was not tuned for. The gaps are the
ones `06-fidelity.md` already names, plus the link defect this run found.

## Requirement by requirement

Status: **Done**, **Part** (works, with a named gap), **None**.

### Upload and processing

| Requirement | Status | Note |
|---|---|---|
| Upload Word, with tables and pictures | Done | |
| Size limit of 20 to 50 MB | Part | The limit is one setting (25 MB by default). But pictures above 2 MB each, or 8 MB in total, are dropped with a message. A scanned appendix will hit that. Raise the caps and test memory at 50 MB |
| Documents up to 100 pages | Part | Nothing limits it, and a 120-row register is instant. Not yet measured at 100 real pages in the editor. Measure before promising |
| Keep bold, italic, underline | Done | |
| Keep indentation; do not centre what was left-aligned | Part | Alignment is kept. Paragraph indents are not read: only quotations are indented. Small |
| Keep hyperlink targets | Done | As of this change |
| Keep pictures, including their background | Done | Pictures are stored as the original bytes, untouched |
| Tables formatted correctly, columns draggable, rows and columns can be added | Done | Column widths round trip; the ribbon adds and removes rows and columns |
| Strip the uploaded header and footer | Part | Today they are kept and editable, the opposite behaviour. Make it a choice at upload. Small |
| Multi-column layout stays readable | Part | Text arrives in reading order as one column. The columns themselves are not kept. Acceptable for editing; say so |
| File saved to a personal work area | Done | Every upload belongs to the uploader and appears in their list |

### Editor

| Requirement | Status | Note |
|---|---|---|
| Headings, lists, bold, italic, underline, colour, line breaks | Done | |
| Copy, paste, select all, edit, delete | Done | |
| Paragraph, heading and list level editing | Done | |
| Drag and drop a picture | Part | Pictures insert from the ribbon and by paste. Drag to move is untested |
| Save work in progress | Done | Autosave plus explicit save, conflict-safe, every save a version |
| Insert standard tables from a library (contents, version history, metadata) | None | Templates are a list of ready-made table nodes behind one ribbon button. Small. A real contents table needs field support, below |
| Usage notice at the top of the editor, tooltips, a home page with guidance | None | Small, all client side |

### Export

| Requirement | Status | Note |
|---|---|---|
| Export to Word with tables and pictures intact | Done | |
| Export keeps the original file name | Part | The source name is stored; the export is named from the title. Small |
| Export the **original** file as well as the edited one | None | The upload is converted and the file itself is not kept. Store the original bytes beside the document. Small, but it changes what a backup holds |
| Contents table intact on export | None | Fields are flattened. Needs a contents node that is written back as a Word field, so Word regenerates it. Medium |
| Export to PDF | None | The hard one. See below |
| Fonts, sizes, header and footer to an approved template on export | Part | All four round trip. "Apply the house template" is a named-styles feature: roadmap item 2 |

### Comparison (redline)

| Requirement | Status | Note |
|---|---|---|
| A third tab comparing original and edited | None | Every version is already stored, so this is a diff of two snapshots, not live change tracking. Medium |
| Original in grey, edits in red | None | Part of the same work |
| Export the comparison to Word with coloured markup | None | Coloured runs are easy. Genuine Word revision marks (`w:ins`, `w:del`) are better and not much harder, because reviewers can then accept and reject in Word |

### Comments and collaboration

| Requirement | Status | Note |
|---|---|---|
| Comment on highlighted text | None | A comment mark in the model, moved through all four sides (editor, validator, reader, writer), plus a comments table. Medium |
| Threaded replies | None | Same work |
| Who and when on every comment | None | Same work; the audit trail already has the pattern |
| Document-level comments, not tied to text | None | Same table, no anchor |
| Comments and revisions preserved | Part | Revisions are. Comments should also be read from and written to Word's own comments part, or they are lost the first time a file leaves |
| Several people on one document, not at the same moment | Done | Shares plus conflict-safe saving. A "someone else has this open" notice would make it kinder. Small |

### Ownership, roles, administration

| Requirement | Status | Note |
|---|---|---|
| Uploader is the primary owner | Done | |
| Administrator can reassign ownership | None | One endpoint and one button. Small |
| Owner names secondary owners with view or edit | Done | This is the existing share |
| Up to ten people per document, mixed rights | Done | No limit exists; add the cap if it is wanted |
| View-only people can still comment | None | Falls out of comments, as a permission check |
| Roles managed from an administration page | Done | Administrator, editor, viewer |
| Grant, change and revoke access to the tool | Done | Create, disable, reset password |
| People can request access | None | Needs a decision first: with hand-managed accounts, a request is an email. Small if wanted |
| Delete with confirmation | Done | Soft delete |
| Audit of user and system actions | Done | |
| Health monitoring | Done | `/api/health` and structured logs. Alerting belongs to the platform |

## Counting it up

Of 44 requirements in scope: 20 done, 9 part, 15 none. The fifteen are fewer
pieces of work than they look, because comments account for five of them, the
redline for three, and most of the rest are small.

## What to build, in order

| # | Work | Size | Why here |
|---|---|---|---|
| 1 | **Small things in one pass**: keep the original file and export it; export under the source name; ownership transfer; header and footer choice at upload; paragraph indents; higher picture caps; notice, tooltips and home page | 1 week | Eight requirements closed, none of them risky, and the trial install gets better while it is being tried |
| 2 | **Comments**: anchored and document-level, threads, attribution, view-only commenters, round trip through Word's comments part | 2 weeks | The centre of the collaboration requirement, and five rows |
| 3 | **Redline tab and its export**, with real Word revision marks | 1 to 2 weeks | Depends on nothing but stored versions |
| 4 | **Table templates and a contents table that survives export** | 1 week | Needs the first field the model has ever carried; do it once comments have exercised the four-sided change |
| 5 | **PDF export** | 1 to 3 weeks | Last, because it is the one with a real decision in it |
| 6 | Named styles and the house template (roadmap item 2) | 1 to 2 weeks | Only if "export to the approved template" is confirmed as a requirement rather than an aspiration |

Seven to eleven weeks for one person, with 1 to 3 giving a version worth
putting in front of users at about the five week mark.

### The PDF decision

There are three ways to make a PDF on an air-gapped server, and no fourth.

1. **Print from the browser.** The print stylesheet exists. Free, and the output
   is whatever the person's browser makes of it: no page numbers to rely on, no
   guarantee two people get the same file. Good enough for "give me a PDF";
   not for a controlled document.
2. **Headless LibreOffice beside the server**, converting the exported Word
   file. MPL-2.0, used as a separate process, so the licence does not reach
   this code. Best fidelity by far, because it is a real layout engine. Costs
   about 400 MB on the server and a package the platform team must approve.
3. **Write PDFs directly** with a pure JavaScript library. Keeps the one-file
   deployment. Means writing pagination, tables that break across pages and
   font embedding by hand: weeks, and it will never match Word.

Recommendation: ship 1 now, since it costs nothing, and ask the platform team
whether LibreOffice can be installed. If yes, 2 is a week. If no, 3 is the
fallback and the estimate is the upper one.

## Risks worth saying out loud

- **"Try to mimic Word, but not in entirety" needs a list.** Footnotes, text
  boxes, shapes, charts and content controls are dropped today. Run `npm run
  try` on twenty real policies early: it counts exactly these, and the result
  decides whether any of them joins the plan.
- **Every new node or mark is a four-sided change**: editor schema, validator
  and repair, Word reader, Word writer. Comments, the contents table and revision
  marks are all new vocabulary. This is the pattern behind every regression in
  the project's history, so each one lands whole or not at all.
- **`node:sqlite` is marked experimental in Node 22.** It passes everything
  here. A change board may still ask. The answer is a newer Node release line
  where it is no longer experimental, which costs nothing but a preflight run.
- **One instance.** SQLite means one server process. For a policy team that is
  ample; it is not a platform for the whole organisation at once.
- **Accounts by hand do not scale past a department.** Fine for a trial and a
  first rollout. Single sign-on is out of scope now and will come back.
