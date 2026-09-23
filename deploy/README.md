# Deploying DocForge

Three supported shapes. All of them are offline: nothing is fetched at run time.

## Build the release artifacts

On a machine that can reach a package registry:

```
npm ci
npm run verify
```

`verify` typechecks, runs both unit suites, builds, audits the browser bundle
for remote URLs, and runs the end-to-end smoke test against the built server
with an outbound-connection probe attached. It must pass before you ship.

The artifacts are:

| Path | What it is |
|---|---|
| `apps/server/dist/server.mjs` | The whole server in one file. No `node_modules`. |
| `apps/web/dist/` | The browser client. Serve it, or let the server serve it. |

## Linux server, air gapped

The supported route is the release archive and its installer, which check the
machine first, keep a copy of the database on upgrade and verify the result:

```
npm run release                      # on a connected machine
sh preflight.sh                      # on the server, from the unpacked archive
sudo sh install.sh --node-archive node-v22.x.y-linux-x64.tar.xz
```

`docs/08-enterprise-deployment.md` is the full guide: TLS, SELinux, accounts,
backup, upgrade, troubleshooting and what a security review will ask. The
archive carries a copy as `DEPLOY.md`.

By hand, the same thing is: copy a Node 22 runtime, `server.mjs` and `web/` onto
the machine, then:

```
sudo useradd --system --create-home docforge
sudo mkdir -p /opt/docforge /var/lib/docforge /etc/docforge
sudo cp server.mjs /opt/docforge/
sudo cp -r web /opt/docforge/
sudo cp deploy/systemd/docforge.service /etc/systemd/system/
sudo cp .env.example /etc/docforge/docforge.env   # then edit it
sudo chown -R docforge:docforge /var/lib/docforge /opt/docforge
sudo systemctl enable --now docforge
```

Set `DOCFORGE_ADMIN_PASSWORD` in `/etc/docforge/docforge.env` before the first
start, otherwise no account is created and nobody can sign in. Clear it once you
have signed in.

Put a reverse proxy in front for TLS and set `DOCFORGE_SECURE_COOKIES=1`.

If, and only if, that proxy sets `X-Forwarded-For` itself, also set
`DOCFORGE_TRUST_PROXY=1` so the rate limits and the audit trail record the real
client address rather than the proxy's. Leave it off otherwise: with nothing in
front of the server, that header comes from whoever is connecting, who could
then use a new value for every sign-in attempt to escape the rate limit and
write any address they like into the audit trail.

## Docker

```
docker build -f deploy/docker/Dockerfile -t docforge:latest .
docker run -d --name docforge -p 8080:8080 \
  -v docforge-data:/var/lib/docforge \
  -e DOCFORGE_ADMIN_PASSWORD='choose-a-strong-one' \
  docforge:latest
```

The runtime image carries no package manager and no dependency tree.

## macOS laptop

For one person, or for developing against the real build.

```sh
brew install node          # Node 22.5 or newer; `node -v` to check
npm ci
npm run verify
DOCFORGE_ADMIN_PASSWORD='Choose-A-Strong-One-1' npm run build
DOCFORGE_ADMIN_PASSWORD='Choose-A-Strong-One-1' npm start
```

Open `http://127.0.0.1:8080`. The database is `./data/docforge.db` unless
`DOCFORGE_DB` says otherwise; back that file up and you have backed up
everything.

Node 22.5 is a hard floor: storage is Node's built-in SQLite, and there is no
native module to fall back on. On an Apple Silicon Mac nothing needs compiling,
which is the point of that choice.

To keep it running in the background, put a launch agent at
`~/Library/LaunchAgents/com.docforge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.docforge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/you/enterpriseOffice/apps/server/dist/server.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>DOCFORGE_HOST</key><string>127.0.0.1</string>
    <key>DOCFORGE_PORT</key><string>8080</string>
    <key>DOCFORGE_DB</key><string>/Users/you/Library/Application Support/DocForge/docforge.db</string>
    <key>DOCFORGE_WEB_ROOT</key><string>/Users/you/enterpriseOffice/apps/web/dist</string>
    <key>DOCFORGE_SECURE_COOKIES</key><string>0</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

Then `launchctl load ~/Library/LaunchAgents/com.docforge.plist`. Set
`DOCFORGE_ADMIN_PASSWORD` for the first start only, and remove it afterwards.

Bind to `127.0.0.1`, not `0.0.0.0`, unless you mean to serve the network from
your laptop: without TLS in front, `DOCFORGE_SECURE_COOKIES=0` means the session
cookie travels in the clear.

## Windows laptop

Copy a folder containing `node/` (a portable Node 22 runtime), `server.mjs`,
`web/` and `deploy/windows/start-docforge.cmd`. Double-click the script. It
opens the browser at the local address and keeps the data in
`%LOCALAPPDATA%\DocForge`.

The same host also serves other people on the same network if you change
`DOCFORGE_HOST` to `0.0.0.0`.

## Verify an install

Five checks, in order. They need nothing but `curl`, and each one fails loudly
rather than quietly.

```bash
BASE=http://127.0.0.1:8080

# 1. The service is up.
curl -sf $BASE/api/health

# 2. The client is being served, not just the API.
curl -s $BASE/ | grep -q 'id="root"' && echo "client ok"

# 3. The seed administrator exists and can sign in.
curl -s -c /tmp/df -X POST $BASE/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@localhost","password":"THE-PASSWORD-YOU-SET"}'

# 4. A document can be created and exported as a real Word file.
ID=$(curl -s -b /tmp/df -X POST $BASE/api/documents \
  -H 'content-type: application/json' -d '{"title":"Install check"}' \
  | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
curl -s -b /tmp/df "$BASE/api/documents/$ID/export" -o /tmp/check.docx
head -c4 /tmp/check.docx | od -An -tx1   # must be 50 4b 03 04

# 5. Nothing was left behind.
rm -f /tmp/df /tmp/check.docx
```

Then restart the service and sign in again. The document must still be there and
there must still be exactly one account: the seed administrator is created only
when the user table is empty, so a restart with the password still configured
must not add a second one.

Clear `DOCFORGE_ADMIN_PASSWORD` once you have signed in.

## Backups

Everything is in the SQLite database named by `DOCFORGE_DB`. Stop the service,
copy the `.db`, `.db-wal` and `.db-shm` files, and restart. Nothing else on disk
holds user data.

## Upgrades

Replace `server.mjs` and `web/`, then restart. Schema migrations run on start
and are recorded in the `schema_migrations` table, so an upgrade is safe to
repeat and a downgrade needs a restored backup.
