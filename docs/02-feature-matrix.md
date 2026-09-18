# Feature Matrix: Every Word / OnlyOffice Ribbon Tab

Companion to `word-editor-architecture.md`. Stack assumed: ProseMirror
(+ Tiptap open-source extensions where useful), Yjs + Hocuspocus, own OOXML
codec, own layout module, React + shadcn/ui ribbon, Node server.

## Legend

| Tag | Meaning | Typical cost |
|---|---|---|
| **OOB** | The library already does it. You add a ribbon button that calls an existing command. | hours |
| **CONFIG** | Supported by schema attrs, extension options, or a small plugin using existing primitives. | 1–3 days |
| **CUSTOM** | No library does it. You write model + plugin + UI, usually plus OOXML mapping and layout. | 1–6 weeks each |
| **SERVER** | Belongs in the Node service, not the editor. | varies |

One thing is always custom: **the ribbon itself**. ProseMirror and Tiptap
ship zero UI. Every tab, dialog, gallery and pane is React code you write
using shadcn/ui primitives. Budget ~6–8 weeks for the full ribbon shell,
dialogs and panes on top of the feature work below.

Honest summary: about **25% OOB, 25% CONFIG, 50% CUSTOM** by feature count,
but the CUSTOM items (layout, OOXML, track changes, fields, mail merge)
are 80% of the engineering time.

---

## Word: File (Backstage)

| Feature | Tag | Notes |
|---|---|---|
| New (blank, from template) | SERVER + CONFIG | Templates = stored `.docx`/Y.Doc seeds |
| Open / Recent / Browse | SERVER | Document list API, folder tree UI |
| Save / Save As / Autosave | OOB (Yjs) + SERVER | Yjs persists continuously; "Save As" = fork Y.Doc |
| Save as .docx / .pdf / .odt / .rtf / .txt / .html | CUSTOM (.docx, .pdf) / SERVER (LibreOffice for .odt, .rtf) | Own OOXML codec is a top-3 workstream |
| Info: properties, word count, protect, inspect | CONFIG (props) / CUSTOM (protect, inspect) | Core props map to `docProps/core.xml` |
| Version history / restore | CONFIG (Yjs snapshots) + SERVER | UI to diff two snapshots is CUSTOM |
| Print / print preview | CUSTOM | Depends on layout module |
| Share / permissions | SERVER | ACL + Hocuspocus auth hooks |
| Export / Transform | CUSTOM | Same as Save As formats |
| Options (proofing, save, language, advanced) | CONFIG | Settings store per user |
| Account / Feedback | n/a | Drop or replace with local user profile |

## Word: Home

| Feature | Tag | Notes |
|---|---|---|
| Clipboard: cut/copy/paste, paste special, format painter | OOB (basic) / CUSTOM (paste from Word HTML, keep-source-formatting, format painter) | ProseMirror handles plain and internal paste; Word-clipboard HTML needs a cleaner |
| Font family, size, grow/shrink | CONFIG | Marks with attrs |
| Bold, italic, underline (styles), strikethrough, sub/superscript | OOB | |
| Text effects, highlight, font colour, text shading | CONFIG | Marks; effects (glow, shadow) CUSTOM |
| Change case | CONFIG | Command over selection text |
| Clear formatting | OOB | |
| Bullets, numbering, multilevel list | CUSTOM | Word lists are flat paragraphs with `numId/ilvl`, not nested `<ul>`. Tiptap's list extension is wrong model for OOXML fidelity |
| Increase/decrease indent | CONFIG | Paragraph attr |
| Sort paragraphs | CONFIG | |
| Show/hide ¶ formatting marks | CONFIG | Decorations |
| Align left/centre/right/justify | CONFIG | Paragraph attr |
| Line & paragraph spacing, before/after | CONFIG | Paragraph attrs; layout module honours them |
| Borders and shading (paragraph) | CONFIG | Attrs + CSS |
| Styles gallery, apply/modify/create style, style inspector | CUSTOM | Style model with `basedOn`/`next`/`link` resolution; gallery UI |
| Find, advanced find, replace, go to | CONFIG (find/replace) / CUSTOM (wildcards, format search, go to page) | Search plugin over text; page targets need layout |
| Select all / select objects / select similar formatting | OOB / CUSTOM / CUSTOM | |
| Dictate, Editor (AI), Add-ins | n/a / optional | Offline speech = Vosk (Apache-2.0) if ever wanted |

## Word: Insert

| Feature | Tag | Notes |
|---|---|---|
| Cover page gallery | CONFIG | Stored fragments inserted at top with page break |
| Blank page / page break | CONFIG (node) + CUSTOM (layout must honour) | |
| Table: grid picker, insert, draw, convert text↔table, Excel-style | CONFIG (`prosemirror-tables`) / CUSTOM (draw table, convert, quick tables) | |
| Pictures (this device), online, screenshot | CONFIG (inline image node) / CUSTOM (anchored + wrap) | Wrap text requires layout module |
| Shapes, icons, 3D models, SmartArt | CUSTOM (shapes as SVG nodes) / skip (3D, SmartArt) | SmartArt is a huge feature; ship "insert diagram as picture" |
| Chart | CUSTOM | Chart node backed by Chart.js/ECharts + data editor dialog; export to OOXML `c:chart` |
| Add-ins, Wikipedia, online video | n/a | Air-gapped |
| Links: hyperlink, bookmark, cross-reference | CONFIG (link mark) / CUSTOM (bookmarks, cross-refs as fields) | |
| Comment | CUSTOM | Mark + Y.Map threads + side pane |
| Header, footer, page number | CUSTOM | Section props + sub-documents + layout |
| Text box, quick parts, WordArt, drop cap, signature line, date & time, object | CUSTOM (text box, drop cap, date field) / skip (WordArt, OLE object) | Text boxes = floating containers in layout |
| Equation | CONFIG (MathLive node) + CUSTOM (OMML export) | |
| Symbol / special characters | CONFIG | Dialog + insert text |

## Word: Draw

| Feature | Tag | Notes |
|---|---|---|
| Pens, highlighter, eraser, ink to shape/text | CUSTOM (ink strokes as SVG node via `perfect-freehand`) / skip (ink recognition) | Low priority for a document editor |
| Drawing canvas | CUSTOM | |
| Ruler | CUSTOM | Ruler UI with indent/tab stops; ties to layout |

## Word: Design

| Feature | Tag | Notes |
|---|---|---|
| Document themes, colours, fonts, effects | CUSTOM | Theme model = OOXML `theme1.xml`; style resolution must read theme fonts/colours |
| Style sets gallery | CUSTOM | Depends on style model |
| Paragraph spacing presets | CONFIG | |
| Watermark | CUSTOM | Header-anchored floating text/image in layout |
| Page colour | CONFIG | Section/document attr |
| Page borders | CUSTOM | Layout module draws per page |

## Word: Layout

| Feature | Tag | Notes |
|---|---|---|
| Margins, orientation, size | CONFIG (section attrs) + CUSTOM (layout honours them) | |
| Columns | CUSTOM | Multi-column layout with balancing |
| Breaks: page, column, section (next page/continuous/odd/even) | CUSTOM | Sections drive header/footer/page numbering |
| Line numbers | CUSTOM | Layout |
| Hyphenation | CUSTOM | Patterns via `hyphen`; layout inserts soft breaks |
| Indent left/right, spacing before/after (spinners) | CONFIG | |
| Position, wrap text, bring forward/backward, align, group, rotate | CUSTOM | Floating object model + layout; group/rotate on SVG nodes |
| Selection pane | CONFIG | List of floating objects |

## Word: References

| Feature | Tag | Notes |
|---|---|---|
| Table of contents (insert, update, custom) | CUSTOM | Field node computed from heading outline + page numbers from layout |
| Footnotes, endnotes, next/show notes | CUSTOM | Footnote node + per-page footnote area in layout |
| Research, Smart Lookup | n/a | |
| Citations & bibliography, manage sources, style (APA/MLA) | CUSTOM | Source store + CSL rendering via `citeproc-js` (CPAL/AGPL dual, choose CPAL, check) or write a formatter for 3–4 styles |
| Insert caption, table of figures, cross-reference | CUSTOM | Fields with SEQ numbering |
| Mark entry / insert index | CUSTOM | XE fields + index builder |
| Mark citation / table of authorities | CUSTOM (low priority) | |

## Word: Mailings

| Feature | Tag | Notes |
|---|---|---|
| Envelopes, labels | CUSTOM | Page templates + layout |
| Start mail merge, select recipients (CSV/xlsx), edit list | CUSTOM | CSV via `papaparse` (MIT); xlsx via `exceljs` (MIT) |
| Merge fields, rules, match fields, preview | CUSTOM | Field node `MERGEFIELD`, substitution engine |
| Finish & merge (documents, print, email) | CUSTOM + SERVER | Batch render; email skipped on air-gap unless local SMTP |

## Word: Review

| Feature | Tag | Notes |
|---|---|---|
| Spelling & grammar, thesaurus, word count, read aloud | CONFIG (spell via `nspell` in worker) / CUSTOM (grammar rules, thesaurus needs a local WordNet dataset) / CONFIG (count) / skip (read aloud) | |
| Language, set proofing language, translate | CONFIG (lang attr per run) / n/a (translate offline) | |
| Accessibility checker | CUSTOM (rule set) | |
| Comments: new, delete, previous/next, show, resolve, reply | CUSTOM | Shared with Insert > Comment |
| Track changes on/off, lock tracking, markup views, reviewing pane | CUSTOM | Suggestion marks + transaction filter + OOXML `w:ins/w:del` |
| Accept / reject (all, by author) | CUSTOM | |
| Compare two documents, combine | CUSTOM | Diff via `prosemirror-changeset` then emit as tracked changes |
| Protect: restrict editing, block authors, editing regions | CUSTOM + SERVER | ACL + ranges; OOXML `w:permStart` |
| Hide ink | n/a | |

## Word: View

| Feature | Tag | Notes |
|---|---|---|
| Print layout, web layout, read mode, outline, draft | CUSTOM (print layout = layout module) / CONFIG (web layout = plain flow) / CUSTOM (outline) / skip (draft) | |
| Focus, immersive reader | CONFIG | CSS modes |
| Ruler, gridlines, navigation pane | CUSTOM (ruler) / CONFIG (gridlines) / CONFIG (nav pane from headings) | |
| Zoom, 100%, one page, multiple pages, page width | CONFIG (CSS transform on page boxes) | |
| New window, arrange all, split, side by side, sync scroll | CONFIG (split editor views on same Y.Doc) / browser windows | |
| Macros | CUSTOM (sandboxed JS) or skip | Never VBA |
| Properties pane | CONFIG | |

## Word: Help

| Feature | Tag |
|---|---|
| Offline help pages, keyboard shortcuts reference, about | CONFIG (static bundled pages) |

---

## OnlyOffice-specific tabs (where they differ from Word)

### OnlyOffice: Home (extras)
| Feature | Tag |
|---|---|
| Nonprinting characters toggle | CONFIG |
| Paragraph advanced settings dialog (tabs, borders, fills, padding) | CONFIG + CUSTOM (tab stops need layout) |

### OnlyOffice: Insert (extras)
| Feature | Tag |
|---|---|
| Text Art | skip or CUSTOM (SVG text effects) |
| Smart Art | skip |
| Insert date/time field, content controls (forms) | CUSTOM (fields, `w:sdt` content controls) |

### OnlyOffice: Forms (Docxf)
| Feature | Tag |
|---|---|
| Text field, combo box, dropdown, checkbox, radio, image, date, signature, complex field, roles, fill mode | CUSTOM | Content controls (`w:sdt`) + form fill mode + role-based colouring. Sizeable module, 4–6 weeks |

### OnlyOffice: Layout (extras)
| Feature | Tag |
|---|---|
| Align / arrange / group / wrapping style buttons for objects | CUSTOM (same floating model as Word Layout) |

### OnlyOffice: References
Same as Word References. OnlyOffice also has Mendeley/Zotero plugins; skip or wire to a local Zotero instance later.

### OnlyOffice: Collaboration
| Feature | Tag | Notes |
|---|---|---|
| Fast vs Strict co-editing mode | CONFIG (fast = Yjs live) / CUSTOM (strict = paragraph locks + manual save) | Strict mode adds a lock layer on top of Yjs; ship Fast first |
| Add comment, remove comments, resolve | CUSTOM | |
| Track changes, display mode (markup, simple, final, original) | CUSTOM | Display modes = decoration/filter over suggestion marks |
| Accept/reject, previous/next change | CUSTOM | |
| Compare / combine | CUSTOM | |
| Chat pane | CONFIG (Y.Array of messages + awareness) | |
| Version history | CONFIG + SERVER | |
| Sharing settings | SERVER | |

### OnlyOffice: Protection
| Feature | Tag |
|---|---|
| Encrypt (password) | CUSTOM + SERVER (AES via WebCrypto, MIT-free; note OOXML agile encryption for .docx export) |
| Protect document (read-only, tracked changes only, comments only, forms only) | CUSTOM + SERVER |
| Add digital signature | CUSTOM (XAdES over OOXML is heavy; consider PDF signatures via `pdf-lib` + `node-forge` MIT instead) |

### OnlyOffice: View
| Feature | Tag |
|---|---|
| Headings pane, zoom, fit page/width, interface theme, dark document, toolbar/status bar/rulers toggles | CONFIG |

### OnlyOffice: Plugins
| Feature | Tag |
|---|---|
| Plugin system (macros, photo editor, translator, speech, OCR, YouTube...) | CUSTOM (sandboxed iframe plugin API with a small command surface) or skip. Most stock plugins need internet anyway |

---

## Where the time actually goes

| Workstream | Ribbon items it unlocks | Weeks |
|---|---|---|
| Layout module (pagination, sections, headers/footers, columns, floats, footnotes, page borders, watermark, line numbers, print, PDF) | Layout, Design, Insert (header/footer/page number/text box), References (TOC page numbers, footnotes), View (print layout), File (print/PDF) | 12–16 |
| OOXML codec (import/export, lossless unknown parts, styles, numbering, theme, comments, revisions, fields, content controls, charts, drawings) | File (open/save), everything round-tripping | 10–14 ongoing |
| Style + numbering + theme model | Home (styles, lists), Design | 4–6 |
| Track changes + comments + compare + display modes | Review, Collaboration | 6–8 |
| Fields engine (page numbers, TOC, captions, cross-refs, index, merge fields, date) | References, Mailings, Insert | 5–7 |
| Floating objects (images, shapes, text boxes, charts, ink) + arrange/wrap | Insert, Layout, Draw | 5–7 |
| Forms / content controls | OnlyOffice Forms, Word Developer | 4–6 |
| Protection, encryption, signatures | Protection, Review > Protect, File > Info | 3–4 |
| Ribbon shell, dialogs, panes, keyboard map, i18n (incl. Urdu RTL UI) | all tabs | 6–8 |
| Server: auth, ACL, docs/folders, versions, conversion worker, packaging | File, Collaboration, deployment | 6–8 |

Everything tagged OOB or CONFIG across all tabs together is roughly
6–8 weeks; it is the CUSTOM rows that define the project.
