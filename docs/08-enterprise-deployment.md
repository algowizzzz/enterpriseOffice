# Deploying on an air-gapped Linux server

For the person doing the install, and for the person reviewing it. Everything
here works with no network on the target machine. If a step reaches for the
network, that is a defect: report it.

The short version:

```sh
# on a machine that can reach a package registry
npm ci && npm run release            # writes release/docforge-<version>.tar.gz

# on the server, with the archive and an official Node 22 archive copied over
tar -xzf docforge-*.tar.gz && cd docforge-*/
sh preflight.sh                      # changes nothing, needs no root
sudo sh install.sh --node-archive ../node-v22.*-linux-x64.tar.xz
```

## 1. What is being deployed

| Piece | Size | What it is |
|---|---|---|
| `server.mjs` | about 3 MB | The whole server in one file. Every dependency is compiled in. |
| `web/` | under 1 MB | The browser client: one page, one script, one stylesheet. |
| Node 22 | about 30 MB packed | The runtime. Not in the archive: bring your own approved copy. |

There is no `node_modules` directory, no package manager, no compiler and no
database server on the target. Storage is SQLite, which is built into Node, in
one file under `/var/lib/docforge`. `npm` runs on the build machine and never on
the server.

The server makes no outbound connections. It does not check for updates, load
fonts, report usage or fetch anything. The release gate proves it: the end to
end test fails if the server opens a socket beyond loopback, and the build fails
if the browser bundle contains a remote address. The systemd unit then makes it
a property of the machine as well.

## 2. What the server needs

| Need | Detail |
|---|---|
| Processor | x86-64 or 64-bit ARM |
| Operating system | Any Linux with glibc 2.28 or newer: RHEL, Rocky, Alma or Oracle 8 and later, Ubuntu 20.04 and later, Debian 10 and later, SLES 15 SP3 and later |
| Service manager | systemd. Without it, run `server.mjs` under whatever you use; see section 12 |
| Node | 22.5 or newer. This is a hard floor: the storage layer is `node:sqlite` |
| Memory and CPU | 1 GB and one core is comfortable for a team. Word conversion is the only heavy work |
| Disk | The program is under 40 MB with Node. Allow for the database: every save is kept as a version |
| Access | root for the install. The service runs as its own unprivileged account |
| Network | One inbound port, 8080 by default, normally reached only by a reverse proxy on the same machine |

`preflight.sh` checks every row of that table on the actual machine.

### Getting Node onto the machine

Use the official Linux archive, `node-v22.x.y-linux-x64.tar.xz` (or
`-linux-arm64`), from wherever your organisation keeps approved runtimes. If you
fetch it yourself, fetch `SHASUMS256.txt` from the same release and compare
before it crosses the gap. The installer unpacks it into `/opt/docforge/node`,
so it does not touch any Node the system already has, and nothing else on the
machine starts using it.

A distribution's own `nodejs` package is fine if it is 22.5 or newer and was
built with SQLite. Preflight tests that directly instead of trusting the version.

## 3. Building the release

On a machine that can reach a package registry, public or an internal mirror:

```sh
git clone <this repository> && cd enterpriseOffice
node -v                  # 22.5 or newer
npm ci                   # exact versions from the lockfile
npm run release
```

`npm run release` runs the whole gate first (lint, types, both test suites, the
build, the air-gap audit and the end to end run), then starts the packaged copy
on its own, with nothing beside it, to prove it serves the page. It writes:

```
release/docforge-<version>-<date>-<commit>.tar.gz
release/docforge-<version>-<date>-<commit>.tar.gz.sha256
```

Behind an internal registry mirror, point npm at it before `npm ci`
(`npm config set registry https://<your mirror>/`). npm swaps the public
registry's host for yours when it reads the lockfile, so the lockfile does not
need editing. If the mirror is missing a package, `npm ci` names it: that list
is what to ask the mirror's owners for.

Inside the archive:

| File | Purpose |
|---|---|
| `server.mjs`, `web/` | The program |
| `install.sh` | Install, upgrade, uninstall |
| `preflight.sh` | Can this machine run it? Changes nothing |
| `verify-install.sh` | Is the running service actually serving? |
| `docforge.service` | The systemd unit, sandboxed |
| `env.example` | Every setting, with production values |
| `THIRD-PARTY-NOTICES.txt` | Every package that ships, its version, licence and licence text |
| `SHA256SUMS` | A hash of every file above |
| `VERSION`, `LICENSE`, `DEPLOY.md` | What this is, and this guide |

## 4. Moving it across

Copy two files by whatever route your organisation allows: the release archive
and the Node archive. On the server:

```sh
sha256sum -c docforge-*.tar.gz.sha256
tar -xzf docforge-*.tar.gz
cd docforge-*/
sha256sum -c SHA256SUMS
```

Both checks should print `OK` for every line. A mismatch means the copy was
damaged or altered on the way: stop there.

## 5. Preflight

```sh
sh preflight.sh /path/to/node        # or no argument if node is on the PATH
```

No root, no changes. If Node is still packed, unpack it anywhere first
(`tar -xJf node-v22*.tar.xz`) and point preflight at `node-v22*/bin/node`. Keep
the output: it is the first thing anybody will ask for if something goes wrong.

## 6. Install

```sh
sudo sh install.sh --node-archive /path/to/node-v22.x.y-linux-x64.tar.xz
```

What it does, in order: unpacks Node into `/opt/docforge/node`; runs preflight
and stops if it fails; creates the `docforge` system account; copies the program
to `/opt/docforge`; writes `/etc/docforge/docforge.env` from the template if
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
    ProxyPass        / http://127.0.0.1:8080/
    ProxyPassReverse / http://127.0.0.1:8080/
    RequestHeader set X-Forwarded-Proto "https"
</VirtualHost>
```

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

`install.sh` is a convenience, not a requirement. The program is one command:

```sh
DOCFORGE_DB=/var/lib/docforge/docforge.db DOCFORGE_HOST=127.0.0.1 \
  /opt/docforge/node/bin/node --disable-warning=ExperimentalWarning /opt/docforge/server.mjs
```

It finds `web/` beside itself. Run it as an unprivileged account under your own
supervisor, and give that account write access to the database directory only.
`--disable-warning=ExperimentalWarning` hides one line Node 22 prints because
`node:sqlite` is still marked experimental there; see section 15.

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
  BSD-3-Clause, BlueOak-1.0.0 or Zlib: no GPL, no AGPL, no licence that places
  conditions on the software using it. One package, jszip, is offered under
  "MIT or GPL-3.0" and is used under MIT. `THIRD-PARTY-NOTICES.txt` lists every
  shipped package with its version and licence text, and `npm run notices`
  fails the release if a dependency ever arrives under anything else.
- **No outbound traffic.** Tested on every build, and enforced by the unit.
- **Data at rest.** One SQLite file. Documents are stored as JSON with pictures
  embedded; uploaded Word files are converted and not kept as files on disk.
  Disk encryption is the platform's job.
- **Sandboxing.** The unit runs the service unprivileged with a read-only view
  of the system, a private `/tmp`, no new privileges and write access to its
  data directory alone. `MemoryDenyWriteExecute` is deliberately not set: it is
  incompatible with any JIT runtime, Node included, and the unit says so.
- **Uploads.** Size capped, rate limited, checked as a zip before being read,
  and refused if they expand beyond 200 MB; XML is parsed with no DTDs and no
  entity declarations. Pictures over 2 MB each, or 8 MB in total, are left out
  of the imported document and the import says so. Links are limited
  to http, https and mailto; pictures to embedded data.
- **Known limits to raise in review, not discover later.** `node:sqlite` is
  marked experimental in Node 22, stable enough to pass this project's tests
  but a label a change board may ask about. Storage is one file, so one
  instance: no clustering. There is no single sign-on yet.

## 16. Removing it

```sh
sudo sh install.sh --uninstall
```

Removes the service and `/opt/docforge`. It leaves the database and the
settings, and says where they are.
