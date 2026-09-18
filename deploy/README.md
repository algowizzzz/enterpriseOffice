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

Copy a Node 22 runtime, `server.mjs` and `web/` onto the machine, then:

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

## Docker

```
docker build -f deploy/docker/Dockerfile -t docforge:latest .
docker run -d --name docforge -p 8080:8080 \
  -v docforge-data:/var/lib/docforge \
  -e DOCFORGE_ADMIN_PASSWORD='choose-a-strong-one' \
  docforge:latest
```

The runtime image carries no package manager and no dependency tree.

## Windows laptop

Copy a folder containing `node/` (a portable Node 22 runtime), `server.mjs`,
`web/` and `deploy/windows/start-docforge.cmd`. Double-click the script. It
opens the browser at the local address and keeps the data in
`%LOCALAPPDATA%\DocForge`.

The same host also serves other people on the same network if you change
`DOCFORGE_HOST` to `0.0.0.0`.

## Backups

Everything is in the SQLite database named by `DOCFORGE_DB`. Stop the service,
copy the `.db`, `.db-wal` and `.db-shm` files, and restart. Nothing else on disk
holds user data.

## Upgrades

Replace `server.mjs` and `web/`, then restart. Schema migrations run on start
and are recorded in the `schema_migrations` table, so an upgrade is safe to
repeat and a downgrade needs a restored backup.
