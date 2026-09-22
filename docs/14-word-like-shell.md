# Looking and behaving like Word

What "make it feel like Word" actually breaks down into, what of that is
already true, and what is left. Read `docs/11-status.md` first: nearly
everything asked for under this heading turned out to be a feature-completeness
question that was already answered, not a UI question. This document is about
the remaining UI question.

## Already there, not part of this document

Comments (anchored, threaded, resolved), track changes (live, accept/reject,
Original/Redline tabs, both export modes, Word revision marks both ways),
real-time co-editing (shared WebSocket session, presence, cursors,
reconnection) and admin approval of new accounts and document access are all
built and verified; see `docs/11-status.md`. A person reviewing this build
should be pointed at those features directly, not told they are coming.

## What "look like Word" means here, and what it takes

| Word has | DocForge has | Effort to close the gap |
|---|---|---|
| A tabbed ribbon: Home, Insert, Layout, References, Review, View, and a contextual Table tab when the cursor is in one | One flat, always-visible toolbar (`Toolbar.tsx`), organised into groups but never hidden | Large, see below |
| A title bar with the document name and a small quick-access toolbar | A plain header with the title field and a flat row of buttons (`EditorPage.tsx`) | Small: restyling, no new logic |
| A status bar: word count, page count, zoom | Word and character count (done before this pass); zoom (done in this pass); page count needs pagination, which does not exist | Zoom: done. Page count: blocked on pagination, a separate, larger project already tracked in `docs/07-roadmap.md` |
| A Navigation pane: jump to a heading | Built in this pass (`NavigationPane.tsx`) | Done |

## Done on 2026-09-22

- **Navigation pane.** `apps/web/src/components/NavigationPane.tsx` reads the
  document's own headings straight off the editor's state (no new storage, no
  server round trip) and offers them as a jump list, indented by level, in a
  left-hand panel toggled from the editor header. Covered by
  `apps/web/test/navigationPane.test.tsx`.
- **Zoom.** `DocumentEditor.tsx`'s status bar gained a zoom control (50–200%,
  stepped or chosen directly), remembered per browser the way spelling and
  tracking already were. Covered by a new case in `apps/web/test/editor.test.tsx`.
- `HANDOVER.md`'s "Where it stands", "What to do next" and "What is
  deliberately not here" sections were rewritten: they had not been touched
  since roughly commit 38 of 57 and still described comments, track changes
  and co-editing as unbuilt.
- **Every text-label control became an icon**, in the toolbar and the editor
  header: `lucide-react` (ISC, already an allowed licence), the icon set used
  by shadcn/ui and Radix's own examples and, at 45,000+ GitHub stars, one of
  the most widely used in the React ecosystem. A short glyph like "S" for
  Strikethrough or "Righ" (clipped) for Align right is exactly what made the
  toolbar read as a prototype rather than a product; a recognisable icon with
  a tooltip is what Word, Google Docs and OnlyOffice all do instead, and it
  incidentally fixed the label-clipping visible in the screenshot that started
  this pass, simply because icon buttons are a fixed, small width instead of
  however wide a word happens to be. Every button's `title`/`aria-label` was
  left untouched, so this needed no test rewrites: 238 client tests still
  pass, one test updated on purpose (`pages.test.tsx`, "goes back to the
  list": the button's name changed from the literal character "← Documents"
  to "Documents" now that a real arrow icon sits next to it, and the test was
  asserting a cosmetic detail rather than the behaviour it meant to check).
  `IconLabel` (`apps/web/src/components/IconLabel.tsx`) is the shared
  icon-plus-optional-word helper both `Toolbar.tsx` and `EditorPage.tsx` use.

## Deliberately not attempted in the same pass: the tabbed ribbon

`Toolbar.tsx` is one component with roughly fifty controls across a dozen
`tool-group`s, and `apps/web/test/toolbar.test.tsx` (438 lines) exercises
character formatting, paragraph styles, alignment, lists, tables and insert
commands all in a single render, with no step that switches between sections.
A ribbon that actually shows one tab's controls and hides the rest — which is
what "tabbed ribbon" means, not just a row of labels — would hide most of
those controls from `getByRole` queries that do not first click a tab, and
every one of those tests would need a `switch to the <X> tab` step added
before it, in step with the tab each control moves to.

That is a well-defined but sizeable piece of work, not a quick styling change,
and rushing it risks exactly the kind of half-migrated state this project's
own history warns against (`HANDOVER.md`, "The one lesson worth carrying
forward"). The plan, for whoever picks this up next:

1. Decide the tab grouping. A reasonable split, following Word:
   - **Home**: undo/redo, paragraph style, font, size, character formatting,
     alignment, lists, indent, line spacing.
   - **Insert**: link, image, table, standard tables, footnote, contents,
     horizontal rule, page break.
   - **Table** (contextual, shown only with `state.inTable`): the row/column/
     merge/split/header/shading controls, which today live inside the same
     flat toolbar and are already disabled outside a table.
   - **Review**: the existing `ReviewPanel` and `CommentsPanel` toggles, which
     already live in `EditorPage.tsx`'s header, not the toolbar.
   - **View**: find, spelling, print, plus the Navigation and zoom controls
     added in this pass.
2. Add tab state to `Toolbar.tsx` (or a new `Ribbon.tsx` wrapping it) and
   render only the active tab's groups, with `role="tablist"` /
   `role="tabpanel"` for accessibility, matching the pattern `view-tabs` in
   `EditorPage.tsx` already uses for Document/Original/Redline.
3. Rework `toolbar.test.tsx` alongside it: group the existing `describe`
   blocks by which tab they now belong to, and add one `switchTo('Insert')`
   -style helper call at the top of each block that needs a tab other than
   the default. This is mechanical but not small: budget for it as roughly
   the same size as the change itself, not an afterthought.
4. Re-run the full toolbar suite and `npm run verify` before calling it done,
   the same as any other change here.

## Title bar

Smaller and lower-risk: restyle `editor-header` in `apps/web/src/styles/app.css`
so the document title is visually centred and prominent the way a window
title bar is, and consider moving Undo/Redo (already in `Toolbar.tsx`) into a
small quick-access cluster next to it. No new state, no test rework beyond
whatever selectors, if any, key off the current layout (none do today, per
grep against `apps/web/test/`).

## A document assistant: interface only, on purpose

On 2026-09-22, at the user's direction, three pieces of UI/admin scaffolding
were added for a possible future document assistant, **with no model behind
any of it**:

- **`Chat`** and **`Analysis`**, two more buttons beside Review and Comments
  in the File tab. Each opens a right-hand panel
  (`apps/web/src/components/ChatPanel.tsx`, `AnalysisPanel.tsx`) that says
  plainly it is not connected to a model: Chat echoes that back after
  anything is typed, and Analysis shows a permanently disabled "Run
  analysis" button rather than a spinner that would never resolve. Nothing
  either panel does reaches the network or a local process.
- **Workflow groups**, under Administration: a named set of prompts for one
  kind of document, and a summary of what running them together is meant to
  produce (`apps/server/src/services/workflowGroups.ts`,
  `workflowGroups.routes.ts`, migration `0011_workflow_groups`, and a new
  section of `AdminPage.tsx`). This is configuration storage, the same kind
  of thing `page_setup` or a document's styles already are: creating,
  editing and deleting a group is ordinary CRUD, admin-only, audited, with a
  real test suite. At most one group can be the default for a given document
  type, the same "one at a time" rule a document has one owner.

**This is deliberately half of a feature.** `docs/11-status.md` says AI
features are "out of scope by decision," which was a real decision, made for
a real reason: the product's whole pitch is zero network calls, ever, on an
air-gapped machine, and an assistant needs a model to talk to, either over
the network (breaks the air gap) or bundled to run locally (real
infrastructure: a GPU or slow CPU inference, not "unzip and run"). Building
the interface first, and saying so in the interface itself, was a specific
choice: it means a workflow group can be set up and reviewed today, and
wiring an actual model to read it later is an isolated decision, not a
rewrite of the admin console and the editor's UI at the same time. Nobody
should read `ChatPanel.tsx` or the workflow-groups table and conclude AI
analysis works; the panels themselves are written to make that reading hard
to reach by accident.

## What is left, ranked, and where each idea comes from

Checked against real projects rather than assumed, on 2026-09-22:

1. **Custom-styled dropdowns.** Every `<select>` (paragraph style, font, size,
   spelling, standard tables) is still a native browser control: correct
   height and radius were added to match the buttons in this pass, but the
   OS still draws the control itself, which is why it still looks slightly
   out of place next to an icon button. [shadcn/ui](https://github.com/shadcn-ui/ui)
   and the [Radix UI](https://github.com/radix-ui/primitives) primitives it
   is built from (both MIT, both copy-the-source rather than a heavy runtime
   dependency) are the standard reference for an accessible, consistently
   styled `Select`/`DropdownMenu` in React; this is the natural next
   dependency to reach for rather than hand-rolling one.
2. **The tabbed ribbon.** Scoped above. `docs/07-roadmap.md`'s original ranking
   put comments and tracked changes ahead of this kind of shell work; both are
   done now, so this is next in line.
3. **A floating selection toolbar.** Word, Google Docs and Notion all show a
   small toolbar next to the selection itself for the handful of things done
   most often (bold, italic, link, comment), rather than sending the eye back
   up to a fixed bar every time. Tiptap ships this as
   `@tiptap/extension-bubble-menu` (MIT, same family as every other Tiptap
   package already in `apps/web/package.json`), and the
   [official Tiptap UI Components / Simple Editor template](https://github.com/ueberdosis/tiptap-ui-components)
   (MIT, built by the same team as the editor engine this product already
   runs on) is worth reading directly for how they structure exactly this: it
   is the single closest reference available, because it is not merely
   "popular", it is the same dependency tree.
4. **Consolidate the header.** Eleven buttons in one row, even iconised, is
   still eleven decisions. OnlyOffice's own tab set —
   [File, Home, Insert, Draw, Layout, References, Collaboration, Protection,
   Plugins](https://helpcenter.onlyoffice.com/docs/userguides/document_editor/programinterface.aspx) —
   groups exactly this kind of thing (export, history, sharing, protection)
   under one or two tabs rather than a flat row; Google Docs instead puts
   everything infrequent behind a "File" menu and keeps only Share visible.
   Either pattern beats the current flat row; the ribbon work above is the
   natural place to make this choice, not a separate change.
5. **Dark mode.** `app.css` already centralises colour in custom properties
   (`--surface`, `--border`, `--text`, `--muted`, `--accent`); a
   `@media (prefers-color-scheme: dark)` block redefining those tokens is a
   contained, low-risk addition whenever it is prioritised, and is what the
   Tiptap Simple Editor template above ships out of the box.
