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
