# Changelog

Notable changes, newest first. Dates are when the work landed.

## Unreleased

### Added

- Web portal: sign in, accounts with administrator, editor and viewer roles,
  per-document view and edit sharing, and an administrator page with an
  append-only audit trail.
- Documents: create blank, upload a `.docx`, autosave, rename, delete, version
  history with restore, and export to `.docx` or plain text.
- Editor: headings, bold, italic, underline, strikethrough, superscript,
  subscript, highlight, colour, font family and size, alignment, lists, block
  quotes, links, images, tables, horizontal rules, undo and redo, live word and
  character counts, and the `Ctrl+Home` and `Ctrl+End` bindings Word uses.
- Air-gap enforcement in two forms: a build-time audit of the browser bundle for
  remote URLs, with a reasoned allowlist, and a runtime probe that fails the
  end-to-end test if the server reaches past loopback.
- Deployment: Dockerfile, hardened systemd unit, Windows launcher, configuration
  example and an install guide.
- Documentation: architecture and licensing analysis, a tab-by-tab Word feature
  matrix, an API reference, a security model and a testing guide.
- Tests: 253 server, 140 client, 29 end-to-end checks, and a browser walkthrough
  that captures each screen.

### Fixed

Every entry below was found by testing, not in production.

- The seed administrator could never sign in. The email rule rejected a
  single-label domain, so the default `admin@localhost` was unusable and every
  fresh installation was locked out of itself.
- Sign out was broken in the browser. The client declared a JSON content type on
  requests that carried no body, which the server rejected as malformed.
- Opening a document marked it dirty and autosaved a revision nobody made,
  because making the editor editable emits an update by default.
- Word and character counts read zero until something changed the document.
- The formatting ribbon never re-rendered on editor state changes, so moving the
  caret did not update the buttons and the table controls stayed disabled after
  inserting a table.
- Creating an account reported a failure while having succeeded, because the
  form element was read after an await had cleared it.
- A failed sign out escaped as an unhandled promise rejection.
- Underline and paragraph alignment were lost on every `.docx` round trip.
- Centred headings lost their centring, because only the paragraph branch of the
  importer read alignment.
- The editor header and ribbon scrolled out of view as a document grew.

### Known limits

- `node:sqlite` is marked experimental in Node 22. The storage layer is narrow
  and behind one module.
- Import and export cover text, headings, lists, tables, images and common
  character formatting. Styles, numbering definitions, headers, footers,
  sections and unknown parts are not yet preserved.
- Lists use ProseMirror's nested structure rather than Word's flat paragraphs
  with numbering properties.
- There is no pagination: the editor shows one continuous page.
- Real-time co-editing is designed but not built.
