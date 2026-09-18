# Security Model

What this system defends against, how, and what it deliberately does not try to
do. Written for whoever has to sign off on putting it on a corporate network.

## What it is protecting

Documents people write, and who is allowed to read and change them. On an
air-gapped deployment the documents are often the reason the network is
air-gapped in the first place, so the interesting attacks come from inside: a
person with an account reaching documents they should not see, or a hostile
file carried in on a USB stick.

## Trust boundaries

| Boundary | What crosses it | Treated as |
|---|---|---|
| Browser to server | Session token, document JSON, uploaded files | Entirely untrusted |
| Uploaded `.docx` | Arbitrary OOXML from anywhere | Entirely untrusted |
| Server to database | Parameterised statements only | Trusted |
| Server to network | Nothing at all | See **Air gap** below |

Nothing arriving from a browser is believed. The editor enforcing a rule is a
convenience for the person using it, never the control: every rule that matters
is enforced again on the server.

## Authentication

**Passwords** are hashed with scrypt from Node's standard library, with a random
sixteen-byte salt per password and parameters chosen for roughly a tenth of a
second per hash. The encoded form carries its own parameters, so they can be
raised later without invalidating existing passwords. scrypt is memory-hard,
which is what makes a stolen database expensive to attack, and it needs no
native module, which matters on a machine with no compiler and no network.

The policy is twelve characters with mixed case and a digit. There is no
expiry rule, because forced rotation reliably produces worse passwords.

**Sessions** are opaque 256-bit random tokens. Only a SHA-256 hash of the token
is stored, so a database copy does not yield usable sessions. Every token has an
expiry and can be revoked, and revocation is checked on each request rather than
cached, so disabling an account ends its sessions immediately.

Changing a password, whether by the person or by an administrator, revokes every
other session for that account. A session cannot outlive the password it was
created with.

**The seed administrator** has no default password. If none is configured, no
account is created and the server says so in its log. An installation that
cannot be signed into is better than one with a known credential. A configured
address that is not a valid email stops the server rather than creating an
account nobody can reach.

**Sign-in** is rate limited per address. A wrong password and an unknown account
produce the same message, and a verification is run even when no account exists,
so the two take the same time. The endpoint cannot be used to enumerate
addresses.

## Authorisation

Access to a document is computed on the server for every request, from
ownership, explicit shares and role. It is never taken from the request.

Administrators can read any document, for support and compliance, but **cannot
silently edit one**. Write access needs ownership or an explicit share. An
administrator who could edit anything invisibly would make the audit trail
misleading, which is the opposite of what an audit trail is for.

Two rules are enforced in the service rather than the interface, because the
interface is not a security boundary: the last active administrator cannot be
demoted or disabled, and an administrator cannot disable their own account.

A document you have no access to answers "not found", not "forbidden", so the
API does not confirm which identifiers exist.

## Untrusted content

**Document JSON** is validated on every save against the same node and mark
vocabulary the editor is built from. Unknown nodes and marks are refused, not
stripped and stored. The walk is bounded in both node count and depth, so a
deliberately deep or enormous document cannot exhaust the stack or the disk
before the limit is reached.

**Uploaded files** are checked for a zip signature before any parsing, size
limited before they are read into memory, and converted in a library that does
not execute anything from the file.

**Hyperlinks** in an uploaded document are filtered to `http`, `https`,
`mailto`, fragments and site-relative paths. A `javascript:`, `data:`,
`vbscript:` or `file:` target is dropped and the visible text kept. This check
lives in the importer, not the editor, because an uploaded file can carry any
target it likes and never passes through the editor's own validation first.

**Images** are only accepted as embedded data, capped at 2 MB each and 100 per
document. An image referencing a remote address is dropped, which is both a
privacy control and part of the air gap: a document must not be able to make the
browser fetch anything.

**Rendering** goes through ProseMirror, which builds DOM nodes from a schema. No
path in the client assigns untrusted HTML.

## Transport and browser

A content security policy confines the page to its own origin: `default-src
'self'`, no `object-src`, no framing, scripts only from this origin. Images
additionally allow `data:` and `blob:`, which embedded pictures and downloads
need.

Session cookies are `HttpOnly`, so script cannot read them, and `SameSite=Strict`,
which stops cross-site request forgery without a token scheme. Set
`DOCFORGE_SECURE_COOKIES` when serving over HTTPS.

The usual protective headers are set: no sniffing, no referrer, no
cross-origin resource sharing, and a same-origin opener policy.

## Air gap

The product must never reach the network, and that is checked rather than
asserted.

The browser bundle is scanned at build time. A remote URL in markup or a
stylesheet fails outright. One in a script must be listed with a written reason,
of which there are currently two, both strings inside library error messages.

The server is checked differently, because scanning it for URL strings would
produce over a hundred specification links from inside dependencies and an
allowlist that long would be rubber-stamped. Instead the end-to-end test runs
the server with a probe wrapping the socket and name-resolution layers, and
fails if the process reaches for any address beyond loopback. The probe is
itself verified against a deliberate violation, so it cannot pass vacuously.

The systemd unit restricts the service further, and a firewall should do the
rest. There is no telemetry, no update check and no font or script fetched at
run time.

## Auditing

Every state change is appended to an audit trail with the actor, the target, the
address it came from and a timestamp: sign-ins and failed sign-ins, account
changes, and document creation, import, edit, rename, delete, restore, export
and sharing. Only administrators can read it. Passwords and document content
never appear in it.

## Deliberately out of scope

Being explicit about this is part of the model.

- **No encryption at rest.** The database is a file. Use full-disk encryption,
  which an enterprise Linux or Windows build already has, rather than a second
  key-management problem inside the application.
- **No single sign-on yet.** Accounts are local. Keycloak sits in front when
  Active Directory is needed; the architecture document covers it.
- **No multi-factor authentication yet.** Worth adding; it is not here.
- **No protection against a compromised server.** Anyone with root on the host
  can read every document. That is inherent, not a gap to be closed in
  application code.
- **No protection against a malicious administrator.** An administrator can
  reset any password and then sign in as that person. The audit trail records
  it, which is the control: detection, not prevention.
- **No rate limiting beyond sign-in.** An authenticated user can make as many
  requests as they like. Add a reverse proxy limit if that matters.

## Reporting a problem

On an air-gapped deployment, report through whatever channel the site already
uses for internal security issues. Please do not open a public issue for
anything exploitable.
