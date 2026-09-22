#!/bin/sh
# Run DocForge on a Linux server with nothing installed and no root.
#
#   sh run-standalone.sh
#
# Everything it needs is already beside this script: the Node runtime, the
# server, the client. It writes its database next to itself, in ./data, and
# needs no package manager, no systemd, no useradd, no sudo. This is the
# fastest way onto a locked-down box, and the right one when the answer to
# "can I install anything here" is no. For a service that starts on boot and
# survives a crash, use install.sh instead, which needs root once.
#
# POSIX sh on purpose. A hardened image may not have bash.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="$HERE/data"
mkdir -p "$DATA"

if [ ! -x "$HERE/node/bin/node" ]; then
	echo "node/bin/node is missing from this folder. This script only runs from" >&2
	echo "inside an unpacked DocForge release, which carries its own Node." >&2
	exit 1
fi

export NODE_ENV=production
export DOCFORGE_HOST="${DOCFORGE_HOST:-127.0.0.1}"
export DOCFORGE_PORT="${DOCFORGE_PORT:-8080}"
export DOCFORGE_DB="${DOCFORGE_DB:-$DATA/docforge.db}"
export DOCFORGE_WEB_ROOT="$HERE/web"
export DOCFORGE_SECURE_COOKIES="${DOCFORGE_SECURE_COOKIES:-0}"

if [ ! -f "$DATA/.bootstrapped" ] && [ -z "${DOCFORGE_ADMIN_PASSWORD:-}" ]; then
	cat <<EOF

First run: no administrator account exists yet. Set one now and start again:

  DOCFORGE_ADMIN_PASSWORD='Choose-A-Strong-One-1' sh run-standalone.sh

Twelve characters or more, with upper and lower case and a digit. The address
is admin@localhost unless you also set DOCFORGE_ADMIN_EMAIL. Sign in once,
then leave the password out of every start after this one: it is only read
while the account table is empty.
EOF
	exit 0
fi
touch "$DATA/.bootstrapped"

echo "Starting DocForge at http://$DOCFORGE_HOST:$DOCFORGE_PORT (Ctrl+C to stop)"
exec "$HERE/node/bin/node" --disable-warning=ExperimentalWarning "$HERE/server.mjs"
