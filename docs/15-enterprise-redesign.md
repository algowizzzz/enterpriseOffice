# The enterprise-grade pass: DocAI

Written 2026-09-22, at the user's direction, as a plan only. Nothing in this
document has been built. It exists so the next several sessions of UI work
have a destination and an order, instead of each one guessing.

## Where this leaves off

`docs/14-word-like-shell.md` covers what already shipped this week: icons
throughout, a File tab, an overflow menu per document row. That work made
the interface less clunky. It did not make it look like a product built to
sell against ServiceNow or Atlassian, which was the actual complaint, and
which needs more than icons: a real design system, a reconsidered
information architecture, and a name.

## 1. The name: DocAI

Renaming touches more than the logo. An honest list of what "call it DocAI"
means, so it is done once, correctly, rather than half-done twice:

- The brand string in the client: `<title>`, the sign-in page, the nav bar
  (`apps/web/src/App.tsx`, `SignInPage.tsx`, `index.html`).
- `package.json`'s `name` field, currently `docforge`, which feeds the
  release archive's filename (`docforge-<version>-<date>-<sha>-<platform>`)
  and the workspace package names (`@docforge/model`, `@docforge/web`,
  `@docforge/server`) — an internal rename touching every import statement,
  worth doing with a scripted find-and-replace and `npm run verify` after,
  not by hand.
- Every doc: `HANDOVER.md`, `CLAUDE.md`, `docs/*.md` all say "DocForge" in
  prose, sometimes in a sentence that reads oddly with a different noun
  ("DocForge is a browser-based word processor..."). These need rewriting,
  not just find-and-replace, since several are written as if "DocForge" is
  being introduced for the first time.
- The database file name (`docforge.db`) and environment variable prefix
  (`DOCFORGE_*`, a dozen of them across the server, the deploy scripts and
  the docs) — renaming these breaks every existing install's config and
  scripts on upgrade, so this needs either a migration note or (more likely)
  keeping `DOCFORGE_*` as the internal/technical name while `DocAI` is only
  the product-facing brand, the way a company's product name and its
  internal system name often differ. Recommend the latter: it is
  dramatically less risk for zero user-visible cost, since nobody reading
  the UI sees an environment variable name.
- The GitHub repository name (`enterpriseOffice`) is a separate decision
  from the in-product name and does not need to change for this.

**Recommendation:** do the rename as the last step of the visual redesign
below, not the first — renaming the brand string is a five-minute change
once the new interface exists to put it in; renaming it into the current
interface and then redesigning around it is two changes to the same
surface. The internal package/env names should very likely never change.

## 2. A design system, not an icon pass

Checked against two real references before proposing anything, since this
is exactly the kind of claim that should not be asserted from memory:

- **[Atlassian Design System](https://atlassian.design/foundations/tokens/design-tokens)**
  (Apache-2.0, @atlaskit on npm): tokens are named
  `foundation.property.modifier` — `color.text`, `color.icon.success` — so a
  token's name says what it is *for*, not what it *is*. That is what makes a
  design system survive a redesign: change what `color.background.brand`
  points at once, and every component that used it changes with it, instead
  of a search-and-replace across hundreds of hard-coded hex values.
- **ServiceNow's Now Design System**: enterprise-grade in practice mostly
  means information density done deliberately — compact rows, a clear
  hierarchy between primary and secondary actions (exactly what the
  overflow menu shipped this week starts to do), and status communicated by
  colour and a small badge rather than by a sentence.

DocForge already has the right instinct (`apps/web/src/styles/app.css`
defines `--bg`, `--surface`, `--border`, `--text`, `--muted`, `--accent` as
CSS custom properties) but only nine of them, used inconsistently, and nine
tokens cannot describe a save-state colour, a badge colour, a disabled
state, and a hover state all at once, which is why several rules
(`.comment-mark`, `.tracked-insertion`, badge colours) fall back to
hard-coded hex today. The fix, in the Atlassian shape but DocForge's own
values, not theirs:

```
--color-bg                      page background
--color-surface                 a card, a header, a panel
--color-surface-raised          a popover, a menu (RowMenu.tsx today: a hard-coded box-shadow)
--color-border                  the default border
--color-border-subtle           a divider that should recede
--color-text                    body text
--color-text-secondary          what "muted" already means, named consistently
--color-text-on-accent          text on a filled accent surface
--color-accent                  the one brand colour
--color-accent-subtle           its background tint, for a selected row or an active tab
--color-success / -warning / -danger, and each one's "-subtle" background
```

Alongside colour: an explicit **8px spacing scale** (`--space-1: 4px`
through `--space-6: 32px`), replacing the ad hoc `6px 12px`, `8px 16px`
paddings scattered through the stylesheet today, and a small **type scale**
(three or four sizes, not the handful of one-off `font-size` values
currently in the file). This is a rewrite of `app.css`'s custom properties
and a pass over every rule that hard-codes a colour or a spacing value to
use a token instead — mechanical, low-risk, and the precondition for
everything visual after it, because a redesign built on nine tokens will
need redoing the next time someone asks for dark mode or a different
accent colour.

**Two concrete asks fall directly out of having this token layer, added
2026-09-22:**

- **A site-wide font-size control**, a dropdown (not only the editor's own
  zoom, which resizes the page, not the interface around it) that scales
  the type-scale tokens above — one CSS custom property, `--type-scale`,
  multiplying every token's size, switched from a control in the nav bar
  and kept in `localStorage` the way spelling and zoom already are per
  browser. Small, and worth building as part of the token rewrite itself
  rather than after it, since it is the first real proof the tokens work.
- **A switchable theme**, light and dark, from a control in the UI rather
  than only `prefers-color-scheme`. This is what the token layer is *for*:
  a second set of values for the same token names
  (`:root[data-theme="dark"]`), swapped by one attribute on `<html>`,
  touching no component. The specific ask was a theme "based on
  www.bmo.com" for light and a dark-navy theme for dark. **The first half
  of that is not something to build**: styling this product to visually
  match a specific real company's public website is exactly what this
  project's own rule against client-identifying content exists to prevent
  — the rule is not only about the word "BMO" appearing in a file, it is
  about a customer being identifiable by implication, and a theme built to
  look like a specific bank's site does that as plainly as the name would.
  It is also a real brand risk in its own right: a public repository
  visually imitating a specific financial institution's site, unauthorised,
  reads as impersonation regardless of intent. **What is worth building
  instead**: a light theme in a generic, professional "enterprise blue" —
  the register of colour every bank, insurer and consultancy's software
  uses, without matching any one of them — and a dark theme in a dark navy
  background, exactly as asked, since a dark theme built from a colour
  family is not the same claim as a theme built to resemble one company's
  actual site. Both come from the token layer above; neither needs a
  screenshot of anyone's website to build.

## 3. A vendored front-end library: Bootstrap, not jQuery

Also relayed 2026-09-22: use Bootstrap and jQuery, style tables with
Bootstrap's own table styling, vendor both rather than loading either from
a CDN, and do not use a table plugin (DataTables was named specifically).

**Bootstrap: yes, and it fits what section 2 already proposes.** Bootstrap
(MIT) ships exactly the kind of token system section 2 argues for — colour,
spacing, a type scale, a grid — battle-tested across more production
software than a bespoke system will be for years. Vendoring it is no
different from the two spelling dictionaries already vendored: download it
once at build time, commit the lockfile, ship the file, no runtime fetch,
`npm run audit:airgap` unaffected because nothing calls out to a CDN. It
can supply the token *values* section 2 names, or sit underneath them as
the layer those tokens reference — either way, it replaces months of
building a design system from nothing with adopting one, which is the
right trade for a two-person team competing with products built by much
larger ones. Bootstrap's own table classes (`.table`, `.table-striped`,
`.table-hover`) are a reasonable match for `.grid` throughout the app today
and would need no new component, only a class rename.

**jQuery: no, and this is worth saying plainly rather than quietly
dropping.** The entire client is React — the document editor is Tiptap,
which is built on React bindings and cannot be rebuilt in jQuery without
replacing the editor itself, which is most of this product. Every other
page (Documents, Administration, sign-in) is React too. Adding jQuery
alongside React is not "using two good tools together": jQuery and React
both want to own the same DOM nodes, and a well-known, well-documented
class of bug is exactly this pairing — jQuery detaches or rewrites a node
React still thinks it manages, and the next render throws or silently
loses the change. React already does everything jQuery is for (DOM
updates, event handling) in a way the whole rest of this codebase, and its
2,000-plus tests, already assume. Recommendation: take the request as "a
polished, battle-tested visual library, vendored, no CDN, no home-grown
plugins" — which Bootstrap's CSS alone delivers in full — and leave jQuery
out, because the thing it would be used for is a thing this codebase
already has a better, safer tool for.

**No DataTables, and every table gets pagination, sort, search, and a
configurable page size — hand-built, not a plugin.** This was going to be
true regardless: `.grid` (Documents, Accounts, Audit trail, Workflow
groups) is plain React already, so "no DataTables" costs nothing — the
alternative was never a jQuery plugin, it was a small `useTable`-style hook
(sort state, a search string filtered client-side, a page-size dropdown
defaulting to a sensible number, kept in `localStorage` per table the way
zoom and spelling already are) applied to every `.grid` in the app. Audit
trail already paginates server-side (`limit`/`offset` in `GET /audit`); the
others do not yet and would need the same, once a table is expected to
hold more than what fits one screen.

## 4. Information architecture: three surfaces, reconsidered

**Documents home.** Today: a title, two buttons, an upload-options strip
that is always visible even to someone who is not uploading anything, and a
flat table. The enterprise pattern (Jira's issue list, ServiceNow's record
list) is closer to: a persistent left rail for navigation (Documents,
Administration — trivial today, but the natural home for whatever comes
next: templates, workflow groups' own page rather than a buried section of
Administration), a **saved-view / filter bar** above the table (by document
type, by owner, by access — DocForge already stores `docType`; showing it
as a filter, not only a badge, is mostly plumbing that already exists), and
the row itself kept exactly as compact as this week's overflow-menu change
made it. Bulk actions (select several rows, export or delete together) are
a natural next step once the row is this uncluttered, and are the kind of
thing this customer base expects from a ServiceNow-calibre list.

**The editor.** `docs/14-word-like-shell.md` already scopes the tabbed
ribbon precisely (Home/Insert/Layout/Review/View, a contextual Table tab,
the toolbar-test rework it needs). That plan does not change; it becomes
the "Home" and "Insert" tabs of the ribbon this design system would skin.
Worth adding to that scope now that a design system exists to build it in:
the **title bar** restyle mentioned in docs/14 should carry the save state
and presence avatars the way a real application title bar does (centred
document name, unobtrusive status), not as a row of badges beside a plain
text input, which is what it is today.

**Administration.** One page, five sections, and it will keep growing
(workflow groups were added this week; a house-style manager, per the next
section, would be a sixth). This is the clearest case for the left-nav
settings shell pattern (Accounts, Workflow groups, House style, Audit
trail, each its own page) rather than one page that scrolls further every
time a feature is added.

## 5. House style: what "don't build it yet" actually needs, thought through

The ask, restated precisely: an administrator sets, once, what every
exported document should look like — the colour and font of each heading
level, the table header row's shading and size, a logo standardised into
the header or footer, and the page number in a fixed position — and it
applies at export without anyone re-doing it by hand per document.

**This is not a new idea in this codebase; it is an extension of two things
that already exist**, which is why it is safe to plan concretely rather
than hand-wave:

1. **Named styles already centralise exactly the first two asks.** A Word
   file's "Heading 1" colour and font live in one place, `word/styles.xml`,
   not on every heading run — that is the entire point of a named style.
   `packages/model`'s `StyleTable` and `styleSheetFor()` (used today to draw
   a document's own styles in the editor) already model this. A house style
   overriding "Heading 1", "Heading 2" and the table-header style used by
   `TABLE_TEMPLATES` (`Toolbar.tsx`) is a **patch to a handful of named
   style definitions**, not a rewrite of the document. This is exactly
   invariant 7 in `CLAUDE.md` — "preserve by default, edit what we
   understand" — applied to styles instead of body content: touch only the
   named styles the house style claims to control, leave every other style,
   every piece of direct formatting, and the rest of the file untouched.
2. **The header, the footer and page setup already exist as a per-document
   override** (`page_setup` column, `apps/server/src/routes/documents.routes.ts`,
   the "Page setup" panel in the editor). A house style's logo and
   page-number position is the same mechanism at a different scope: an
   organisation-wide default that a document's own `page_setup` can still
   override, the same relationship a CSS user-agent stylesheet has to a
   page's own styles.

**Proposed shape**, deliberately following the `workflow_groups` precedent
already built and tested this week:

```
house_style
  id, name, is_default, doc_type (nullable: applies to one type, or all)
  heading_1..6:  { color, font_family, font_size }
  table_header:  { background, color, font_family, font_size }
  logo:          a stored image, the same way document_media already
                 stores pictures kept beside a document
  logo_placement: 'header' | 'footer'
  page_number:   'none' | 'footer-left' | 'footer-center' | 'footer-right'
  created_at, updated_at, created_by
```

**Where it plugs in, concretely:** `apps/server/src/docx/export.ts` and
`docx/ooxml/write.ts`, at the point `word/styles.xml` and the header/footer
parts are written. A house style is resolved (by the document's `docType`,
falling back to the org default) immediately before those parts are
serialised, and patches only: the named style entries it names, and the
header/footer XML's logo and page-number field, exactly as `page_setup`'s
header and footer text are written today. Nothing about the body content,
numbering, sections, or any other style is touched.

**The real design decision, not the technical one:** whether a house style
applies automatically to every export, or is an explicit **"Apply house
style"** action a document owner chooses per document. Automatic is what
"standardised" implies; explicit is what `CLAUDE.md`'s own lesson
("removing content somebody can see, with no message, is worse than the
refusal it replaced") argues for — a document that arrived with its own
deliberate letterhead should not silently lose it because an administrator
set a default house style for its document type. **Recommendation: explicit
per document, defaulting to on for a blank document created after a house
style exists, and off for anything uploaded**, so an import's own branding
is never silently overwritten, matching how `page_setup` itself already
behaves (a document's own header/footer wins unless somebody changes it
here).

**Effort, honestly:** the data model and admin UI are a smaller version of
what workflow groups already are (a day or so, on this week's evidence).
The export-time style patching is the real work, and needs the same rigour
this project applies everywhere else: a test asserting a house-styled
export still round-trips (opens in Word, keeps everything the style did not
touch), and the fidelity harness run before and after, per `CLAUDE.md`'s own
rule that a change to the writer needs that proof. This should be scoped as
its own piece of work, not folded into the visual redesign above, because
its risk (touching the Word writer) and its reward (a real product
capability) are both different in kind from a CSS rewrite.

## 6. Sequencing

1. **Design tokens, the font-size control and the theme switch** (section
   2): the precondition for everything visual; touches only `app.css` plus
   one small nav-bar control each, no behaviour changes to anything else,
   so it is the lowest-risk place to start and the thing every later step
   should be built against.
2. **Vendor Bootstrap** (section 3): brings in the colour, spacing and type
   values section 2 needs rather than inventing them, and the `.grid` →
   Bootstrap table class rename. jQuery is not part of this step, for the
   reasons in section 3.
3. **Documents home redesign, including per-table sort/search/pagination/
   page size** (section 4): the page every session starts on, and the one
   most recently touched, so the context is freshest.
4. **The tabbed ribbon** (already scoped in `docs/14`): the largest single
   piece of UI work outstanding, now built against the token system instead
   of ad hoc values.
5. **Administration as a left-nav shell**, its tables gaining the same
   sort/search/pagination (section 4): needed regardless of whether house
   style ships, since workflow groups already made the single page too
   long.
6. **The rename to DocAI** (section 1): last, once there is a finished
   interface to put the name in.
7. **House style** (section 5): sequenced independently of the above, since
   it touches the Word writer rather than the client, and should not be
   bottlenecked behind a UI redesign or block one.

Nothing above has been started. The next concrete step, if this ordering
is right, is the design-token rewrite: a contained, reviewable change that
everything after it depends on.
