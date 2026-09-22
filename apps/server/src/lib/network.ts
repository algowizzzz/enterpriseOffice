import { isIP } from 'node:net';
import { badRequest } from '../errors.js';

// ICANN has reserved `.internal` for exactly this purpose since 2021; `.local`,
// `.lan`, `.corp`, `.home` and `.test` are long-standing conventions for a name
// that only resolves inside a private network. A hostname under one of these
// is treated as private without a DNS lookup, since none of them are ever
// handed out on the public internet.
const INTERNAL_TLDS = ['.internal', '.local', '.lan', '.corp', '.home', '.test'];

function ipv4IsPrivate(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

function ipv6IsPrivate(ip: string): boolean {
  const host = ip.toLowerCase();
  if (host === '::1') return true; // loopback
  if (host.startsWith('fe80:')) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7, unique local
  return false;
}

/**
 * Whether a host is reachable only on a private network rather than the
 * public internet: a literal address in a private, loopback or link-local
 * range; `localhost`; a bare hostname with no dot (the shape of an internal
 * DNS name with no public suffix, e.g. `llm-gpu01`); or a name under one of
 * the TLDs reserved for internal use. Deliberately synchronous and without a
 * DNS lookup or network call of its own: this runs on every endpoint create
 * and update, and this product's one deliberate exception to "nothing is
 * fetched at run time" is the explicit "Test connection" action, not
 * registering an address (see docs/16-ai-integration.md §7 and §12).
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost') return true;
  const version = isIP(host);
  if (version === 4) return ipv4IsPrivate(host);
  if (version === 6) return ipv6IsPrivate(host);
  if (!host.includes('.')) return true;
  return INTERNAL_TLDS.some((tld) => host.endsWith(tld));
}

/** Parses and validates an endpoint URL: http(s) only, host on a private network only. */
export function validateEndpointUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw badRequest('That is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('The endpoint URL must be http or https.');
  }
  if (!isPrivateHostname(url.hostname)) {
    throw badRequest(
      `"${url.hostname}" does not look like an address on a private network. ` +
        'Register only endpoints reachable inside your own network, never one on the public internet.',
    );
  }
  return url;
}
