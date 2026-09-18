# Where the build stands

Against `10-product-requirements.md`, on 2026-09-18, with every phase built.
Everything marked done has been run, not only written: the gate is green (549
server tests, 232 browser tests, the air-gap audit, 35 end-to-end checks), and
the wide corpus round trips clean.

## The evidence

| Check | Result |
|---|---|
| `npm run verify` | Passes: lint, types, both suites, build, air-gap audit, end to end |
| The project's own corpus (`scripts/fidelity/run.mjs`) | 1260 of 1260 items, 50 documents |
| The wide corpus (`scripts/fidelity/wide`, `npm run try`) | 35 of 35 documents from three other producers upload, save unchanged, export and open in an independent reader, with nothing measured lost |
| Licences (`npm run notices`) | 203 shipped packages: MIT, ISC, BSD-3-Clause, Apache-2.0, BlueOak-1.0.0, 0BSD, Zlib, and the SCOWL word-list terms for the two spelling dictionaries (read by hand, permissive). No GPL, no AGPL |
| Outbound connections | None, asserted by the end-to-end run |
| The packaged server on its own | PDF both ways, Word export and the co-editing socket, run from outside the repository with no `node_modules` |
| Seen working in a real browser | Styles drawn from the file, comments, live track changes, the redline tab, two tabs co-editing with each other's cursor |

**Not yet run on a real Linux host:** `install.sh` and the systemd unit. They
pass a syntax check. The first enterprise install is that test.

## By phase

| Phase | State | Notes |
|---|---|---|
| 1. Fidelity foundation | **Done** | Export patches the uploaded file. Styles, numbering, sections, columns, rich headers and footers, fields, footnotes, bookmarks, text boxes, shapes, charts, equations and form controls survive a round trip, because they are left alone. Pictures are kept in a store of their own, so a picture-heavy document is light to save and to share |
| 2. Everyday editor | **Done** | Find and replace, document styles, format painter, indent, line spacing, table tools, contents table, standard tables, clause numbers on headings, 50 MB uploads, document type, ownership transfer, ten-person cap, access requests for documents and for accounts, notice and guide |
| 3. Comments | **Done** | Anchored and document-level, threads, resolve, view-only commenters, read from and written to Word |
| 4. Track changes and redline | **Done**, one limit | Live tracking of text, of Enter and of joined paragraphs; accept and reject; Original and Redline tabs; redline and accepted-changes export; Word revision marks both ways. Limit: a deletion that crosses from one list item or table cell into another takes effect directly |
| 5. Co-editing | **Done**, one limit | Shared editing over WebSocket, presence and cursors, reconnection, read-only enforcement, fallback when WebSockets are blocked. Limit: a tracked-change mark on a picture or kept object does not travel between browsers (the library keeps marks on text only) |
| 6. PDF import | **Done for digital PDFs**, with the limits below | |
| 7. PDF export | **Done**, with the limits below | |
| 8. References, objects, tools | **Done**, with the list below of what is kept but not edited | Footnotes and endnotes readable, editable and insertable; drop-downs, date pickers and tick boxes fillable; spelling from a bundled British or American dictionary with suggestions and a personal word list; document lock (comments only); password-protected files explained |
| 9. Proof | **Done** | The wide corpus for Word; module tests plus five LibreOffice-made PDFs for PDF |

## What is kept but cannot be edited here

All of these arrive, are shown as a placeholder or as their text, and leave in
the exported Word file exactly as they came. Editing them means editing in Word.

- Text boxes, shapes, WordArt, charts, SmartArt, embedded objects, equations
- Fields other than hyperlinks and the contents table: cross-references, dates,
  page numbers, captions' numbers, citations and bibliographies
- Picture holders in forms (the other form controls can be filled in)
- Headers and footers with pictures and page numbers: kept untouched unless the
  header or footer line is retyped in Page setup, which replaces it with that line
- Sections, columns and margins: kept; there are no controls to change them here
  beyond orientation
- The formatting inside a footnote whose wording is edited here: the new wording
  is plain text. A footnote nobody touches keeps its formatting

## Not built

Nothing from the agreed scope. Out of scope by decision: AI features, OCR of
scanned PDFs, macros, mail merge, SmartArt and equation editing, single sign-on.
Two things worth doing next, neither asked for: editing the text inside a text
box, and controls for margins, columns and section breaks.

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
`DOCFORGE_FONT_DIRS` for non-Latin PDF export. `server.mjs` is now about 9 MB, and the browser client carries two spelling
dictionaries of about half a megabyte each, fetched only when spelling is
switched on.
