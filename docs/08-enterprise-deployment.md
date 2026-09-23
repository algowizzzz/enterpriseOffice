# Deploying on an air-gapped Linux server

For the person doing the install, and for the person reviewing it. Everything
here works with no network on the target machine, and nothing needs to be
installed there first: **the release archive already carries the Node.js
runtime it needs.** If a step reaches for the network, that is a defect:
report it.

For a Windows laptop instead of a Linux server, see
`docs/13-windows-quickstart.md`: unpack the Windows archive, double-click
`start-docforge.cmd`, nothing else.

The short version, for Linux:

```sh
# on a machine with internet access, once
npm ci && npm run release        # writes one archive per platform under release/

# on the server: no install, no root, run as yourself
tar -xzf docforge-*-linux-x64.tar.gz && cd docforge-*/
sh run-standalone.sh

# or, for a persistent service that survives a reboot (needs root once)
sudo sh install.sh
```

## 1. What is being deployed

| Piece | Size | What it is |
|---|---|---|
| `server.mjs` | about 9 MB | The whole server in one file. Every dependency is compiled in. |
| `web/` | under 1 MB | The browser client: one page, one script, one stylesheet. |
| `node/` | about 45–95 MB, by platform | The exact Node.js runtime this release needs, already inside the archive. Nothing to separately obtain, fetch or approve at install time. |

There is no `node_modules` directory, no package manager, no compiler and no
database server on the target. Storage is SQLite, which is built into Node, in
one file under `/var/lib/docforge` (or a local `./data` folder for
`run-standalone.sh`). `npm` runs on the build machine and never on the server.

The server makes no outbound connections. It does not check for updates, load
fonts, report usage or fetch anything. The release gate proves it: the end to
end test fails if the server opens a socket beyond loopback, and the build fails
if the browser bundle contains a remote address. The systemd unit then makes it
a property of the machine as well.

## 2. What the server needs

| Need | Detail |
|---|---|
| Processor | x86-64 or 64-bit ARM. Choose the matching archive: `linux-x64` or `linux-arm64` |
| Operating system | Any Linux with glibc 2.28 or newer: RHEL, Rocky, Alma or Oracle 8 and later, Ubuntu 20.04 and later, Debian 10 and later, SLES 15 SP3 and later |
| Node | Already inside the archive. Nothing to install |
| Service manager | Only if you want a persistent service (`install.sh`): systemd. Without it, `run-standalone.sh` needs nothing beyond the operating system; see section 12 |
| Memory and CPU | 1 GB and one core is comfortable for a team. Word conversion is the only heavy work |
| Disk | Under 150 MB unpacked, Node included. Allow for the database: every save is kept as a version |
| Access | None for `run-standalone.sh`. Root, once, for `install.sh`, to create a service account and register with systemd |
| Network | One inbound port, 8080 by default, normally reached only by a reverse proxy on the same machine |

`preflight.sh` checks every row of that table on the actual machine, and needs
no root either.

### If your organisation would rather use its own approved Node

`install.sh` accepts `--node-archive <file>` (another official Node tarball)
or `--node /path/to/node` (a system-wide copy already on the machine), and
uses that instead of the one bundled with the release. Most people need
neither flag.

## 3. Building the release

On a machine that can reach a package registry, public or an internal mirror,
**and can reach `nodejs.org`** (this is the one and only place the network is
used in this whole process, and it is this build machine, never the target):

```sh
git clone <this repository> && cd enterpriseOffice
node -v                  # 22.5 or newer
npm ci                   # exact versions from the lockfile
npm run release          # builds a kit for Linux x64, Linux arm64 and Windows x64
```

Building only some platforms: `npm run release -- --platform linux-x64`.

`npm run release` runs the whole gate first (lint, types, both test suites, the
build, the air-gap audit and the end to end run), downloads and checksum-verifies
the official Node runtime for each requested platform straight from
`nodejs.org` (cached under `.cache/node-runtimes/` so this only happens once
per version), then proves the packaged copy of the server runs on its own,
with nothing beside it. It writes, per platform:

```
release/docforge-<version>-<date>-<commit>-linux-x64.tar.gz
release/docforge-<version>-<date>-<commit>-linux-x64.tar.gz.sha256
release/docforge-<version>-<date>-<commit>-linux-arm64.tar.gz    (and .sha256)
release/docforge-<version>-<date>-<commit>-windows-x64.zip       (and .sha256)
```

Behind an internal registry mirror, point npm at it before `npm ci`
(`npm config set registry https://<your mirror>/`). npm swaps the public
registry's host for yours when it reads the lockfile, so the lockfile does not
need editing. If the mirror is missing a package, `npm ci` names it: that list
is what to ask the mirror's owners for. The Node runtime download is separate
from npm and is not affected by an npm mirror; if `nodejs.org` itself is
blocked from the build machine, ask your organisation for its own approved
Node 22.5+ Linux/Windows binaries and place them under
`.cache/node-runtimes/v<version>-<platform>/` in the same layout
`fetch-node-runtime.mjs` produces (`bin/node` for Linux, `node.exe` for
Windows) before running `npm run release`.

Inside each Linux archive:

| File | Purpose |
|---|---|
| `server.mjs`, `web/` | The program |
| `node/` | The Node.js runtime, bundled |
| `run-standalone.sh` | Run it now, as any user, no install, no root |
| `install.sh` | Install as a systemd service (needs root once), upgrade, uninstall |
| `preflight.sh` | Can this machine run it? Changes nothing, needs no root |
| `verify-install.sh` | Is the running service actually serving? |
| `docforge.service` | The systemd unit, sandboxed |
| `env.example` | Every setting, with production values |
| `THIRD-PARTY-NOTICES.txt`, `sbom.cdx.json` | Every package that ships: the human-readable and the machine-readable bill of materials. See `docs/12-requirements-and-bom.md` |
| `NODE-VERSION.txt` | The exact Node version bundled, and the checksum it was verified against |
| `SHA256SUMS` | A hash of every file above |
| `VERSION`, `LICENSE`, `DEPLOY.md` | What this is, and this guide |

The Windows archive carries the same `server.mjs`, `web/`, `node/`,
`THIRD-PARTY-NOTICES.txt`, `sbom.cdx.json`, `SHA256SUMS` and `VERSION`, plus
`start-docforge.cmd` and `README-FIRST.md` (`docs/13-windows-quickstart.md`)
in place of the Linux scripts.

## 4. Moving it across

Copy one file: the release archive for the target's platform. Nothing else.
On the server:

```sh
sha256sum -c docforge-*-linux-x64.tar.gz.sha256
tar -xzf docforge-*-linux-x64.tar.gz
cd docforge-*/
sha256sum -c SHA256SUMS
```

Both checks should print `OK` for every line. A mismatch means the copy was
damaged or altered on the way: stop there. (Windows: verify with
PowerShell's `Get-FileHash`, or check the `.sha256` file by eye; there is no
`sha256sum` on Windows by default.)

## 5. Preflight

```sh
sh preflight.sh              # checks the Node runtime already bundled here
```

No root, no changes. Run it from inside the unpacked archive, before doing
anything else. Keep the output: it is the first thing anybody will ask for if
something goes wrong.

## 6. Install

Two ways to run it, both using the Node bundled in the archive: nothing to
separately fetch or approve.

**No install, no root, run it now**, as any user, in the foreground:

```sh
sh run-standalone.sh
```

Its data lives in a `./data` folder next to it. Good for a trial, a single
approver, or a machine where installing anything at all is off the table.
Stop it with Ctrl+C; start it again the same way.

**As a persistent service that survives a reboot**, needs root once:

```sh
sudo sh install.sh
```

What it does, in order: runs preflight and stops if it fails; creates the
`docforge` system account; copies the program and the bundled Node runtime to
`/opt/docforge`; writes `/etc/docforge/docforge.env` from the template if
there is none; installs the systemd unit; applies SELinux labels where SELinux
is present. On a first install it then stops and tells you to set the first
administrator's password:

```sh
sudoedit /etc/docforge/docforge.env      # DOCFORGE_ADMIN_PASSWORD=...
sudo systemctl enable --now docforge
sh verify-install.sh
```

The password needs twelve characters with upper case, lower case and a digit.
The account is `admin@localhost` unless `DOCFORGE_ADMIN_EMAIL` says otherwise.
**After the first sign-in, clear the password line and restart the service.** It
is only read when the user table is empty, but a password has no business
sitting in a file.

Where things end up:

| Path | Holds | Owner |
|---|---|---|
| `/opt/docforge` | Program and runtime, read only to the service | root |
| `/var/lib/docforge` | The database, and nothing else. **This is what you back up** | docforge |
| `/etc/docforge/docforge.env` | Settings | root, readable by docforge |
| `/etc/systemd/system/docforge.service` | The unit | root |

## 7. Putting TLS in front

The server speaks plain HTTP and expects a reverse proxy on the same machine to
terminate TLS. With a proxy in front, set `DOCFORGE_HOST=127.0.0.1` so the port
is not reachable from the network at all, and keep `DOCFORGE_SECURE_COOKIES=1`.

nginx:

```nginx
server {
    listen 443 ssl;
    server_name docs.example.internal;
    ssl_certificate     /etc/pki/tls/certs/docs.crt;
    ssl_certificate_key /etc/pki/tls/private/docs.key;
    client_max_body_size 60m;            # above DOCFORGE_MAX_UPLOAD_BYTES

    # Live co-editing is a WebSocket. Without these three lines the proxy
    # answers the upgrade as an ordinary request and it never opens.
    location /api/collab/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 3600s;        # an open document is a long-lived connection
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 120s;         # a large Word file takes a moment
    }
}
```

Apache httpd, with `mod_proxy` and `mod_proxy_http`:

```apache
<VirtualHost *:443>
    ServerName docs.example.internal
    SSLEngine on
    SSLCertificateFile    /etc/pki/tls/certs/docs.crt
    SSLCertificateKeyFile /etc/pki/tls/private/docs.key
    LimitRequestBody 62914560
    ProxyPreserveHost On
    # Live co-editing is a WebSocket: needs mod_proxy_wstunnel, and must come
    # before the general rule below.
    ProxyPass        /api/collab/ ws://127.0.0.1:8080/api/collab/
    ProxyPass        / http://127.0.0.1:8080/
    ProxyPassReverse / http://127.0.0.1:8080/
    RequestHeader set X-Forwarded-Proto "https"
</VirtualHost>
```

### If WebSockets are not allowed

Some networks do not carry them at all. Nothing breaks: after eight seconds the
editor says that live co-editing is not available and saves the ordinary way,
where the second of two people to save is refused rather than merged. To find
out which you have, open a document and watch for that message, or look for a
request to `/api/collab/` with status 101 in the browser's network panel.

Set `DOCFORGE_TRUST_PROXY=1` only when the proxy sets `X-Forwarded-For` itself,
as the nginx block above does. It makes the rate limits and the audit trail use
the real client address. With nothing in front, leave it at 0: the header would
come from whoever is connecting.

On RHEL-family systems with SELinux enforcing, the proxy needs permission to
connect to a local port, and the firewall needs the HTTPS port opened:

```sh
sudo setsebool -P httpd_can_network_connect 1
sudo firewall-cmd --permanent --add-service=https && sudo firewall-cmd --reload
```

## 8. Accounts

Accounts are local and managed by hand, which is deliberate for now: there is no
single sign-on and no directory lookup.

- The first administrator comes from the settings file, once.
- After that, self-registration is closed. An administrator creates every
  account on the Administration page, gives it a role (administrator, editor or
  viewer) and hands over a first password. People change their own password
  after signing in.
- An administrator can disable an account and reset its password. The last
  active administrator cannot be removed or demoted.
- Passwords are hashed with scrypt. Sessions are opaque tokens stored hashed,
  expire after twelve hours (`DOCFORGE_SESSION_TTL`), and sign-in attempts are
  rate limited (`DOCFORGE_LOGIN_RATE_LIMIT`).
- Every sign-in, account change, share and document action is written to the
  audit trail, which administrators can read on the same page.

## 9. Backup and restore

The database is one SQLite file in write-ahead mode. Copying only `docforge.db`
while the service runs can miss the newest changes, which live in
`docforge.db-wal` until they are folded in. Two safe ways:

```sh
# simplest: a few seconds of downtime
sudo systemctl stop docforge
sudo cp -a /var/lib/docforge /backup/docforge-$(date +%F)
sudo systemctl start docforge

# or, if the sqlite3 tool is on the machine, with no downtime
sudo -u docforge sqlite3 /var/lib/docforge/docforge.db ".backup '/backup/docforge-$(date +%F).db'"
```

To restore: stop the service, replace the contents of `/var/lib/docforge` with
the backup (remove any `-wal` and `-shm` files that did not come from it), make
sure `docforge` owns it, start the service.

## 10. Upgrade and roll back

An upgrade is the same command, run from the new release. The installer stops
the service, copies the database and its write-ahead log to
`/var/lib/docforge/backup-<time>`, replaces the program, keeps your settings and
starts again. Database migrations run on start and only ever add.

To roll back, run `install.sh` from the previous release's directory. If the
newer version had already migrated the database, restore the copy the upgrade
made as well: an older program does not understand a newer schema.

## 11. Watching it

```sh
systemctl status docforge
journalctl -u docforge -f             # one JSON object per line
curl -s http://127.0.0.1:8080/api/health
```

`/api/health` needs no sign-in and answers `{"status":"ok",...}`. Point your
monitoring at it. The log is structured JSON on standard output, so whatever
already collects the journal collects it, with no agent and nothing to
configure in the application.

## 12. Without systemd

`run-standalone.sh` (section 6) is the no-install answer to this. If you would
rather run it under your own process supervisor, the program is one command:

```sh
DOCFORGE_DB=/var/lib/docforge/docforge.db DOCFORGE_HOST=127.0.0.1 \
  /opt/docforge/node/bin/node --disable-warning=ExperimentalWarning /opt/docforge/server.mjs
```

It finds `web/` beside itself. Run it as an unprivileged account under your own
supervisor, and give that account write access to the database directory only.
`--disable-warning=ExperimentalWarning` hides one line Node prints because
`node:sqlite` is not yet fully stable; see section 15 for exactly what that
means for the version this release bundles.

## 13. Trying your own documents before a rollout

The most useful test is the one with your documents, not ours. On the build
machine, where the repository is:

```sh
npm run build
npm run try -- --keep roundtrip/ /path/to/some/real/documents
```

It starts a private copy of the server against a temporary database, uploads
each `.docx`, saves it unchanged, exports it, and reports per feature what
survived: headings, formatting, fonts, colour, alignment, tables, shading,
merged cells, pictures, headers and footers. It also counts what the document
contained that has no place in the model yet (comments, tracked changes,
footnotes, fields, text boxes), so nobody finds out from a reviewer. `--keep`
writes the exported copies out, to open in Word beside the originals. Nothing
is retained otherwise and nothing leaves the machine.

## 14. When something goes wrong

| What you see | Usual cause | What to do |
|---|---|---|
| `version 'GLIBC_2.28' not found` | The operating system is older than the Node binary supports | A newer OS, or a Node build made for that OS |
| `Cannot find module 'node:sqlite'` or `No such built-in module` | Node older than 22.5 | Use a newer Node; preflight catches this |
| Service starts, page is a 404 | `DOCFORGE_WEB_ROOT` points somewhere without `index.html` | Remove the setting, or point it at `/opt/docforge/web` |
| Service active, nobody can sign in, no administrator exists | `DOCFORGE_ADMIN_PASSWORD` was empty on the first start | Set it, restart, sign in, clear it |
| Sign-in succeeds then the next page says signed out | `DOCFORGE_SECURE_COOKIES=1` but the browser is on plain HTTP | Put TLS in front, or set it to 0 for a trial on a private network |
| `status=203/EXEC` in `systemctl status` | The node path in the unit is wrong, or the file system is mounted `noexec` | `grep ExecStart /etc/systemd/system/docforge.service`; move Node somewhere executable |
| `status=226/NAMESPACE` | An older systemd that does not know one of the sandboxing settings | Comment that setting out in the unit and tell us which |
| `attempt to write a readonly database` | The data directory is not owned by `docforge`, or is outside `ReadWritePaths` | `chown -R docforge: /var/lib/docforge`; keep `DOCFORGE_DB` under that directory |
| 502 from the proxy, service is healthy | SELinux is stopping the proxy connecting | `setsebool -P httpd_can_network_connect 1` |
| "Live co-editing is not available on this connection" | The proxy does not pass WebSocket upgrades, or the network blocks them | Add the `/api/collab/` rule from section 7; if the network forbids WebSockets, the fallback is working as designed |
| Arabic, Chinese or Hindi text is "?" in an exported PDF | No font on the server covers it | Put a `.ttf` or `.otf` (DejaVu, Noto) in a folder and name it in `DOCFORGE_FONT_DIRS`. Word export is not affected |
| 413 on a large upload | The proxy's body limit is below the application's | Raise `client_max_body_size` or `LimitRequestBody` |
| Everybody shares one rate limit, audit shows the proxy's address | `DOCFORGE_TRUST_PROXY` is 0 behind a proxy | Set it to 1, once the proxy sets `X-Forwarded-For` |

### What to send back

A trial install exists to find these. For any problem, send:

1. The full output of `sh preflight.sh`.
2. `journalctl -u docforge -n 100 --no-pager`.
3. `cat /opt/docforge/VERSION`.
4. The step you were on, and what you expected.

None of those contain document content or passwords. Read them before sending
all the same: the journal records the email addresses of people who sign in.

## 15. For the security and licence review

- **Licences.** DocForge is MIT. Everything compiled into it is MIT, ISC,
  BSD-3-Clause, Apache-2.0, BlueOak-1.0.0, 0BSD or Zlib, plus two spelling
  dictionaries under the SCOWL word-list terms (permissive, read by hand,
  not an SPDX identifier): no GPL, no AGPL, no licence that places
  conditions on the software using it. One package, jszip, is offered under
  "MIT or GPL-3.0" and is used under MIT. `THIRD-PARTY-NOTICES.txt` and
  `sbom.cdx.json` (CycloneDX, for a scanner) list every shipped package with
  its version and licence, and `npm run notices` fails the release if a
  dependency ever arrives under anything else. See `docs/12-requirements-and-bom.md`.
- **No outbound traffic.** Tested on every build, and enforced by the unit.
- **No LibreOffice, ever, in the running application.** PDF reading and
  writing are both plain JavaScript inside `server.mjs`. LibreOffice appears
  exactly once in this codebase, in a developer's own test-fixture generator
  that runs on a developer's machine only and is never packaged or shipped.
- **Data at rest.** One SQLite file. Documents are stored as JSON; a picture
  over 64 KB is kept in a table of its own, referenced by the document rather
  than embedded in it. Uploaded Word and PDF files are converted and not kept
  as files on disk (the original bytes are kept, to answer "export the
  original", in the same database). Disk encryption is the platform's job.
- **Sandboxing.** The unit runs the service unprivileged with a read-only view
  of the system, a private `/tmp`, no new privileges and write access to its
  data directory alone. `MemoryDenyWriteExecute` is deliberately not set: it is
  incompatible with any JIT runtime, Node included, and the unit says so.
- **Uploads.** Size capped at 50 MB, rate limited, checked as a zip before
  being read, and refused if they expand beyond 200 MB; XML is parsed with no
  DTDs and no entity declarations. A picture over 25 MB, or pictures totalling
  over 40 MB in one document, is left out of the editor and the import says
  so, though the original file (and the picture) is always still there to
  export again unchanged. Links are limited to http, https and mailto;
  pictures to embedded data or this server's own picture store.
- **The WebSocket.** One, to this origin only, signed in by the same session
  cookie, refused for anybody the document is not shared with. Somebody with
  view access receives the document and what they send to change it is dropped
  on the server.
- **PDF handling.** Both directions are JavaScript inside `server.mjs`: no
  LibreOffice, no Ghostscript, no external process, nothing native.
- **Known limits to raise in review, not discover later.** The Node version
  bundled with each release is recorded in `NODE-VERSION.txt` inside it; as of
  this release that is a current Node LTS line, where `node:sqlite` is a
  release candidate (further along than "experimental", not yet declared fully
  stable), which is more settled than the project's documented floor of Node
  22.5. Storage is one file, so one instance: no clustering. There is no
  single sign-on yet.

## 16. Removing it

```sh
sudo sh install.sh --uninstall
```

Removes the service and `/opt/docforge`. It leaves the database and the
settings, and says where they are.
