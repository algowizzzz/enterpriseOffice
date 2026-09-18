/**
 * Runtime air-gap probe.
 *
 * Scanning a bundle for URL strings cannot tell a documentation link in a
 * library comment from an address the process will actually dial. This module
 * answers the question directly: it wraps the lowest layer every outbound
 * connection passes through and records any attempt to reach an address that is
 * not the loopback interface.
 *
 * Load it with `node --import ./scripts/no-outbound-preload.mjs server.mjs` and
 * set DOCFORGE_OUTBOUND_LOG to the file that should collect the attempts. The
 * smoke test does both, then asserts the file stayed empty.
 *
 * This is a test instrument. It is never loaded in a real deployment.
 */
import net from 'node:net';
import dns from 'node:dns';
import { appendFileSync } from 'node:fs';

const LOG = process.env['DOCFORGE_OUTBOUND_LOG'];

function isLocal(host) {
  if (!host) return true;
  const value = String(host).toLowerCase();
  return (
    value === 'localhost' ||
    value === '127.0.0.1' ||
    value === '::1' ||
    value === '0.0.0.0' ||
    value === '::' ||
    value.startsWith('127.') ||
    value.startsWith('/') // a unix domain socket path
  );
}

function report(kind, host, detail) {
  const line = `${new Date().toISOString()} ${kind} ${host}${detail ? ` ${detail}` : ''}\n`;
  if (LOG) {
    try {
      appendFileSync(LOG, line);
    } catch {
      // Nothing useful to do if the log cannot be written.
    }
  }
  process.stderr.write(`OUTBOUND ATTEMPT: ${line}`);
}

// Every outbound TCP connection, including those made by http, https and fetch,
// reaches net.Socket.prototype.connect.
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  let host;
  const [first] = args;
  if (typeof first === 'object' && first !== null) host = first.host ?? first.path;
  else if (typeof first === 'number') host = typeof args[1] === 'string' ? args[1] : 'localhost';
  else host = first;
  if (!isLocal(host)) report('tcp', String(host));
  return originalConnect.apply(this, args);
};

// A name lookup is an outbound request in its own right, and it happens before
// the socket is opened, so catch it separately.
const originalLookup = dns.lookup;
dns.lookup = function lookup(hostname, ...rest) {
  if (!isLocal(hostname)) report('dns', String(hostname));
  return originalLookup.call(this, hostname, ...rest);
};

for (const method of ['resolve', 'resolve4', 'resolve6', 'resolveAny']) {
  const original = dns[method];
  if (typeof original !== 'function') continue;
  dns[method] = function resolver(hostname, ...rest) {
    if (!isLocal(hostname)) report('dns', String(hostname));
    return original.call(this, hostname, ...rest);
  };
}
