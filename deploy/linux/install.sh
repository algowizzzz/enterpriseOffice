#!/bin/sh
# Install DocForge as a systemd service on a Linux server. Nothing is
# downloaded and nothing else needs installing first: this release already
# carries the Node runtime it needs, next to this script.
#
#   sudo sh install.sh                          # uses the Node bundled here
#   sudo sh install.sh --node-archive node-v24.x.y-linux-x64.tar.xz
#   sudo sh install.sh --node /usr/local/bin/node
#   sudo sh install.sh --uninstall              # leaves the data where it is
#
# The two flags above are for an organisation that would rather run its own
# approved copy of Node than the one this release brought; most people need
# neither. Run it from the unpacked release. Running it again is an upgrade:
# the program files are replaced, the database is copied aside first, and the
# settings in /etc/docforge/docforge.env are never touched once they exist.
#
# No sudo, or would rather not touch systemd at all? Run run-standalone.sh
# instead, from this same folder: no root, no service, works the same way.
#
# POSIX sh on purpose. A hardened image may not have bash.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/docforge
DATA=/var/lib/docforge
CONF=/etc/docforge
UNIT=/etc/systemd/system/docforge.service
NODE=""
NODE_ARCHIVE=""
UNINSTALL=0

while [ $# -gt 0 ]; do
	case "$1" in
		--node) NODE="$2"; shift 2 ;;
		--node-archive) NODE_ARCHIVE="$2"; shift 2 ;;
		--uninstall) UNINSTALL=1; shift ;;
		-h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "Unknown option: $1" >&2; exit 2 ;;
	esac
done

say() { printf '\n== %s\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
	echo "Run this as root: it creates a service account and a systemd unit." >&2
	exit 1
fi

if [ "$UNINSTALL" -eq 1 ]; then
	say "Removing the service and the program"
	systemctl disable --now docforge 2>/dev/null || true
	rm -f "$UNIT"
	systemctl daemon-reload
	rm -rf "$APP"
	echo "Removed. The database in $DATA and the settings in $CONF were left alone."
	echo "Delete them yourself when you are sure: rm -rf $DATA $CONF; userdel docforge"
	exit 0
fi

say "Runtime"
# Only decided here, not yet written anywhere: preflight has to run against
# the Node that would be used before anything is touched, and $APP must stay
# exactly as it was until preflight, and everything after it, has agreed to
# go ahead. Writing the new runtime into $APP at this point, before knowing
# whether the rest of the install proceeds, would mean a failed preflight on
# an upgrade leaves a working install with its Node already swapped under it.
NODE_STAGE_SRC=""
TMP_NODE_EXTRACT=""
cleanup() { [ -n "$TMP_NODE_EXTRACT" ] && rm -rf "$TMP_NODE_EXTRACT"; }
trap cleanup EXIT

if [ -n "$NODE_ARCHIVE" ]; then
	[ -f "$NODE_ARCHIVE" ] || { echo "No such file: $NODE_ARCHIVE" >&2; exit 1; }
	# The official archive has one top-level directory, node-vX-linux-ARCH.
	# Strip it so the path is the same after every upgrade of Node.
	TMP_NODE_EXTRACT="$(mktemp -d)"
	case "$NODE_ARCHIVE" in
		*.tar.xz) tar -xJf "$NODE_ARCHIVE" -C "$TMP_NODE_EXTRACT" --strip-components=1 ;;
		*.tar.gz|*.tgz) tar -xzf "$NODE_ARCHIVE" -C "$TMP_NODE_EXTRACT" --strip-components=1 ;;
		*) echo "Expected a .tar.xz or .tar.gz archive of Node" >&2; exit 1 ;;
	esac
	NODE_STAGE_SRC="$TMP_NODE_EXTRACT"
	NODE="$TMP_NODE_EXTRACT/bin/node"
elif [ -n "$NODE" ]; then
	: # --node points at a path the admin says is stable (a system-wide
	  # install, or their own organisation's approved copy); used as given,
	  # nothing to stage into $APP.
elif [ -x "$HERE/node/bin/node" ]; then
	# The common case: this release already carries its own Node, staged right
	# next to this script. Nothing to fetch, nothing to ask for. Not run
	# directly out of $HERE, though: $HERE is wherever this was unpacked, an
	# admin routinely deletes that folder once "install" has run, and a
	# systemd unit pointed at a deleted path fails silently on the next
	# reboot, long after anyone remembers running this script. It is copied
	# into $APP, like every other program file, once preflight has passed.
	echo "Found the Node runtime bundled with this release."
	NODE_STAGE_SRC="$HERE/node"
	NODE="$HERE/node/bin/node"
elif [ -x "$APP/node/bin/node" ]; then
	# An earlier install left one behind; a rebuild that used --skip-verify
	# without re-bundling Node can land here on an upgrade. Already in its
	# final place, so there is nothing further to stage.
	NODE="$APP/node/bin/node"
fi
if [ -z "$NODE" ]; then
	NODE="$(command -v node || true)"
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || {
	echo "No Node runtime found: not bundled with this release, not already" >&2
	echo "installed at $APP, and not on PATH. Pass --node-archive or --node," >&2
	echo "or use a release archive that bundles Node for this machine's platform." >&2
	exit 1
}
echo "Using $NODE ($("$NODE" -v))"

say "Preflight"
# On an upgrade the port is in use by the very service being upgraded.
upgrading=0
if systemctl is-active --quiet docforge 2>/dev/null; then upgrading=1; fi
if [ "$upgrading" -eq 1 ]; then systemctl stop docforge; fi
sh "$HERE/preflight.sh" "$NODE" || {
	if [ "$upgrading" -eq 1 ]; then systemctl start docforge || true; fi
	echo "Stopped before replacing any program files or settings." >&2
	exit 1
}

say "Account and directories"
if ! id docforge >/dev/null 2>&1; then
	useradd --system --home-dir "$DATA" --shell /sbin/nologin docforge 2>/dev/null \
		|| useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin docforge
	echo "Created the docforge service account"
fi
mkdir -p "$APP" "$DATA" "$CONF"

if [ -f "$DATA/docforge.db" ]; then
	# The service is stopped, so a plain copy is a consistent one, as long as the
	# write-ahead log goes with it: after an unclean stop the newest changes are
	# in docforge.db-wal and not yet in docforge.db.
	stamp="$(date +%Y%m%d-%H%M%S)"
	mkdir -p "$DATA/backup-$stamp"
	for part in docforge.db docforge.db-wal docforge.db-shm; do
		if [ -f "$DATA/$part" ]; then cp -p "$DATA/$part" "$DATA/backup-$stamp/"; fi
	done
	echo "Copied the database to $DATA/backup-$stamp"
fi

say "Program files"
if [ -n "$NODE_STAGE_SRC" ]; then
	# Preflight has passed; safe now to replace what a running service (if any)
	# depends on. Written under a temporary name and renamed into place so that
	# nothing ever sees a half-copied runtime.
	rm -rf "$APP/node.new"
	mkdir -p "$APP/node.new"
	cp -R "$NODE_STAGE_SRC/." "$APP/node.new/"
	rm -rf "$APP/node"
	mv "$APP/node.new" "$APP/node"
	NODE="$APP/node/bin/node"
	echo "Installed the Node runtime into $APP/node"
fi
cp "$HERE/server.mjs" "$APP/server.mjs.new"
mv "$APP/server.mjs.new" "$APP/server.mjs"
rm -rf "$APP/web.new"
cp -R "$HERE/web" "$APP/web.new"
rm -rf "$APP/web"
mv "$APP/web.new" "$APP/web"
for extra in THIRD-PARTY-NOTICES.txt LICENSE VERSION; do
	if [ -f "$HERE/$extra" ]; then cp "$HERE/$extra" "$APP/"; fi
done
echo "Installed $(cat "$HERE/VERSION" 2>/dev/null || echo 'an unversioned build') into $APP"

say "Settings"
first_install=0
if [ ! -f "$CONF/docforge.env" ]; then
	first_install=1
	cp "$HERE/env.example" "$CONF/docforge.env"
	echo "Wrote $CONF/docforge.env from the template"
else
	echo "Kept the existing $CONF/docforge.env"
fi
# The file holds the first administrator's password until it is cleared.
chown root:docforge "$CONF/docforge.env"
chmod 640 "$CONF/docforge.env"
chown -R docforge:docforge "$DATA"
chmod 750 "$DATA"
chown -R root:root "$APP"

say "Service"
# The unit names /usr/bin/node. Point it at the runtime actually chosen.
sed "s|^ExecStart=/usr/bin/node |ExecStart=$NODE |" "$HERE/docforge.service" > "$UNIT"
chmod 644 "$UNIT"
# Files under /opt/*/bin are labelled as programs by the default SELinux policy,
# but only once something applies the policy to the new files.
if command -v restorecon >/dev/null 2>&1; then restorecon -R "$APP" "$DATA" "$CONF" "$UNIT" 2>/dev/null || true; fi
systemctl daemon-reload

password_set=0
if grep -q '^DOCFORGE_ADMIN_PASSWORD=..*' "$CONF/docforge.env"; then password_set=1; fi
if [ "$first_install" -eq 1 ] && [ "$password_set" -eq 0 ]; then
	cat <<EOF

Installed, not started. One thing is yours to do first:

  1. Put a password for the first administrator in $CONF/docforge.env
       DOCFORGE_ADMIN_PASSWORD=...
     Twelve characters or more, with upper and lower case and a digit.
     Without it no account is created and nobody can sign in.
  2. systemctl enable --now docforge
  3. sh $HERE/verify-install.sh
  4. Sign in, then clear that line again and restart the service.
EOF
	exit 0
fi

systemctl enable docforge >/dev/null 2>&1 || true
systemctl restart docforge
sh "$HERE/verify-install.sh" "$NODE"
