# API Reference

Every endpoint lives under `/api`. Anything not listed here does not exist, and
an unknown path under `/api` answers `404` with a JSON error rather than the
client shell.

## Conventions

**Authentication.** A session token is accepted either as the `docforge_session`
cookie, which the browser sets automatically, or as `Authorization: Bearer
<token>`. The cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` whenever
`DOCFORGE_SECURE_COOKIES` is on. Sign-in returns the token in the body as well,
for scripts and integrations.

**Errors.** Every failure has the same shape, so a client never has to guess.

```json
{ "error": { "code": "FORBIDDEN", "message": "Only the owner can delete a document", "details": null } }
```

| Code | Status | Means |
|---|---|---|
| `VALIDATION_FAILED` | 400 | The body did not match the schema. `details` lists the fields. |
| `BAD_REQUEST` | 400 | The request was well formed but cannot be carried out. |
| `UNAUTHORIZED` | 401 | No session, or the session has expired or been revoked. |
| `FORBIDDEN` | 403 | Signed in, but not allowed to do this. |
| `NOT_FOUND` | 404 | No such thing, or nothing you are allowed to see. |
| `CONFLICT` | 409 | The change would break a rule, such as removing the last administrator. |
| `PAYLOAD_TOO_LARGE` | 413 | The upload or body exceeded its limit. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | The file is not a `.docx`. |
| `RATE_LIMITED` | 429 | Too many sign-in attempts from this address. |
| `INTERNAL_ERROR` | 500 | Something unexpected. The detail is in the server log, never in the response. |

**Not found over forbidden.** Asking for a document you have no access to
answers `404`, not `403`. Otherwise the API would confirm which document
identifiers exist.

**Roles.** `admin` manages accounts and reads the audit trail. `editor` creates
and edits documents. `viewer` can only read what has been shared with them.

---

## Health

### `GET /api/health`

No authentication. Used by container and load balancer health checks.

```json
{ "status": "ok", "time": "2026-09-18T08:00:00.000Z", "version": 1 }
```

---

## Authentication

### `GET /api/auth/bootstrap`

No authentication. Reports whether the instance still has no accounts, which is
what the sign-in page uses to decide between signing in and first-run setup.

```json
{ "needsSetup": true }
```

### `POST /api/auth/register`

Creates the first account and makes it an administrator. **Only works while the
instance has no users**; afterwards it answers `400`. Rate limited to five
attempts per address per minute.

```json
{ "email": "admin@localhost", "name": "Ada Admin", "password": "Correct-Horse-9" }
```

Answers `201` with the user, a token, and its expiry, and sets the session
cookie.

### `POST /api/auth/login`

Rate limited by `DOCFORGE_LOGIN_RATE_LIMIT` per address per minute.

```json
{ "email": "admin@localhost", "password": "Correct-Horse-9" }
```

A wrong password and an unknown account give the same message and take the same
time, so the endpoint cannot be used to discover which addresses have accounts.
A disabled account is refused the same way.

### `POST /api/auth/logout`

Revokes the current session and clears the cookie. Takes no body.

### `GET /api/auth/me`

Returns the signed-in user. Used on page load to restore the session.

### `POST /api/auth/password`

Changes your own password. Every other session for the account is revoked, so a
stolen session cannot outlive the password it was created with.

```json
{ "currentPassword": "Correct-Horse-9", "newPassword": "Another-Horse-42" }
```

Password rules: at least twelve characters, with an uppercase letter, a
lowercase letter and a digit.

---

## Users

### `GET /api/users`

Any signed-in user may read the directory, because sharing needs it, but only an
administrator sees roles, status and sign-in history. Everyone else gets id,
name and email for active accounts only.

### `POST /api/users`

Administrator only. Creates an account.

```json
{ "email": "ed@localhost", "name": "Eddie Editor", "password": "Correct-Horse-9", "role": "editor" }
```

### `PATCH /api/users/:id`

Administrator only. Any subset of `name`, `role`, `status`.

Two rules are enforced here rather than left to the interface. The last active
administrator cannot be demoted or disabled, and an administrator cannot disable
their own account. Disabling an account revokes its sessions immediately.

### `POST /api/users/:id/password`

Administrator only. Resets somebody else's password and revokes their sessions.

### `GET /api/audit?limit=&offset=`

Administrator only. The append-only trail, newest first. `limit` is 1 to 500,
default 100.

Recorded actions: `user.login`, `user.login_failed`, `user.logout`,
`user.created`, `user.updated`, `user.password_changed`, `user.disabled`,
`user.enabled`, `document.created`, `document.imported`, `document.updated`,
`document.renamed`, `document.deleted`, `document.restored`,
`document.exported`, `document.shared`, `document.unshared`.

---

## Documents

### `GET /api/documents`

Everything you own or that has been shared with you, most recently saved first.
Content is not included. Each entry carries `access`, one of `owner`, `edit` or
`view`.

### `POST /api/documents`

Creates a document. Both fields are optional: with no body you get an empty
document titled "Untitled document". A `viewer` account is refused.

```json
{ "title": "Quarterly Report", "content": { "type": "doc", "content": [] } }
```

### `POST /api/documents/import`

`multipart/form-data` with one field named `file`. Converts a `.docx` into an
editable document and returns it, together with any warnings from the converter,
such as an image that was too large to embed.

The file is rejected unless it is a real zip container whose content Word can
read. Older binary `.doc` files must be converted first.

### `GET /api/documents/:id`

The document including its content.

### `PUT /api/documents/:id`

Saves a change. Supply `title`, `content`, or both; supplying neither is an
error.

```json
{ "content": { "type": "doc", "content": [] }, "expectedRevision": 3 }
```

`expectedRevision` is optional but strongly recommended. When it does not match
the stored revision the save is refused, so two people editing at once cannot
silently overwrite each other. Every accepted save increments the revision and
keeps the previous text as a version.

Content is validated against the same node and mark vocabulary the editor uses.
Anything unrecognised is refused rather than stored.

### `DELETE /api/documents/:id`

Owner only. A soft delete: the row is kept but becomes invisible to every
endpoint.

### `GET /api/documents/:id/export?format=docx|txt`

Returns the file with a `Content-Disposition` carrying both an ASCII fallback
name and the real UTF-8 name, so a non-Latin title downloads correctly. Default
format is `docx`.

### `GET /api/documents/:id/versions`

Every kept version, newest first, with who saved it and when. The fifty most
recent are retained.

### `GET /api/documents/:id/versions/:revision`

The content of one earlier version, for previewing before restoring.

### `POST /api/documents/:id/versions/:revision/restore`

Writes that version back as a new revision. Nothing is lost: the text being
replaced becomes a version of its own.

### `GET /api/documents/:id/shares`

Who the document is shared with.

### `PUT /api/documents/:id/shares`

Owner only. Grants or changes access. Re-sharing with the same person changes
their permission rather than adding a second grant.

```json
{ "userId": "…", "permission": "edit" }
```

Sharing with yourself, with an account that does not exist, or with a disabled
account is refused.

### `DELETE /api/documents/:id/shares/:userId`

Owner only. Removing a share that was never made succeeds and changes nothing.

---

## Limits

| Limit | Default | Setting |
|---|---|---|
| Request body | 16 MB | fixed |
| Upload | 25 MB | `DOCFORGE_MAX_UPLOAD_BYTES` |
| Stored document | 12 MB of JSON | fixed |
| Embedded image | 2 MB each, 100 per import | fixed |
| Title | 200 characters | fixed |
| Session lifetime | 12 hours | `DOCFORGE_SESSION_TTL` |
| Sign-in attempts | 10 per address per minute | `DOCFORGE_LOGIN_RATE_LIMIT` |
| Kept versions | 50 per document | fixed |

## Document content

Content is ProseMirror JSON. The vocabulary is defined once in
`packages/model` and shared by the editor and the server, so the two cannot
drift apart.

Nodes: `doc`, `paragraph`, `heading`, `text`, `hardBreak`, `pageBreak`,
`horizontalRule`, `blockquote`, `bulletList`, `orderedList`, `listItem`,
`table`, `tableRow`, `tableCell`, `tableHeader`, `image`.

Marks: `bold`, `italic`, `underline`, `strike`, `superscript`, `subscript`,
`textStyle`, `highlight`, `link`.
