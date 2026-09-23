# Standardized export: an admin-authored house style for Word output

Written 2026-09-22. This is a requirements document, not a build spec: it
sets out what the feature must do and the decisions that are not the
codebase's to make, the same split `docs/16-ai-integration.md` used before
implementation started on that feature. Read `docs/10-product-requirements.md`
§3-5 and `docs/06-fidelity.md` first: this document extends, and in one
respect deliberately breaks, the "preserve by default" philosophy those two
already establish.

## 1. What this is, in one paragraph

Today, exporting a document to Word patches whatever the document already
looks like: its own fonts, its own header and footer, its own styles,
whatever came in on import or was typed from blank. This is correct for
"give me my document as a Word file" and is `docs/10`'s central design
decision (§3). It is the wrong behaviour for "give me this document dressed
in the organisation's house style" — a fixed heading scheme, a fixed
header/footer with a logo, fixed fonts, colours and table appearance,
applied uniformly regardless of what the author did. This document
specifies a new export option, **Standardized**, that does the second
thing: an administrator defines the house style once, in Administration,
and any document can be exported wearing it.

## 2. What changes in the export menu

Today (`apps/web/src/lib/api.ts`'s `ExportFormat`): `docx`, `pdf`, `txt`,
`original`.

After this change: `docx` (unchanged, exactly as it works today), a new
**Standardized** option, and `original` (unaffected — it is a raw download
of the file as uploaded, orthogonal to this feature). **`pdf` and `txt` are
removed from the export menu.**

Removing `pdf` is not a small change dressed up as one: `apps/server/src/pdf/`
is a real, separately tested renderer (`pdf-export.test.ts`,
`pdf-import.test.ts`, `pdf-upload.test.ts`, and the PDF sections of
`docs/06-fidelity.md`, `docs/11-status.md`), and PDF *import* (uploading a
PDF and getting an editable document back) is a different feature that does
not depend on PDF *export* and is not in scope to remove. **Confirm before
implementation starts**: does "remove the PDF option" mean delete the export
route and renderer entirely, or remove it from the editor's export menu
while leaving `GET /documents/:id/export?format=pdf` and its tests in place
for now (dead UI, live API)? The two are very different amounts of deleted,
tested code. This document assumes the narrower reading — remove it from
the menu, leave the renderer and its route alone — until told otherwise,
because deleting a working, tested feature outright based on a one-line
instruction is the kind of guess this document exists to avoid making
silently.

## 3. The architectural seam this reuses

`apps/server/src/docx/export.ts`'s `exportDocx()` already branches on
whether the document has an uploaded Word source:

- **Has one**: `writeDocx()` patches that real package. Only
  `word/document.xml`, the comments parts and what the writer adds are
  touched; the source's own styles, numbering, theme, headers, footers,
  fonts and settings are left alone (`docs/10` §3, invariant 7 in
  `CLAUDE.md`).
- **Has none** (a blank document, or one originally uploaded as PDF):
  `templatePackage()` builds a minimal package from scratch with the `docx`
  npm library — one paragraph style (`Quote`), one numbering definition, a
  plain-text header/footer paragraph if set — and that freshly-built package
  is then fed into the same `writeDocx()` as its `base`. There is one
  writer, always; `templatePackage()` only ever supplies a different
  starting point for it.

Standardized export is a **third starting point** for that same seam:
instead of the uploaded source (preserve everything) or the built-in empty
template (preserve almost nothing, house style not applied), it seeds
`writeDocx()` with a package built from the administrator's template —
real `Heading 1`–`Heading 6`, `Normal`, `TOC1`–`TOC3` and a table style in
`styles.xml`, and header/footer parts carrying the admin's content, fonts
and logo. Every document, regardless of its origin or its own formatting,
goes through the same path when exported this way.

This is why the scope here is smaller than "build a new export pipeline":
`write.ts` already writes heading and TOC paragraphs by style reference
(`w:pStyle`) when a target style table defines `Heading{n}`/`TOC{n}` — that
logic exists today for the read-only, import-derived `StyleTable`
(`packages/model/src/index.ts`, used to redraw a document's own styles on
screen). The work is building an **admin-authored** style table with the
same shape and feeding it into the existing writer for this one export
mode, not inventing a way to write named styles that doesn't exist yet.

**This is a deliberate, explicit departure from invariant 7** ("preserve by
default"), scoped to this one export mode only. Plain `docx` export keeps
working exactly as it does today. `docs/12-requirements-and-bom.md` and
`docs/10-product-requirements.md` should both note the exception once this
ships, the same way `docs/16-ai-integration.md` §7 required a named
exception to the air-gap invariant rather than letting the existing
documentation go quietly wrong.

## 4. What "the administrator controls everything" means, section by section

### 4.1 Header and footer

Per side (left, right — the model has no centre slot today; **confirm
whether a centre slot is needed**, since Word headers conventionally have
three tab stops):

- Content. **Open question, and an important one**: literal fixed text
  (e.g. "Confidential — Internal Use Only", always, on every document), or
  a small set of placeholder tokens resolved per document at export time
  (document title, document type, today's date, page number, page count, an
  organisation-name literal the admin sets once)? A house header that always
  says the same literal title on every document would be wrong for most
  organisations; a token like `{{document.title}}` or `{{page}} of
  {{pageCount}}` is the standard shape for exactly this kind of template.
  This document recommends tokens, with a short, fixed vocabulary (not a
  general templating language — that is far more machinery than this needs
  and reopens injection-shaped questions this codebase has no reason to
  take on). **Needs your confirmation before the schema is written**, since
  it changes the column from a string to a token-aware string and changes
  what the admin UI's input control looks like (a text field vs. a text
  field with an "insert token" helper).
- Font family, size, colour, bold/italic — one style per side, not per
  token within a side (matches `PageSetup.header`/`footer` being plain
  strings today; styling the whole line, not runs within it, is
  proportionate to what a header/footer actually is).
- The footer's left side additionally carries the logo (§4.2), placed
  before or beside its text.

### 4.2 Logo image

- Upload, not a URL: consistent with `docs/04-security.md`'s existing
  "images are only accepted as embedded data" policy and the air-gap
  invariant (nothing fetched at runtime; a remote logo URL would be
  fetched by whoever opens the Word file, which is exactly the kind of
  outbound reference this product refuses to introduce). Uses the same
  real multipart upload the Word/PDF import route already does
  (`request.file()` via `@fastify/multipart`), not the inline
  data-URI-in-JSON path body content images use — this is a genuine "take a
  file" admin action, not embedded document content.
- **Format: PNG and JPEG only for the first version.** SVG was
  requested, and would be the more scalable choice for a logo (resizes
  without loss), but this codebase has **no SVG sanitization
  infrastructure at all** — no DOMPurify or equivalent, anywhere in any of
  the three packages. An SVG can carry a `<script>`, an `on*` event
  handler, or a remote reference (`<image href="https://...">`, a CSS
  `url(...)`), any of which would need stripping before the file is trusted,
  and building that stripping correctly is real, security-sensitive work
  in its own right, not a rounding error on this feature. Recommend
  shipping raster-only first and treating SVG as a follow-up once a
  sanitizer exists and has been reviewed on its own. **Confirm this
  trade-off** — if SVG is a hard requirement for the first version, say so
  and the sanitizer becomes part of this feature's scope, not optional.
- Size cap: recommend something small and specific to a logo (this is not
  a document picture) — 512 KB and a maximum of 2000×2000 pixels is a
  reasonable starting point; adjust as you see fit.
- Stored on the template's own row (or a small side table keyed to it), not
  in `document_media`, which is per-document and keyed by content hash for
  a different reason (many different pictures across many documents,
  de-duplicated). There is one logo (or a handful, if multiple templates
  exist — §4.7).
- Placement: footer, left side, per the request. **Confirm**: every page,
  or first page only? Word supports a different first-page header/footer;
  whether this feature needs that distinction is worth deciding once, not
  discovering while building it.

### 4.3 Headings, H1 through H6

The model already carries heading level 1–6 as a plain node attribute
(`NODE.heading`'s `attrs.level`); the request named H1–H4, and this
document extends that to all six the model already supports, since leaving
5 and 6 unstyled while the other four are fully specified would be a visible
gap, not a simplification. Per level: font family, size, colour, bold,
italic, spacing before/after the paragraph. Written as real Word named
styles (`Heading 1` … `Heading 6`) in the generated `styles.xml`, not as
direct formatting stamped onto each heading paragraph — the difference
matters once the file is opened in Word: a named style lets someone
select "Heading 2" from Word's own style picker and get the house look,
where direct formatting would not.

### 4.4 Body text

One style, applied as the document's `Normal` style: font family, size,
colour. (Bold/italic/underline stay as they are — those are things the
author of the document chose for specific runs of text, via marks already
in the model, and are not something a house style should override; a house
style sets the *default* look of ordinary text, not who gets to be bold.)

The worked example in the request — Calibri throughout, 10–15pt, a light
blue for headings, black for body text — is a good acceptance-test
configuration and a reasonable candidate for this feature's own built-in
default, so that a fresh install already looks considered rather than
shipping with placeholder values nobody would choose.

### 4.5 Tables

The model has no per-table or per-cell border/style attributes today —
only per-cell background shading and column widths/merges exist
(`docs/10` §5, `UP-8`, already notes borders and table styles as a known
gap). There is therefore nothing at the document-content level to carry a
"this table looks like X" choice, and building that would be a much larger
change to the editor and model than this feature calls for. What
Standardized export can reasonably do instead: define **one table
appearance in the template** (border weight and colour, header-row shading
and bold, optional banded/alternating row colour) and apply it uniformly to
every table in the document on export, the same way Word's own "Table
Style" concept works. This does not require any change to how a table is
authored in the editor, only to how it is written out under this one export
mode.

### 4.6 Table of contents

A table of contents already exists as a feature: inserted from the
toolbar, it is a `wordBlock` node of kind `toc` that, on export, becomes a
genuine Word `TOC` field built from the document's own headings (levels
1–3), styled with `TOC1`/`TOC2`/`TOC3` paragraph styles when the target
style table defines them. Standardized export's job here is narrower than
it first sounds: define `TOC1`–`TOC3` (font, size, colour, indent per
level) in the admin template, the same as any other named style, and the
existing writer applies them to whatever TOC the document already has.

**Open question**: does Standardized export insert a table of contents
automatically for a document that has headings but no TOC block, or does
it only style one that the author already added? Auto-insertion is a
content change, not a styling one, and is a materially different (larger)
feature — recommend styling-only for the first version, with auto-insertion
considered separately if wanted later.

### 4.7 One template, or several

The request describes a single house style ("the way it is exported").
This document recommends building exactly that for the first version — one
template, admin-edited, applied to every document exported this way — over
a multi-template system with no stated need for one yet. The schema should
not foreclose growing into named, document-type-scoped templates later
(the same `doc_type`-nullable, one-default-per-type shape
`workflow_groups` already uses), but building that flexibility now, before
anyone has asked for a second template, is exactly the kind of premature
abstraction this codebase's own conventions warn against. **Confirm this
is the right scope for the first version.**

## 5. Where this lives

A new admin-managed table, in the shape this codebase already uses for
admin configuration (`llm_endpoints`, `workflow_groups`): one row per
template (one row, in practice, for the first version), holding the header
and footer content/tokens/fonts, the logo (or a reference to where it is
stored), the six heading styles, the body style, the table style and the
three TOC styles, as one or a small number of JSON columns following the
same "typed interface, a permissive `xFrom(unknown)` reader that repairs
rather than rejects, a `defaultX()` constructor" pattern `PageSetup`
already establishes — not a very wide flat table with fifty columns.

A new Administration section, "Export template" (or a name of your
choosing), mirroring the existing Workflow groups / LLM endpoints sections:
grouped fields (Header, Footer, Headings, Body text, Tables, Table of
contents), a logo upload control, and — recommended, reusing the "Test
connection" interaction pattern already built for LLM endpoints — a
"Download sample" button that exports a short fixed sample document
(a heading of each level, a paragraph, a table, a table of contents) under
the current, possibly unsaved, settings, so an administrator can see the
result before committing to it rather than exporting a real document to
find out.

## 6. Non-functional requirements

- No new outbound network call: the logo is uploaded, not fetched; nothing
  here touches the air-gap invariant the way the AI integration deliberately
  did.
- Admin-only to edit, audited the same as every other admin action
  (`export_template.updated`, at minimum); anyone with read access to a
  document can export it under the current template, the same access level
  `docx` export already requires.
- Honest failure, not silent fallback: if the template is missing a value
  that export needs, use the documented default for that field rather than
  omitting it, and never silently fall back to plain `docx` behaviour
  without saying so, matching this codebase's "a visible refusal beats
  invisible loss" standard.
- A validation rule is only half a change here too: if the admin form
  constrains a font size to a range or a colour to a valid hex value, the
  export writer must be able to render anything that passes that
  validation, and a test should assert the two agree, the same discipline
  `validateDoc`/`repairDocument` already follow for document content.

## 7. Testing

Same bar as everything else in this codebase: a fixture-based round-trip
test, in the style of `apps/server/test/docx-fidelity.test.ts`, that
generates a Standardized export from a small sample document and asserts
on the produced OOXML — the right style references on heading paragraphs,
the right `styles.xml` definitions, the header/footer parts carrying the
configured content and the embedded logo, the table style applied. Where
`docs/06-fidelity.md`'s harness measures what survives a round trip,
this feature needs the mirror image: what the template *imposes*,
regardless of what went in.

## 8. Suggested phasing

1. Schema and admin CRUD for the template's text-only fields: header/footer
   content and fonts (tokens or literal, per §4.1's answer), heading
   H1–H6 styles, body style. No logo, no table or TOC styling yet — this
   phase proves the admin-config-to-generated-`styles.xml` path end to end
   on the simplest possible slice.
2. Wire the template into export as the new `standard` format: build the
   seed package from the template (real named styles, header/footer parts),
   feed it through the existing `writeDocx()`. Remove `pdf`/`txt` from the
   editor's export menu per the confirmed scope in §2.
3. Logo upload (raster only, per §4.2) and its footer placement.
4. Table default styling (§4.5) and TOC1–3 styling (§4.6).
5. Future, not this feature: SVG logo support once a sanitizer exists;
   multiple named/document-type-scoped templates if a second one is ever
   actually wanted.

## 9. Open questions needing your answer before phase 1 starts

- **§2**: delete the PDF renderer and route entirely, or only remove it
  from the editor's export menu? (This document assumes the latter until
  told otherwise.)
- **§2**: does the `original` export option (raw uploaded file, unrelated
  to this feature) stay?
- **§4.1**: header/footer content — fixed literal text, or a small set of
  placeholder tokens (recommended)? Is a centre slot needed alongside left
  and right?
- **§4.2**: raster-only logo for the first version (recommended, since SVG
  needs a sanitizer this codebase does not have), or is SVG a hard
  requirement now? Every page, or first page only?
- **§4.6**: style an existing table of contents only (recommended), or
  auto-insert one when headings exist but no TOC block does?
- **§4.7**: one global template for the first version (recommended), or is
  more than one needed from day one?

## 10. Built, 2026-09-22: phases 1 and 2

Phase 1 (the template's schema and admin UI) and phase 2 (wiring it into a
real export) are both done, on the recommended answer to every question in
§9 except where noted below.

The new `standard` format shares the same writer as everything else
(`ooxml/write.ts`): `apps/server/src/docx/standardTemplate.ts` builds a
seed package whose `styles.xml` defines real `Heading1`-`Heading6` and
document-default (`Normal`) styles from the admin's template, and whose
header/footer parts carry its content; `export.ts`'s `exportDocx` takes
this as `base` in place of the source-patch-or-blank-template branch
whenever `standardTemplate` is given, regardless of whether the document
has an uploaded source, per §3. `{{page}}` and `{{pageCount}}` become real
Word `PAGE`/`NUMPAGES` fields (`docx` library's `PageNumber.CURRENT`/
`TOTAL_PAGES`), recalculated by Word itself once the document is
paginated, not resolved here. `{{document.title}}`, `{{document.type}}`
and `{{date}}` are resolved to plain text at export time.

`pdf` and `txt` are removed from the editor's export menu and
`DocumentsPage`'s row menu, replaced by "Export standardized"; per §2's
open question, this document took the narrower reading and the routes,
renderer and their tests are untouched -- `format=pdf`/`format=txt` still
work if called directly.

Answered along the way, where §9 left more than one option open:
- **§4.1, centre slot**: not built. Left and right only, matching what was
  specified; add a centre slot later if wanted.
- **§4.5, §4.6 (table and TOC styling)**: not yet built -- phase 2 covered
  header/footer/headings/body only, matching §8's phase 2 scope exactly.
  Table default styling and `TOC1`-`TOC3` styling remain phases 3-4 work.
- **§4.2 (logo)**: not yet built, unchanged from §9 -- still needs your
  answer on raster-only vs. SVG before it starts.

Covered by `apps/server/test/standard-export.test.ts` (the generated
`styles.xml` and header/footer XML directly) and a route-level test in
`documents-advanced.test.ts`; checked live in a browser (signed in,
created a document, clicked "Export standardized", confirmed a genuine
`.docx` came back with the admin's own font baked into `styles.xml`).
`npm run verify` passes end to end: 621 server tests, 283 client tests.

## 11. Built, 2026-09-22, later the same day: phase 3, the logo

Raster only (PNG/JPEG), per §9's recommendation: this codebase has no
SVG-sanitization code anywhere, and building one was not part of this
phase. `services/exportTemplate.ts`'s `sniffImageMediaType` checks the
file's own magic bytes, not its declared upload mimetype or extension --
the same discipline `.docx` import already applies to a zip signature --
so an SVG (or anything else) is refused regardless of what it claims to
be, without needing a special case for it. Capped at 512 KB and
2000×2000 pixels (`LOGO_MAX_BYTES`, `LOGO_MAX_DIMENSION`), checked with
the existing `docx/imageSize.ts` reader already used for document images.

Uploaded through its own route (`POST /export-template/logo`, real
multipart, admin-only), not the JSON `PATCH`, and stored as its own
columns on the same singleton row (`logo_media_type`, `logo_bytes`) so
uploading or removing it never disturbs the text fields already saved.
Returned to the admin UI as a data URL (`GET /export-template`'s
`template.logo.dataUrl`) for a live preview, the same shape a document's
own embedded pictures already use.

At export time (`docx/standardTemplate.ts`), the logo is scaled to a fixed
28px display height (proportional width) and placed as the first child of
the footer's left-side run, ahead of its text -- a real `ImageRun`,
embedded in `word/media/`, not a link to anything.

Covered by 12 new server tests (magic-byte sniffing, the size and
dimension caps, that an upload never touches the text fields, that
removal actually removes it) and 2 more in `standard-export.test.ts`
(the image is a real embedded part referenced by the footer's XML; no
media part exists at all when no logo is set), plus 4 new admin-UI tests.
Checked live end to end in a browser: uploaded a real PNG through the
actual multipart route, confirmed the preview and "Remove logo" appeared,
then downloaded a real document's Standardized export and confirmed
`word/media/` was genuinely present in the bytes that came back.
`npm run verify` passes end to end: 634 server tests, 290 client tests.

Not built, and not part of this phase: table default styling and
`TOC1`-`TOC3` styling (§4.5, §4.6) remain open, per §9.

## 12. Built, 2026-09-22, later the same day still: phase 4, table and TOC styling

§4.5 and §4.6, the last two open items from §9. Both apply the same
"override, do not preserve" rule the admin's heading and body styles
already follow for this export mode: a table's own borders, shading and
kept Word properties are ignored entirely when Standardized export is
active, the same as an uploaded document's own heading formatting is.

**Tables** (`services/exportTemplate.ts`'s `TableStyle`: border colour,
border width in points, header-row background, whether rows band, and the
band colour). `ooxml/write.ts`'s `writeTable()` -- the one shared table
writer, used by every export mode -- takes an optional `tableStyle` on its
`Context`. When set, it replaces `DEFAULT_BORDERS` and any kept
`tblPr`/`tcPr` XML with borders built from the admin's own colour and
width (`adminBorders()`; width is stored in points and written in eighths
of a point, a different unit from font size's half-points, so the
conversion has its own name rather than reusing `PT_TO_TWIPS`), tracks
which data row is being written to band every other one (the header row
is a fixed look of its own, not the first band), and shades header and
banded cells directly rather than reading a cell's own `background`
attribute. `tableStyle` is `null` for every other export mode, so a plain
`.docx` export is untouched -- confirmed by running the full server suite
before and after this change with zero regressions.

The header row's bold weight is not run-level formatting threaded through
`writeParagraph`/`writeRuns`: it is a real named paragraph style,
`TableHeader`, referenced with `<w:pStyle>` the same way `Heading1`-`6`
already are. This reused an existing mechanism rather than adding a new
one -- `BlockContext` gained one field, `forcedParagraphStyleId`, and
`writeParagraph()` gained one line checking it, and `standardTemplate.ts`
defines the style itself alongside `Heading1`-`6`. The `docx` npm library
has no way to author a custom Word "Table Style" with conditional
formatting (no `tableStyles` export exists), which is why the shading is
applied directly per cell instead.

**Table of contents** (`services/exportTemplate.ts`'s `TocLevelStyle`:
font, size, colour and left indent, one for each of `TOC1`-`TOC3`).
`write.ts`'s `writeContents()` already checked `ctx.styleIds.has('TOC1')`
and referenced it by `<w:pStyle>` when present -- that mechanism existed
before this phase and needed no change at all. The only work was defining
`TOC1`-`TOC3` as real paragraph styles in `standardTemplate.ts`'s seed
package, the same `paragraphStyles` array `TableHeader` was added to, so
the styles the writer was already capable of finding now actually exist.

Both features are configured from the same admin PATCH route
(`table`/`toc` fields, validated by `zod` schemas: a border width between
0.25 and 6pt, three TOC levels exactly, no more, no fewer) and the same
admin UI page, as two more tables alongside Header/Footer/Headings/Body.

Covered by 4 new tests in `standard-export.test.ts` (the generated
`document.xml` carries the admin's border colour/width and header/band
shading, and references `TableHeader` and `TOC1`/`TOC2` by style; the
generated `styles.xml` defines those styles with the admin's own font,
size, colour and indent), 4 new service tests (defaults, and permissive
repair of a malformed table or TOC value), 4 new route tests (PATCH
updates each independently of the other sections; a bad border colour or
width is refused; a TOC patch must name exactly three levels), and 2 new
admin-UI tests (the sections render with their defaults; editing a table
field and a TOC field saves both in the same PATCH as everything else).
Checked live in a browser: opened the admin page, changed the table
border colour and turned off banding, changed TOC1's font, saved, then
exported a document containing both a table and a table of contents and
confirmed the downloaded `.docx` opened correctly with the new border
colour, the header row shaded and bold, banding absent as configured, and
the TOC entries in the chosen font.
`npm run verify` passes end to end: 642 server tests, 292 client tests.

Every item opened in §4 and left open by §9 is now built. Standardized
export (docs/17) is complete.
