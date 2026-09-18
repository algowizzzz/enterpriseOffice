#!/bin/sh
# Check that this machine can run DocForge, before installing anything.
#
#   sh preflight.sh [path/to/node]
#
# Changes nothing and needs no root. Run it first on a locked-down server: every
# line it prints is something that would otherwise surface half way through an
# install, as an error about something else. Send the whole output back with any
# problem report.
#
# POSIX sh on purpose. A hardened image may not have bash.

NODE="${1:-${DOCFORGE_NODE:-node}}"
PORT="${DOCFORGE_PORT:-8080}"
HERE="$(cd "$(dirname "$0")" && pwd)"
fails=0
warns=0

ok()   { printf '  ok    %s\n' "$1"; }
warn() { printf '  WARN  %s\n' "$1"; warns=$((warns + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }

echo "DocForge preflight"
echo

echo "Machine"
printf '        %s\n' "$(uname -srm)"
if [ -r /etc/os-release ]; then
	# shellcheck disable=SC1091
	printf '        %s\n' "$(. /etc/os-release && echo "$PRETTY_NAME")"
fi
case "$(uname -m)" in
	x86_64|amd64|aarch64|arm64) ok "a processor Node publishes builds for ($(uname -m))" ;;
	*) fail "no official Node build for $(uname -m)" ;;
esac

# The official Node 22 binaries are linked against glibc 2.28, which is RHEL 8,
# Debian 10, Ubuntu 18.10 and later. On anything older the binary does not start
# and the message ("version GLIBC_2.28 not found") does not mention Node.
if command -v ldd >/dev/null 2>&1; then
	libc="$(ldd --version 2>&1 | head -n 1)"
	case "$libc" in
		*musl*) warn "musl libc: use a musl build of Node, the official binaries need glibc" ;;
		*)
			version="$(printf '%s' "$libc" | grep -o '[0-9][0-9]*\.[0-9][0-9]*' | tail -n 1)"
			major="${version%%.*}"; minor="${version##*.}"
			if [ -n "$version" ] && { [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 28 ]; }; }; then
				ok "glibc $version (2.28 or newer is needed)"
			else
				fail "glibc ${version:-unknown}: the official Node 22 binaries need 2.28 or newer"
			fi ;;
	esac
else
	warn "ldd not found, so the C library version was not checked"
fi
echo

echo "Node runtime"
if ! command -v "$NODE" >/dev/null 2>&1 && [ ! -x "$NODE" ]; then
	fail "node not found (looked for \"$NODE\"). Pass the path: sh preflight.sh /path/to/bin/node"
else
	version="$("$NODE" -v 2>/dev/null)"
	printf '        %s at %s\n' "$version" "$(command -v "$NODE" 2>/dev/null || echo "$NODE")"
	plain="${version#v}"; major="${plain%%.*}"; rest="${plain#*.}"; minor="${rest%%.*}"
	if [ "${major:-0}" -gt 22 ] || { [ "${major:-0}" -eq 22 ] && [ "${minor:-0}" -ge 5 ]; }; then
		ok "Node $version (22.5 or newer is needed)"
	else
		fail "Node $version is too old: 22.5 is a hard floor, storage is Node's built-in SQLite"
	fi
	# A distribution can build Node without SQLite. Ask, do not assume.
	if "$NODE" --disable-warning=ExperimentalWarning -e "
		const { DatabaseSync } = require('node:sqlite');
		const db = new DatabaseSync(':memory:');
		db.exec('create table t (x)'); db.prepare('insert into t values (?)').run(1);
		if (db.prepare('select count(*) as n from t').get().n !== 1) process.exit(1);
	" >/dev/null 2>&1; then
		ok "node:sqlite opens, writes and reads"
	else
		fail "node:sqlite is not usable in this build of Node"
	fi
	if "$NODE" -e "require('node:crypto').scryptSync('a','b',16)" >/dev/null 2>&1; then
		ok "node:crypto works (password hashing)"
	else
		fail "node:crypto scrypt failed, which a FIPS-restricted build can cause"
	fi
fi
echo

echo "Release files"
for item in server.mjs web/index.html docforge.service env.example SHA256SUMS; do
	if [ -e "$HERE/$item" ]; then ok "$item"; else fail "$item is missing from $HERE"; fi
done
if [ -f "$HERE/SHA256SUMS" ] && command -v sha256sum >/dev/null 2>&1; then
	if (cd "$HERE" && sha256sum -c --quiet SHA256SUMS >/dev/null 2>&1); then
		ok "every file matches SHA256SUMS"
	else
		fail "a file does not match SHA256SUMS: the copy was damaged or changed in transit"
	fi
fi
echo

echo "Host"
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
	ok "systemd is running ($(systemctl --version | head -n 1))"
else
	warn "no systemd: install.sh cannot register a service, run server.mjs under your own supervisor"
fi
if command -v ss >/dev/null 2>&1; then
	if ss -ltn 2>/dev/null | grep -q "[:.]$PORT[[:space:]]"; then
		fail "port $PORT is already in use: set DOCFORGE_PORT to another"
	else
		ok "port $PORT is free"
	fi
else
	warn "ss not found, so port $PORT was not checked"
fi
if command -v getenforce >/dev/null 2>&1; then
	mode="$(getenforce 2>/dev/null)"
	if [ "$mode" = "Enforcing" ]; then
		warn "SELinux is enforcing: a reverse proxy needs httpd_can_network_connect, see the guide"
	else
		ok "SELinux is $mode"
	fi
fi
# A noexec /opt or /var is common on hardened images. Node reads server.mjs
# rather than executing it, so only the node binary itself has to be executable
# where it lives.
for dir in /opt /var/lib; do
	if command -v findmnt >/dev/null 2>&1; then
		opts="$(findmnt -n -o OPTIONS -T "$dir" 2>/dev/null)"
		case ",$opts," in
			*,ro,*) fail "$dir is mounted read only" ;;
			*,noexec,*) warn "$dir is mounted noexec: keep the node binary somewhere executable" ;;
			*) ok "$dir is writable and executable by mount options" ;;
		esac
	fi
done
avail="$(df -Pk /var/lib 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "$avail" ]; then
	if [ "$avail" -lt 1048576 ]; then warn "less than 1 GB free under /var/lib, where the database lives"
	else ok "$((avail / 1024)) MB free under /var/lib"; fi
fi
echo

if [ "$fails" -gt 0 ]; then
	echo "$fails problem(s) would stop an install, $warns warning(s)."
	exit 1
fi
echo "Ready to install. $warns warning(s)."
