# Where the build stands

Against `10-product-requirements.md`, on 2026-09-18, after phases 1 to 7 and
part of 8. Everything marked done has been run, not only written: the gate is
green (526 server tests, 207 browser tests, the air-gap audit, 35 end-to-end
checks), and the wide corpus round trips clean.

## The evidence

| Check | Result |
|---|---|
| `npm run verify` | Passes: lint, types, both suites, build, air-gap audit, end to end |
| The project's own corpus (`scripts/fidelity/run.mjs`) | 1260 of 1260 items, 50 documents |
| The wide corpus (`scripts/fidelity/wide`, `npm run try`) | 35 of 35 documents from three other producers upload, save unchanged, export and open in an independent reader, with nothing measured lost |
| Licences (`npm run notices`) | 199 shipped packages: MIT, ISC, BSD-3-Clause, Apache-2.0, BlueOak-1.0.0, 0BSD, Zlib. No GPL, no AGPL |
| Outbound connections | None, asserted by the end-to-end run |
| Seen working in a real browser | Styles drawn from the file, comments, live track changes, the redline tab, two tabs co-editing with each other's cursor |

**Not yet run on a real Linux host:** `install.sh` and the systemd unit. They
pass a syntax check. The first enterprise install is that test.

## By phase

| Phase | State | Notes |
|---|---|---|
| 1. Fidelity foundation | **Done** | Export patches the uploaded file. Styles, numbering, sections, columns, rich headers and footers, fields, footnotes, bookmarks, text boxes, shapes, charts, equations and form controls survive a round trip, because they are left alone |
| 2. Everyday editor | **Done**, two gaps | Find and replace, document styles, indent, line spacing, table tools, contents table, standard tables, 50 MB uploads, document type, ownership transfer, ten-person cap, notice and guide. Gaps: no format painter; access requests not built (accounts are made by hand, so a request is a message to an administrator) |
| 3. Comments | **Done** | Anchored and document-level, threads, resolve, view-only commenters, read from and written to Word |
| 4. Track changes and redline | **Done**, one limit | Live tracking, accept and reject, Original and Redline tabs, redline and accepted-changes export, Word revision marks both ways. Limit: text within a paragraph is tracked; splitting or joining paragraphs and table structure take effect directly |
| 5. Co-editing | **Done**, one limit | Shared editing over WebSocket, presence and cursors, reconnection, read-only enforcement, fallback when WebSockets are blocked. Limit: a tracked-change mark on a picture or kept object does not travel between browsers (the library keeps marks on text only) |
| 6. PDF import | **Done for digital PDFs**, with the limits below | |
| 7. PDF export | **Done**, with the limits below | |
| 8. References, objects, tools | **Part** | Done: footnote and endnote text readable, form controls kept whole, password-protected files explained, document lock (comments only). Not built: see below |
| 9. Proof | **Done** for Word; PDF proof is the module tests plus five LibreOffice-made PDFs | |

## What is kept but cannot be edited here

All of these arrive, are shown as a placeholder or as their text, and leave in
the exported Word file exactly as they came. Editing them means editing in Word.

- Footnote and endnote wording (readable here, not editable)
- Text boxes, shapes, WordArt, charts, SmartArt, embedded objects, equations
- Fields other than hyperlinks: cross-references, dates, page numbers, captions'
  numbers, citations and bibliographies
- Drop-downs, date pickers, tick boxes (shown with their current value)
- Headers and footers with pictures and page numbers: kept untouched unless the
  header or footer line is retyped in Page setup, which replaces it with that line
- Sections, columns and margins: kept; there are no controls to change them here
  beyond orientation

## Not built

| Item | Why it matters | Size |
|---|---|---|
| Spelling with a bundled dictionary, suggestions and a custom word list | Asked for. Today the browser's own spell check is on, works offline, and has its own suggestions and "add to dictionary"; nothing of ours sits on top | 1 week |
| Pictures stored outside the document | A document's pictures travel inside it, so the total shown in the editor is capped at 8 MB (6 MB each). A larger picture is still in the file and still exported; it is not drawn. Needed before 50 MB picture-heavy documents edit comfortably, and it would lighten co-editing | 1 week |
| Numbered headings drawn with their numbers | "1.1 Purpose" shows as "Purpose" here. The numbering is kept and Word shows it | 2 to 3 days |
| Tracking paragraph splits, joins and table structure | See phase 4 | 1 to 2 weeks |
| Editing footnotes, text boxes and form values | See the list above | 1 week each |
| Access requests, format painter | Small | Days |

## PDF: what to expect

**Import.** Good: paragraphs rejoined across lines, columns and pages; two and
three column reading order; headings; lists; links; pictures; running headers,
footers and page numbers removed from the body. Partial: tables. A simple ruled
grid comes back as a table; a complex one can split into two or three, with no
text lost, and the import says to check them. Merged cells, borders and shading
are not recovered. Not attempted: scanned PDFs (refused, in words), right-to-left
ordering, JPEG 2000 and JBIG2 pictures. A PDF is a picture of a document, not a
document: this is reconstruction, and it will need a read-through.

**Export.** A faithful reflow, not a facsimile: text is set in Helvetica, Times
or Courier, so line and page breaks will not match Word's. Text outside Western
European languages needs a font on the server. Kept objects (charts, shapes)
are drawn as their label. For a PDF that matches Word exactly, export to Word
and print to PDF from Word.

## Deployment

`npm run release` builds the archive; `docs/08-enterprise-deployment.md` is the
guide. New since the first kit: the reverse proxy must pass WebSocket upgrades
for `/api/collab/` (the guide has the nginx and httpd rules, and the editor
falls back to ordinary saving where a network forbids them), and
`DOCFORGE_FONT_DIRS` for non-Latin PDF export. `server.mjs` is now about 9 MB.
