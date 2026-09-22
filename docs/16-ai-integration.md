# AI integration: chat, analysis, and prompt-group execution

Written 2026-09-22, superseding the "out of scope by decision" framing in
`docs/11-status.md` and the "no model behind this yet" framing in
`docs/14-word-like-shell.md` §"A document assistant" and `docs/15-enterprise-redesign.md`.
**AI is now in scope.** This document specifies what to build. Unlike
`docs/15`'s house-style section, this is a build spec, not a plan-only
document — implement against it.

## 1. What changes, and why this document exists

Chat and Analysis were built as honest, inert previews: real UI, no model
behind either, saying so plainly (`ChatPanel.tsx`, `AnalysisPanel.tsx`,
`docs/14-word-like-shell.md`). That constraint is lifted. This is the first
feature in the product's history that makes an outbound network call by
design, which is a real architectural change, not an incremental one — see
§7 before writing the routes.

## 2. Ribbon and panel restructuring

- Collapse the ribbon to two top-level tabs: **Home** and **AI**. Home
  absorbs everything currently under the separate `File` tab (Export,
  Original, Review, Comments, Page setup, History, Lock, Share — the
  `ribbonTab === 'file'` branch in `EditorPage.tsx`) as a sub-section, not a
  sibling tab. `ribbonTab: 'home' | 'file'` becomes whatever state shape
  reflects "File is content within Home," not a third value alongside it.
- The AI panel needs a persistent entry point: either open by default when a
  document loads, or a docked button on the right edge of the screen (the
  floating-launcher pattern most chat products use), not only reachable by
  first switching to the AI ribbon tab.
- **Chat and AI Analysis become two sub-tabs of one panel**, not two
  separate toggle buttons opening the same `side` slot the way
  `ChatPanel`/`AnalysisPanel` work today. One panel, `role="tablist"`
  internally, matching the pattern `EditorPage.tsx`'s own `view-tabs`
  (Document/Original/Redline) already uses for exactly this kind of
  in-place tab switch.
- Open question: does Comments join this tab strip too, or stay a separate
  toggle as today? Not stated in the request that started this document —
  confirm before merging Comments in, since it changes an already-shipped,
  tested feature's location.

## 3. Admin: LLM endpoint registration

A named connection to a model, registered the same way an MCP server or an
agent tool is connected elsewhere: a **raw LLM endpoint** (a direct
completion/chat-completion interface, not a tool-calling framework), reached
over HTTP.

```
llm_endpoints
  id, name, url, auth_scheme ('none' | 'bearer' | 'header'),
  auth_secret (encrypted at rest; never returned by GET, only accepted on
               create/update, the same discipline sessions already use for
               tokens — see apps/server/src/lib/ids.ts's hashToken pattern),
  request_format (enum: whichever wire formats are supported first --
                   at minimum an OpenAI-compatible chat/completions shape,
                   since that is what most self-hosted and on-prem
                   inference servers already speak),
  created_at, updated_at, created_by
```
Admin-only CRUD, audited exactly like `workflow_groups` (`workflow_group.created`
etc. in `apps/server/src/services/audit.ts` — add `llm_endpoint.created`,
`.updated`, `.deleted` alongside it). A "Test connection" action (send a
trivial prompt, show the raw response or the error) belongs here too — the
first thing an admin will want after saving one.

**Open question, from your own wording ("separate... endpoint"):** is one
endpoint shared by Chat and every workflow group, or can Chat and each
workflow group point at a different registered endpoint? Recommendation:
support the general case now — `chat` config references one endpoint id,
each `workflow_groups` row references one endpoint id (nullable, falling
back to a configured default) — since building the narrower "one endpoint
for everything" version first and widening it later touches the same two
tables twice. Confirm this reading before implementing.

## 4. Admin: prompt groups, extended

Today (`apps/server/src/services/workflowGroups.ts`): `prompts: string[]`,
a flat array of plain strings with no identity, no role, no order beyond
array position, and a static `outputSummary` text field describing (not
producing) an outcome.

This changes: the summary is now an **executed prompt**, not a description,
and it has a different input contract than every other prompt in its group
— it receives the other prompts' collected outputs, not the document.
That needs identity and role per prompt, not a flat string array:

```
workflow_group_prompts  -- replaces the `prompts` JSON column
  id, group_id, role ('analysis' | 'summary'), position, text
  -- exactly one row with role='summary' per group, enforced in the
  --   service layer (the same kind of invariant clearOtherDefaults()
  --   already enforces for is_default);
  -- 'position' orders the analysis prompts only -- the summary prompt is
  --   excluded from reordering and always renders first in the admin UI,
  --   despite running last.
```
Admin UI requirements:
- Add / edit / delete prompts within a group.
- **Drag-and-drop reorder** of the analysis prompts (not the summary one,
  which is visually pinned at the top of the list regardless of its actual
  execution order).
- Cap at 10 prompts per group (tightened from the current schema's soft cap
  of 50, which predates this requirement).

## 5. Execution flow (AI Analysis tab)

1. A dropdown lists the workflow groups available for the open document.
   Open question: filtered to the document's own `docType` (falling back to
   that type's default group), or every group regardless of type? The
   existing `workflow_groups.doc_type` column supports either; confirm
   which.
2. "Run" executes every `analysis`-role prompt in the chosen group against
   the document (in parallel, unless ordering matters for a reason not yet
   stated — flag if it does), collects their outputs, then runs the
   `summary`-role prompt with those outputs as its input.
3. Display: at minimum the summary's output. Open question: are the
   individual analysis prompts' own outputs shown too (e.g. collapsed
   under the summary), or only the final summary? Not stated; recommend
   showing both, since a reviewer will want to see what any one prompt
   actually found, not only the rolled-up answer, but confirm before
   building the narrower version.
4. Every run is audited (`analysis.run`: actor, document id, workflow
   group id, endpoint id, timestamp — not the prompt text or the model's
   output, which are not audit-log material).

## 6. Chat

Maps to one registered endpoint (§3). Needs: does chat carry any document
context (the document's text, or a summary of it) or is it a bare,
document-independent conversation? `ChatPanel.tsx` today is opened from
within a document's editor, which implies context should travel with it,
but this was never specified for the real version — confirm before wiring
it, since "does the model see the document" is a real behaviour decision,
not a UI detail.

## 7. The network question this whole document turns on

Every existing invariant (`npm run audit:airgap`, the smoke test that fails
if the server opens a socket beyond loopback, `docs/12-requirements-and-bom.md`'s
"no outbound network call of any kind once the process is running") assumes
zero outbound calls, unconditionally. This feature is the first deliberate
exception, and it needs an explicit policy, not a silent one:

- **While no `llm_endpoints` row exists, the air-gap guarantee holds exactly
  as documented today** — nothing changes for an install that never
  configures one.
- **The moment an admin registers an endpoint, that specific install is no
  longer air-gapped in the strict sense**, and that needs to be visible,
  not buried: a warning in the admin UI when saving one, and
  `docs/12-requirements-and-bom.md` updated to describe this as a named,
  admin-opted-into exception rather than silently letting the document's
  own "no outbound network call of any kind" claim go stale and wrong.
- Whether the product should *validate* that a configured URL is on a
  private address range (refusing a public-internet host outright, or only
  warning) is a real product decision, not an implementation detail —
  needs an explicit answer before this ships, the same way the house-style
  auto-vs-explicit question in `docs/15` needed one rather than a default
  guess either way.

## 8. Non-functional requirements

- Timeouts and honest failure states: a slow or unreachable endpoint shows
  a real error, not a spinner that never resolves — the same standard
  `AnalysisPanel.tsx`'s current inert state was already built to.
- Secrets: an endpoint's auth token is write-only from the API's own
  response (never read back), the same discipline session tokens already
  get (`hashToken` in `apps/server/src/lib/ids.ts`).
- Every AI action — endpoint changes, workflow group changes, every run —
  is audited, matching every other admin action in this codebase.

## 9. Testing

Same bar as everything else in this codebase: a regression test with every
behaviour change, `npm run verify` green before anything is called done. A
real model is not available in the automated test suite; endpoint calls
need to be mocked at the HTTP layer (the same way `apps/server/test`
already mocks nothing live and exercises the app via `app.inject`), and the
mock's absence-of-a-real-model should be explicit in the test names, not
implied.

## 10. Suggested phasing

1. `llm_endpoints` table, service, admin CRUD + audit + "Test connection." No
   feature depends on it yet; it is the foundation everything else calls.
2. `workflow_group_prompts` migration (replaces the `prompts` JSON column),
   admin UI for add/edit/delete/reorder, summary-prompt pinning.
3. Chat wired to one endpoint (the simpler of the two consumers — no
   multi-prompt orchestration).
4. AI Analysis execution flow: dropdown, run, sequential-then-summary
   execution, results display.
5. Ribbon/panel restructuring (§2) — deliberately last: it is a pure UI
   reorganisation of features that need to exist and work first, so it is
   not blocking anything above it and can be sequenced independently.

Four open questions are called out above (§2 Comments-in-tab-strip, §3
per-group vs. shared endpoint, §5 doc-type filtering and individual-output
display, §6 chat context, §7 public-endpoint policy). Recommend resolving
all four explicitly before implementation starts on the phase that depends
on each, rather than defaulting silently either way.

## 11. Answered, 2026-09-22 (main session)

The side session that drafted this correctly declined to guess on the
points below. Answered here with the reasoning, since the reasoner has
direct knowledge of the shipped code these decisions touch:

- **§2, Comments in the tab strip: no, leave it where it is.** Comments
  (`CommentsPanel.tsx`) is a mature, tested, Word-round-tripping feature;
  Review (`ReviewPanel.tsx`, track changes) already lives beside it as a
  separate toggle into the same `side` slot. Folding either into a
  brand-new AI tab strip mixes "a person reviewing this document" with "a
  model reviewing this document," which are different trust relationships,
  and adds risk to two shipped features for no stated benefit. The AI tab
  strip is Chat and Analysis only, both already inert previews being
  upgraded together; Comments and Review keep their current toggles
  untouched.
- **§5, document-type filtering: yes, filter.** `workflow_groups.doc_type`
  exists specifically for this (nullable = applies to every type); the
  dropdown should show groups where `doc_type` matches the open document's
  own type, plus any group with `doc_type: null`. Showing a "Policy
  prompts" group against a Framework document would be confusing and is
  not what that column was built for.
- **§5, showing individual outputs: yes, both,** exactly as recommended —
  and for a reason beyond "a reviewer will want to see the detail": this
  codebase's own standing rule (`CLAUDE.md`, "never remove somebody's
  content silently") is really a broader principle about not hiding what
  happened, which the audit log, the redline view and the repair-visibility
  flag all already apply to human edits. Applying it to a model's
  intermediate output is the same principle, not a new one.
- **§6, chat context: yes, the document travels with it,** for the reason
  already named in the doc: `ChatPanel.tsx` is opened from inside a
  document, and a chat that cannot see the document it was opened from
  would be a worse product than one with no chat at all. Real follow-up
  question this raises, not yet answered: **the context-window size.**
  Nothing in this codebase currently chunks or summarises a document for
  an LLM; the honest first version sends the document's own text up to
  some byte cap and truncates past it, said plainly in the UI when it
  happens (the same "say so, do not do it silently" standard as
  everywhere else). A real chunking/retrieval approach is future work, not
  phase 3.

## 12. Not answered here — these need you specifically, not the codebase

Two points from §7 are genuine policy decisions, not engineering ones, and
both cut against the reason this product was air-gapped in the first
place. Recommending an answer here rather than sitting on it would be the
same mistake the side session correctly avoided by not guessing:

- **Should a configured endpoint URL be validated against private address
  ranges (refuse a public host, or only warn)?** A real product decision
  either way is defensible — refusing keeps the air-gap posture close to
  absolute even with the feature on; allowing (with a warning) supports a
  legitimate case this document itself names, an OpenAI-compatible public
  API. This needs your answer before §3's schema is finalised, since a
  refuse-by-default posture likely wants a second field (an explicit
  administrator override), not only a warning dialog.
- **Should a document, or a document type, be markable as "never sent to
  AI"?** Every reason this product exists air-gapped in the first place
  (docs/12: "locked-down enterprise," an organisation that cannot have
  content leaving the network) applies with equal force to a Policy or
  Framework document being sent to Chat or Analysis once an endpoint is
  configured. This was not raised in the original document and is added
  here because it follows directly from what air-gapping was for: an
  opt-in AI feature does not have to mean every document is eligible for
  it. Worth deciding before phase 3, since it is a column on `documents`
  or `workflow_groups` either way, cheaper to add now than to retrofit
  once Chat is wired up and in use.

## 13. One integration point the original document could not have known

`apps/web/src/pages/DocumentsPage.tsx` gained its own "Run analysis" and
"Chat" row-menu items on 2026-09-22, opening the same inert
`AnalysisPanel`/`ChatPanel` inline under a document's row in the list, so
that a preview of both is reachable without opening the editor at all (see
`docs/14-word-like-shell.md`, "document-assistant UI scaffolding"). This
document's phases 3–4 wire the editor's copies of those two panels to a
real endpoint; the list's copies need an explicit decision too, not an
oversight: keep the list's versions as inert previews only (steering
anyone who wants the real thing to open the document first), or wire both
copies to the same real backend. Recommendation: keep the list inert for
now — Chat's document-context requirement (§11) and Analysis's
document-type-filtered dropdown (§5) both read more naturally with the
document already open — and revisit once phases 3–4 are stable.

## 14. Missing from the original document, worth deciding alongside it

- **A visible AI-output disclaimer.** The reference tool this session's
  UI work has been compared against carries a persistent banner on every
  AI-touching screen: recommendations are AI-generated, the document
  owner remains fully responsible, nothing is applied without their
  review. `AnalysisPanel.tsx` and `ChatPanel.tsx` should carry the same
  the moment either produces real output — this is exactly the kind of
  thing this codebase already does for its own working-copy reminder
  (`EditorPage.tsx`'s "This is a working copy..." banner) and should not
  need a second design pass once phase 3 ships.
- **Rate limiting.** Every registered endpoint is either a cost (a paid
  API) or a shared resource (an internal inference server); nothing
  today stops a signed-in viewer from clicking "Run analysis" or sending
  chat messages in a fast loop. `apps/server/src/config.ts` already has a
  `loginRateLimit` precedent; an equivalent per-user-per-minute limit on
  both AI routes is worth building alongside phase 3, not after an
  incident makes it urgent.

Six open questions now stand in place of the original four: two answered
in §11 with reasoning (Comments, doc-type filtering, individual outputs,
chat context — four of the original five, resolved), two still needing
your decision specifically (§12: public-endpoint validation, sensitive-
document opt-out), and one integration point plus two additions raised by
the codebase as it stands today (§13, §14). Recommend resolving §12 before
phase 1's schema is written, since both affect table shape.
