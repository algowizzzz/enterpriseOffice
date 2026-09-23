# Product requirements

What DocForge has to be, written from a stakeholder's requirements register and
the scope decisions taken with the product owner on 2026-09-18. The register was
sanitised on the way in: nothing here names an organisation, a person, an
internal system or a vendor product that a particular customer happens to use.
Requirements are restated in our own words and numbered for this project.

This document replaces the build order in `07-roadmap.md` and
`09-requirements-fit.md`. Where they disagree, this one wins.

## 1. The product in one paragraph

A person uploads a Word document, or a PDF that is converted to the same thing.
It opens in a browser editor that behaves like Word. Several people can have it
open at once and edit it together. They comment, track changes and compare
versions. They export it to Word or PDF and **the formatting is what it was**.
It installs on an air-gapped Linux server as one file plus a Node runtime, with
no package that needs a compiler, no network access and no licence that places
conditions on the organisation using it.

## 2. Scope

| In | Out |
|---|---|
| Word upload, PDF upload (digital PDFs) | AI analysis, prompts, chatbot, knowledge-base connectors |
| Editing with Word's everyday feature set (section 4) | Scanned-PDF OCR |
| Real-time co-editing, presence, cursors | Macros and VBA |
| Comments, threads, document-level comments | Mail merge |
| Live track changes with accept and reject | SmartArt (kept as its picture, not editable) |
| Version history, redline comparison, redline export | The equation editor (equations kept as they arrive, not editable) |
| Export to Word and to PDF, plus the untouched original | Single sign-on (accounts are managed by hand for now) |
| Footnotes, endnotes, cross-references, bookmarks, captions, citations | Cloud monitoring integrations |
| Text boxes, shapes, charts, columns, sections, rich headers and footers | |
| Spelling with suggestions and a custom word list; forms and protection | |
| Ownership, sharing, roles, audit, administration | |

**Constraint that shapes everything: no LibreOffice, no native code.** PDF in
and PDF out are both pure JavaScript, compiled into `server.mjs`.

## 3. The design decision the scope forces

Export used to rebuild a Word file from nothing. Everything the model did not
understand was gone: the logo in the header, "Page 3 of 12", the corporate
styles, the second section, the chart. No amount of feature work closes that
gap one feature at a time.

So the rule is now **preserve by default, edit what we understand**:

1. The uploaded package is kept, byte for byte, beside the document.
2. Import reads the body into the model and keeps, on each node, the identity it
   had in Word: its style, its numbering, its raw properties. What the model has
   no node for (a chart, a shape, a content control, a field, an equation)
   becomes an opaque object that carries its own markup and shows its picture.
3. Export opens the original package, rewrites only `word/document.xml` (and the
   parts the editor owns: comments, footnotes), and leaves styles, numbering,
   theme, headers, footers, fonts, settings and every related part alone.
4. A document created here starts from a built-in template package, so there is
   one export path, not two.
5. The editor draws the document's own styles, from a style table read out of
   `styles.xml`, so a Heading 1 looks like that document's Heading 1.

## 4. The Word parity set

"Everything Word does" is not a testable requirement. This is the list that is.
Each row is done when it can be made in the editor, survives a save, survives a
round trip through Word, and has a test.

| Area | Features |
|---|---|
| Characters | Bold, italic, underline (and its styles), strikethrough, double strike, super and subscript, font, size, colour, highlight colour, small caps, all caps, character spacing, clear formatting, format painter |
| Paragraphs | Alignment, indents (left, right, first line, hanging), spacing before and after, line spacing, keep with next, page break before, borders and shading, tabs, styles gallery (the document's own styles) |
| Lists | Bullets and numbering with the source's scheme, multi-level, restart and continue, indent and outdent |
| Tables | Insert, add and delete rows and columns, merge and split, column resize, cell shading, borders, header row repeat, alignment in cells, nested tables, table templates (contents, version history, metadata) |
| Pictures | Inline, resized, drag to move, alt text; floating pictures kept in place on export |
| Page | Size, orientation, margins, columns, section breaks, page breaks, headers and footers with pictures, page numbers, different first page and odd or even |
| References | Table of contents that updates, footnotes and endnotes, bookmarks, cross-references, captions, hyperlinks, citations and bibliography (kept, and editable as text) |
| Review | Comments with threads and resolve, live track changes with accept and reject, compare two versions, redline export with real Word revision marks |
| Objects | Text boxes, shapes and charts shown and kept; content controls (text, dropdown, date, checkbox) fillable |
| Tools | Find and replace, word count, spelling with suggestions and a custom dictionary, navigation pane, keyboard shortcuts as in Word, print |
| Protection | Read-only and comments-only documents; a password-protected file is refused with a clear message |

## 5. Requirements register

Status is as of the start of this plan. P = phase in section 6.

### Upload and conversion

| ID | Requirement | Status | P |
|---|---|---|---|
| UP-1 | Upload Word up to 50 MB and 100 pages, with tables and pictures | Part: 25 MB, picture caps too low | 1 |
| UP-2 | Upload PDF; convert to an editable document keeping structure across pages | None | 6 |
| UP-3 | Multi-column source layout stays readable | Part | 1, 6 |
| UP-4 | Bold, italic, underline, fonts, colours kept | Done for direct formatting; style-inherited formatting not shown | 1 |
| UP-5 | Indentation kept; nothing re-centred | None | 1 |
| UP-6 | Hyperlink targets kept | Done | |
| UP-7 | Pictures kept, including background | Done | |
| UP-8 | Tables formatted as in the source; columns draggable; rows and columns can be added | Part: borders and table styles not read | 1 |
| UP-9 | Header and footer handled to policy (keep, or strip) | Part | 1 |
| UP-10 | The upload lands in the uploader's own work area | Done | |
| UP-11 | A document type is recorded at upload and shown beside the name | None | 2 |

### Editor

| ID | Requirement | Status | P |
|---|---|---|---|
| ED-1 | Headings, lists, bold, italic, underline, colour, line breaks | Done | |
| ED-2 | Copy, paste, select all, edit, delete | Done | |
| ED-3 | Edit at paragraph, heading and list level; drag and drop pictures | Part | 2 |
| ED-4 | Save work in progress at any time | Done | |
| ED-5 | Behave like Word: the parity set in section 4 | Part | 1 to 8 |
| ED-6 | Insert standard tables from a library: contents, version history, metadata, empty | None | 2 |
| ED-7 | A usage notice at the top of the editor | None | 2 |
| ED-8 | A tooltip on every control | Part | 2 |
| ED-9 | A home page with guidance and links to the user guide | None | 2 |

### Export

| ID | Requirement | Status | P |
|---|---|---|---|
| EX-1 | Export the edited document to Word with contents table, tables and pictures intact | Part: contents table flattened | 1 |
| EX-2 | Export to PDF | None | 7 |
| EX-3 | Export the original file, untouched, at any time | None | 1 |
| EX-4 | Exports keep the original file name | Part | 1 |
| EX-5 | Fonts, sizes, header and footer follow the house template | Part | 1 |
| EX-6 | Export with every accepted change applied | None | 4 |

### Review and collaboration

| ID | Requirement | Status | P |
|---|---|---|---|
| RV-1 | Comment on highlighted text | None | 3 |
| RV-2 | Threaded replies | None | 3 |
| RV-3 | Who and when on every comment | None | 3 |
| RV-4 | Document-level comments | None | 3 |
| RV-5 | Comments and revisions are kept, including through Word | None | 3, 4 |
| RV-6 | A comparison tab: original in grey, edits in red | None | 4 |
| RV-7 | Export the comparison to Word with markup | None | 4 |
| RV-8 | Several people review and edit one document at the same time | None | 5 |
| RV-9 | Live track changes with accept and reject | None | 4 |

### Ownership and administration

| ID | Requirement | Status | P |
|---|---|---|---|
| OW-1 | The uploader is the primary owner | Done | |
| OW-2 | An administrator can reassign ownership; an owner can hand it over | None | 2 |
| OW-3 | Secondary owners with view or edit, up to ten per document | Done (cap to add) | 2 |
| OW-4 | View-only people can still comment | None | 3 |
| OW-5 | Owned, edit and view permission levels | Done | |
| OW-6 | Delete with confirmation | Done | |
| OW-7 | Administrators grant, change and revoke access; roles on an admin page | Done | |
| OW-8 | People can ask for access | None | 2 |
| OW-9 | Audit of user and system actions | Done | |
| OW-10 | Health monitoring | Done | |

## 6. Build order

Each phase ends with `npm run verify` green, the fidelity corpus unchanged or
better, and a commit. A phase is not started until the one before it is
committed.

| P | Phase | What it delivers |
|---|---|---|
| 1 | **Fidelity foundation** | Keep the original package. Patch-based Word export. Opaque objects for what the model cannot edit. Styles read and drawn. Paragraph properties, numbering schemes, table borders, sections, rich headers and footers all survive. Export original. 50 MB uploads |
| 2 | **Everyday editor** | Find and replace, indent controls, line spacing, styles gallery, table merge and split and borders, table templates, contents table, picture drag, document type, ownership transfer, access requests, notice, tooltips, home page |
| 3 | **Comments** | Anchored and document-level, threads, resolve, attribution, view-only commenters, read from and written to Word's comments part |
| 4 | **Track changes and redline** | Live revision marks, accept and reject, compare two versions, redline export with `w:ins` and `w:del`, export with changes accepted |
| 5 | **Co-editing** | Shared editing over WebSocket with a CRDT, presence and cursors, reconnection, snapshots into the same stored form |
| 6 | **PDF import** | Text, headings, lists, tables, pictures and multi-column reading order from digital PDFs; a scanned PDF is refused plainly |
| 7 | **PDF export** | Paginated PDF with fonts embedded, headers, footers, page numbers, tables that break across pages |
| 8 | **References, objects, tools** | Footnotes and endnotes editable, bookmarks and cross-references, captions, citations as text, content controls fillable, spelling with suggestions and a custom dictionary, protection modes |
| 9 | **Proof** | A wide corpus from three independent producers, round tripped and scored; the deployment kit rebuilt; documentation brought up to date |

## 7. How "done" is decided

- **Fidelity.** `npm run try` on the wide corpus: no document refused, none that
  fails to save, and every measured feature preserved. The corpus comes from at
  least three producers that are not this project.
- **Word accepts the output.** Every exported file is opened by an independent
  Word-compatible reader during the test run; one that cannot be opened is a
  failure, whatever our own reader says.
- **The four-sided rule.** Every node and mark exists in the editor schema, the
  validator and repair, the reader and the writer, and a test asserts the
  vocabularies match.
- **The gate.** Lint, types, both suites, the build, the air-gap audit and the
  end-to-end run.
- **Licences.** `npm run notices` passes: nothing outside the accepted set.
