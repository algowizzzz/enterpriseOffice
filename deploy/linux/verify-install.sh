#!/bin/sh
# Check a running install from the server itself. Needs no curl: a locked-down
# image often has none, and node is known to be there.
#
#   sh verify-install.sh [path/to/node]
#
# It proves the page is served, not only that the API answers. A build once
# passed its health check while serving a 404 for the page, and "the API returned
# 200" was taken as "it works".

NODE="${1:-}"
if [ -z "$NODE" ]; then
	if [ -x /opt/docforge/node/bin/node ]; then NODE=/opt/docforge/node/bin/node; else NODE=node; fi
fi
PORT="$(sed -n 's/^DOCFORGE_PORT=//p' /etc/docforge/docforge.env 2>/dev/null | tail -n 1)"
PORT="${PORT:-8080}"

echo
echo "== Checking the running service on port $PORT"
"$NODE" -e '
const base = "http://127.0.0.1:" + process.argv[1];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let failed = 0;
const check = (name, passed, detail) => {
  console.log((passed ? "  ok    " : "  FAIL  ") + name + (passed || !detail ? "" : ": " + detail));
  if (!passed) failed += 1;
};
(async () => {
  let health = null;
  for (let i = 0; i < 40 && !health; i += 1) {
    try { const r = await fetch(base + "/api/health"); if (r.ok) health = await r.json(); } catch {}
    if (!health) await sleep(500);
  }
  check("the service answers its health check", Boolean(health), "nothing on " + base + " after 20 seconds");
  if (!health) return;
  const page = await fetch(base + "/");
  const html = await page.text();
  check("the sign-in page is served", page.ok && html.includes("<div id=\"root\""), "status " + page.status);
  const asset = /(?:src|href)="(\/assets\/[^"]+\.js)"/.exec(html);
  if (asset) {
    const script = await fetch(base + asset[1]);
    check("the client script is served", script.ok, "status " + script.status);
  }
  check("a content security policy is set", Boolean(page.headers.get("content-security-policy")));
  const boot = await (await fetch(base + "/api/auth/bootstrap")).json().catch(() => null);
  if (boot && typeof boot === "object") {
    const needs = boot.needsSetup;
    if (needs === true) check("an administrator account exists", false, "set DOCFORGE_ADMIN_PASSWORD and restart");
    else if (needs === false) check("an administrator account exists", true);
  }
  const anonymous = await fetch(base + "/api/documents");
  check("an anonymous request is refused", anonymous.status === 401, "status " + anonymous.status);
})().catch((error) => { console.log("  FAIL  " + error.message); failed += 1; })
  .finally(() => {
    console.log(failed ? "\n" + failed + " check(s) failed. journalctl -u docforge -n 50 says why." : "\nThe install is serving.");
    process.exit(failed ? 1 : 0);
  });
' "$PORT"
