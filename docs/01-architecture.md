# Building a Word-class Web Editor (Air-Gapped, No CDN, Multi-User)

Goal: a browser-based word processor comparable to MS Word / OnlyOffice, with
real-time multi-user collaboration, deployable on an air-gapped Linux server
and runnable locally on a Windows laptop, with no CDN and no licensing risk.

---

## 1. Licensing ground rules

"No licensing issues" for a product you control means: build only on
**permissive** licenses (MIT, BSD, Apache-2.0, ISC, MPL-2.0 file-level
copyleft, SIL OFL for fonts). Avoid GPL / AGPL / LGPL-in-bundle unless you
intend to open-source the whole product under the same license.

| Existing product | License | Verdict |
|---|---|---|
| OnlyOffice Document Server | AGPL-3.0 | Cannot copy code into a proprietary product. Whole product becomes AGPL if you fork it. Commercial license available. |
| Collabora Online / LibreOffice | MPL-2.0 (core) | Usable as a **separate process** (headless conversion) without copyleft spreading. Editor UI itself is server-rendered tiles; not a good base for a "from scratch" editor. |
| CKEditor 5 | GPL-2.0+ or commercial | Real-time collaboration, comments, track changes are **closed, paid** features. Not usable. |
| TinyMCE 7 | GPL-2.0+ or commercial | Same problem. Not usable. |
| Etherpad | Apache-2.0 | Fine license, but plain-text/HTML model with no page layout. Not a Word base. |
| Fidus Writer | AGPL-3.0 | Has ProseMirror track changes and comments, but AGPL. Reference only. |

Also: do not call the product "Word" and do not ship Microsoft fonts
(Calibri, Cambria, Times New Roman, Arial). Use metric-compatible OFL fonts
listed in section 4.

---

## 2. The two realistic architectures

### Option A: DOM-based editor on ProseMirror + Yjs (recommended starting point)

- Document model: ProseMirror schema, designed to mirror OOXML concepts
  (sections, paragraphs, runs, paragraph/character styles, tables, drawings).
- Rendering: `contenteditable` DOM. Browser does text shaping, line breaking,
  IME, accessibility, spellcheck underlines, right-to-left, Urdu/Arabic.
- Collaboration: Yjs CRDT via `y-prosemirror`.
- Pagination: a **view layer** that measures rendered blocks and splits them
  into page boxes (headers/footers/footnotes are laid out per page box).
- Strength: fastest path; 80% of Word features in months, not years.
- Weakness: pixel-exact pagination parity with Word is hard; widows/orphans,
  keep-with-next, floating images with text wrap, and columns require real
  layout code on top of the DOM.

### Option B: Canvas-based engine with your own layout (what OnlyOffice and Google Docs do)

- Own document model (OOXML-like), own text shaping/line breaking/hyphenation,
  own page layout, render to `<canvas>`, own cursor/selection/IME via a hidden
  textarea.
- Strength: full control, Word-level pagination fidelity, print == screen.
- Weakness: multi-year effort for a team. You reimplement everything the
  browser gives you for free (IME, accessibility, RTL/complex script shaping,
  find, spell underlines). Accessibility needs a parallel DOM anyway.

**Recommendation:** start with A, but design the document model as
OOXML-aligned from day one so `.docx` import/export is near-lossless. Build
pagination as a separate layout module reading from the model, so a later
canvas renderer (B) can replace the DOM view without changing the model,
collaboration, or file I/O.

---

## 3. Reference stack (all permissive licenses)

### Editor core
| Concern | Library | License |
|---|---|---|
| Editor engine, schema, transactions, undo, decorations | `prosemirror-*` (model, state, view, transform, commands, history, keymap, inputrules, tables, gapcursor, changeset) | MIT |
| Optional higher-level API on ProseMirror | Tiptap **core + open-source extensions only** (skip Tiptap Pro / Cloud) | MIT |
| Tables | `prosemirror-tables` | MIT |
| Change tracking primitives | `prosemirror-changeset` (build track-changes on top) | MIT |
| Math | MathLive (input) + KaTeX (render) | MIT |
| Charts | Chart.js or Apache ECharts | MIT / Apache-2.0 |
| Drawing/shapes | Own SVG nodes; `perfect-freehand` for ink | MIT |

Alternatives: Lexical (MIT, Meta) or Slate (MIT). ProseMirror is preferred
because `y-prosemirror` is the most mature CRDT binding and its schema
system maps well to OOXML.

### Collaboration
| Concern | Library | License |
|---|---|---|
| CRDT | Yjs | MIT |
| Editor binding | `y-prosemirror` | MIT |
| Server | Hocuspocus (Node, MIT) or `y-websocket` server | MIT |
| Presence (cursors, names) | Yjs Awareness (`y-protocols`) | MIT |
| Offline / local cache | `y-indexeddb` | MIT |
| Persistence | Store Yjs updates + periodic snapshots in PostgreSQL (or SQLite for the laptop build) | PostgreSQL / Public domain |
| Comments, suggestions, version history | Model as Yjs shared maps/arrays alongside the document | MIT |

CRDT (Yjs) over OT: no central transform server needed, offline merges work,
and every client can keep editing during network partitions, which matters
on an air-gapped LAN with flaky Wi-Fi.

### File formats
| Concern | Library | License |
|---|---|---|
| `.docx` read/write (own code) | Write your own OOXML parser/serializer over `fast-xml-parser` (MIT) or `sax` (ISC) + `fflate`/`jszip` (MIT) for the zip container | MIT/ISC |
| `.docx` write (bootstrap) | `docx` (npm) | MIT |
| `.docx` → HTML (bootstrap import) | `mammoth` | BSD-2 |
| Server-side heavy conversion (.doc, .odt, .rtf, PDF) | LibreOffice headless as a separate process | MPL-2.0 (not linked, no copyleft spread) |
| PDF export | Own layout → `pdf-lib` (MIT) or `pdfkit` (MIT); or print through headless Chromium (BSD) | MIT / BSD |
| Images | `sharp` (Apache-2.0) server side; browser `<canvas>` client side | Apache-2.0 |

Own OOXML I/O is the piece that makes or breaks "Word-like": OOXML
(ECMA-376 / ISO 29500) is an open spec, and Microsoft's Open Specification
Promise covers implementing it.

### Text, fonts, language
| Concern | Choice | License |
|---|---|---|
| Serif (Times New Roman metric-compatible) | Liberation Serif | OFL |
| Sans (Arial metric-compatible) | Liberation Sans | OFL |
| Mono (Courier New metric-compatible) | Liberation Mono | OFL |
| Calibri metric-compatible | Carlito | OFL |
| Cambria metric-compatible | Caladea | OFL |
| Urdu / Arabic | Noto Nastaliq Urdu, Noto Naskh Arabic | OFL |
| Wide Unicode coverage | Noto family | OFL |
| Spellcheck | `nspell` (MIT) with Hunspell `.dic/.aff` files (most are LGPL/MPL/BSD; check each language) | MIT + per-dictionary |
| Hyphenation | `hyphen` / `hypher` with TeX patterns | MIT / LGPL patterns; check per language |
| Server-side shaping (if you go canvas) | HarfBuzz via `harfbuzzjs` (WASM) | MIT |
| Font parsing / metrics | `opentype.js` or `fontkit` | MIT |

Bundle all fonts as local `.woff2` and `.ttf` files. No Google Fonts links.

### Platform
| Concern | Choice | License |
|---|---|---|
| UI framework | React + Vite (already in this repo) + shadcn/ui + Radix | MIT |
| Backend | Node.js (or Bun) + Fastify/Hono | MIT |
| Database | PostgreSQL on the server; SQLite (`better-sqlite3`, MIT) on the laptop | PostgreSQL license / public domain |
| File storage | Local disk or MinIO (AGPL, keep as separate service) or SeaweedFS (Apache-2.0) | see note |
| Auth | Own users table + Argon2 (MIT) + JWT; optional Keycloak (Apache-2.0) for LDAP/AD | MIT / Apache-2.0 |
| Windows desktop wrapper | Tauri (MIT) or Electron (MIT); or plain "run the Node service + open browser" | MIT |
| Packaging | Docker image / tarball with vendored `node_modules` and a bundled Node runtime | n/a |

---

## 4. High-level architecture

```
┌──────────────────────────────── Browser ────────────────────────────────┐
│  React shell (ribbon, panes, dialogs)                                    │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ Editor: ProseMirror view  ← schema (OOXML-aligned)               │   │
│  │   plugins: history, tables, comments, track-changes, find, math  │   │
│  │   layout module: paginates blocks → page boxes, headers/footers, │   │
│  │                  footnotes, columns, page numbers                │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│  Yjs Y.Doc  ←→ y-prosemirror  ←→ y-indexeddb (offline)                   │
│  Awareness (cursors)     Comments/suggestions in Y.Map/Y.Array           │
│  File I/O in a Web Worker: OOXML parse/serialize, PDF export             │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ WebSocket (Yjs sync + awareness)  /  HTTPS (REST)
┌───────────────────────────────┴──────────────────────────────────────────┐
│  Node service (single binary/tarball, no external network)               │
│   • Hocuspocus / y-websocket: rooms per document, auth hook              │
│   • Persistence: Yjs updates + snapshots → PostgreSQL / SQLite            │
│   • REST: documents, folders, sharing/ACL, versions, comments export      │
│   • Conversion worker: LibreOffice headless (optional, separate process)  │
│   • Static assets: app bundle, fonts, dictionaries (served locally)       │
└──────────────────────────────────────────────────────────────────────────┘
```

Key design rules:

1. **Model first.** The ProseMirror schema is the single source of truth and
   mirrors OOXML: `document > section* > (paragraph | table | sdt)*`,
   paragraph has `pPr` attrs (style, alignment, spacing, indents, numbering,
   keep-with-next, page-break-before), text marks carry `rPr` attrs (font,
   size, bold, italic, colour, highlight, underline, strike, sub/sup, lang).
   Styles live in a separate Y.Map (`styles.xml` equivalent). Numbering
   definitions likewise (`numbering.xml`). Section properties hold page size,
   margins, orientation, columns, header/footer references.
2. **Layout is a pure function** `(model, fonts, pageSetup) → pages[]`.
   Implement it against the DOM first (measure with `Range.getClientRects`),
   keep the interface renderer-agnostic.
3. **Everything collaborative lives in the Y.Doc**: body, styles, numbering,
   comments, suggestions, headers/footers. One Y.Doc per document. Version
   history = stored Yjs snapshots with author and timestamp.
4. **Track changes** = suggestion marks (`insertion`, `deletion`, `formatChange`)
   with author/date attrs, applied by a ProseMirror plugin that intercepts
   transactions when "Track Changes" is on. Accept/reject rewrites marks.
   Maps 1:1 to OOXML `w:ins` / `w:del` / `w:rPrChange`.
5. **Comments** = a mark carrying a comment id + a Y.Map of threads. Maps
   to `comments.xml` + `commentRangeStart/End`.
6. **File I/O is lossless-first:** unknown OOXML parts and attributes are
   preserved as opaque blobs and written back on export, so round-tripping a
   Word file through your editor does not destroy what you do not yet render.

---

## 5. Feature map → implementation

| Word feature | Where it lives | Notes |
|---|---|---|
| Character/paragraph formatting | Marks + paragraph attrs | Ribbon buttons dispatch ProseMirror commands |
| Styles (Normal, Heading 1…), style inheritance | Styles Y.Map, resolved at render/layout | Implement `basedOn` chain resolution like Word |
| Bullets/numbering, multi-level lists | Numbering definitions + `numPr` on paragraphs | Do **not** use nested `<ul>`; Word lists are flat paragraphs with `ilvl` |
| Tables (merge, borders, widths, repeat header) | `prosemirror-tables` + OOXML `tblPr/tcPr` attrs | Extend with cell margins, vertical merge, autofit |
| Images, wrap text, positioning | `drawing` node (inline / anchored) | Floating wrap needs the layout module |
| Headers/footers, first/odd/even | Section props + separate sub-docs in Y.Doc | Rendered per page by layout module |
| Page setup, margins, orientation, columns | Section props | |
| Page numbers, dates, fields, TOC | `field` node with instr text + cached result | Recompute on demand, like Word's F9 |
| Footnotes/endnotes | `footnote` node + per-page layout | |
| Find & replace | ProseMirror search plugin (write your own, MIT ones exist) | |
| Spell & grammar check | Web Worker with `nspell`; decorations for underlines | Grammar: rule-based (LanguageTool is LGPL, run as separate service if wanted) |
| Comments | Mark + Y.Map threads | |
| Track changes | Suggestion marks + plugin | |
| Real-time co-editing, cursors | Yjs + Awareness | |
| Version history, restore | Yjs snapshots | |
| Permissions (view/comment/edit) | Server ACL enforced in the Hocuspocus `onAuthenticate`/`onChange` hooks | Read-only clients get a read-only Y.Doc |
| Math equations | MathLive/KaTeX node; export to OMML | |
| Hyperlinks, bookmarks, cross-references | Marks/nodes with ids | |
| Mail merge, macros | Later; macros = sandboxed JS, never VBA | |
| Print, PDF export | Layout module → `pdf-lib` or headless Chromium | |
| Open/save `.docx` | Own OOXML codec in a Worker | The biggest single workstream after the editor |
| Open `.doc`, `.odt`, `.rtf` | LibreOffice headless conversion to `.docx` on the server | Optional |
| RTL, Urdu/Arabic | Browser shaping + `bidi` paragraph attr; Noto Nastaliq | Test early; it affects layout |

---

## 6. Air-gap and Windows deployment

- **No runtime network calls.** Audit with a CSP `default-src 'self'` and a
  build-time check that no `http(s)://` URL appears in the bundle.
- **Vendor everything:** commit a lockfile, build with an offline registry
  mirror (Verdaccio, MIT) or ship `node_modules` in the artifact. Fonts,
  dictionaries and hyphenation patterns are static files served by the app.
- **Linux server:** one tarball or Docker image containing Node runtime, app
  bundle, PostgreSQL client, and optional LibreOffice. Systemd unit for the
  service. Reverse proxy optional (Caddy, Apache-2.0).
- **Windows laptop:** same Node service with SQLite instead of PostgreSQL,
  started by a small launcher (Tauri, MIT) that opens the UI in a WebView2 or
  the default browser. Collaboration still works over LAN if the laptop is
  the host.
- **Updates:** signed tarballs carried in by USB; schema migrations run on
  start.

---

## 7. Phased plan

| Phase | Deliverable | Rough effort (2–3 engineers) |
|---|---|---|
| 0 | OOXML-aligned schema, styles/numbering model, design docs, font bundle, offline build pipeline | 3–4 weeks |
| 1 | Core editor: formatting, styles, lists, tables, images, undo, find/replace, keyboard parity with Word | 8–10 weeks |
| 2 | Collaboration: Yjs, Hocuspocus server, auth, ACL, presence, offline cache, version history | 4–6 weeks |
| 3 | `.docx` import/export (own codec, lossless round-trip of unknown parts) | 8–12 weeks, ongoing |
| 4 | Page layout: pagination, headers/footers, sections, columns, footnotes, page numbers, print/PDF | 10–14 weeks |
| 5 | Comments + track changes (with OOXML mapping) | 6–8 weeks |
| 6 | Spellcheck, math, fields/TOC, hyperlinks/bookmarks, RTL polish | 6–8 weeks |
| 7 | Packaging: air-gap tarball, Docker, Windows launcher, migrations, docs | 3–4 weeks |

A usable "collaborative Word-lite with real .docx support" is ~9–12 months.
Full Word parity is a multi-year product; OnlyOffice has 10+ years in it.
If time-to-value matters more than "from scratch", the fallback is
Collabora Online (MPL-2.0, self-hostable offline) behind your own UI.

---

## 8. Suggested repo layout

```
word-editor/
  packages/
    model/        # ProseMirror schema, styles, numbering, section props (pure TS)
    layout/       # pagination engine: (doc, fonts, pageSetup) -> pages
    ooxml/        # .docx codec (parser + serializer), runs in a Worker
    editor/       # ProseMirror plugins: commands, tables, comments, track changes, find
    collab/       # Yjs bindings, awareness, offline cache
    ui/           # React ribbon, dialogs, panes (shadcn/ui)
    fonts/        # OFL fonts, dictionaries, hyphenation patterns
  apps/
    web/          # Vite app
    server/       # Node: Hocuspocus, REST, persistence, conversion worker
    desktop/      # Tauri launcher for Windows
  deploy/
    docker/ systemd/ windows/
```

Start with `model`, `editor`, `collab` and a throwaway HTML export; add
`ooxml` and `layout` as soon as the schema stabilises, because both depend
on it and both will push changes back into it.
