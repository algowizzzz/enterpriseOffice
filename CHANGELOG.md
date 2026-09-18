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
- Tests: 420 server, 185 client, 29 end-to-end checks, and a browser walkthrough
  that captures each screen. The repair of a stored document is checked as a
  property against generated documents: it never throws, its output always
  satisfies the rules, and repairing twice changes nothing.

### Security

- Sign-in rate limiting could be bypassed and audit addresses forged. The
  forwarded-address header was trusted unconditionally, and the rate limiter
  keys on the address it produces, so a fresh value on each attempt gave every
  password guess its own bucket. Trusting that header is now configuration, off
  by default.
- Attribute values in stored documents were never checked, so a client that is
  not the editor could put anything into a document and have it handed to the
  Word serializer. Values that reach a serializer are now validated, including
  hyperlink targets, which the server previously had no opinion about at all.
- Two registrations arriving at the same moment could both become
  administrators, because hashing a password takes long enough for both to see
  an empty instance. The check and the insert are now one transaction.
- The importer recursed without a depth limit, so deeply nested markup from an
  uploaded file overflowed the stack. An uploaded archive declaring an enormous
  payload is now refused before anything is decompressed.
- Uploading and changing your own password are now rate limited, and expired
  sessions are cleared hourly rather than only at startup.

### Fixed

Every entry below was found by testing or by an adversarial review of the code,
not in production.

- The editor could get permanently stuck and stop saving. Two of your own writes
  overlapping, which the title field losing focus during an autosave does
  routinely, left the revision stale and every later save failed while the
  person kept typing. Saves are now serialized, and a genuine conflict stops
  retrying and offers a reload.
- Autosave destroyed the version history, the as-imported state of an uploaded
  file included, in about a minute of writing. Retention now keeps the first
  revision, the most recent fifty, and one from each recent hour.
- Importing silently corrupted text. Entity decoding ran in passes, so a
  document containing the literal text `&lt;` had it replaced by the character
  it names. A character reference outside the Unicode range crashed the import.
- A table inside a table imported with its rows doubled.
- A list or table inside a quote flattened into one run-on paragraph on export.
- Every image was written back at a fixed size, resizing and distorting all of
  them. Formats Word carries but this cannot write back, such as EMF and WMF,
  imported fine and were then dropped silently; they are now refused with a
  reason.
- Plain-text export ran list items and table cells together.

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
- A document could be opened as a blank page and then have that blankness saved
  over the stored work. Repairing a document whose only content had to be
  removed, such as a single picture held outside the file, left it with no
  content at all, which the editor builds without complaint. Anything that
  cannot be empty now keeps a paragraph.
- A stored document whose content or marks were not a list took the whole editor
  page down, because the repair threw from inside the editor's start-up.
- The repair could discard the one attribute a node cannot do without, leave a
  root that is not a document, carry children onto a text node, and hand back a
  document still larger than the limit. All four produced a document that could
  not be saved and gave no hint why.
- Content removed by the repair is now reported on screen, on the way in and on
  the way out. Removing what somebody can see, and saying nothing, is worse than
  the refusal it replaced.
- Two documents created in the same millisecond shared a timestamp, so the
  document list ordered them arbitrarily and editing one did not reliably move
  it to the top.
- Pasting a telephone, `ftp` or relative link left a permanent banner saying
  content had been removed, after every keystroke, about a link still visible on
  screen. The editor and the server disagreed about what a link may point at;
  they now share one rule and the editor refuses the rest as they arrive.
- Restoring a version could fail for ever with "Document content is not valid".
  It was the one write path whose content nobody typed and nothing repaired.
- A document containing a page break opened completely blank, because the model
  had a node the editor did not. The editor now has it, with a ribbon button.
- The repair deleted empty tables and lists that the rules accepted, and then
  told the person content had been left out. The rules now refuse them too.
- The message said content had been left out when the repair had only filled an
  empty quote with a paragraph. It is now shown only when something was lost.
- An imported list item holding nothing but a nested list was a shape the
  editor's schema does not allow.

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
- An uploaded archive that lies about its size is contained only by the upload
  cap, the rate limit and the memory limit on the process. Converting in a
  separate process with its own limit is the real fix and is not built.
