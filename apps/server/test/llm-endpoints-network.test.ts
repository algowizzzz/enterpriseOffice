import { describe, expect, it } from 'vitest';
import { isPrivateHostname, validateEndpointUrl } from '../src/lib/network.js';

describe('isPrivateHostname', () => {
  it('accepts loopback and localhost', () => {
    expect(isPrivateHostname('localhost')).toBe(true);
    expect(isPrivateHostname('127.0.0.1')).toBe(true);
    expect(isPrivateHostname('::1')).toBe(true);
  });

  it('accepts the private IPv4 ranges', () => {
    expect(isPrivateHostname('10.0.0.5')).toBe(true);
    expect(isPrivateHostname('172.16.0.1')).toBe(true);
    expect(isPrivateHostname('172.31.255.255')).toBe(true);
    expect(isPrivateHostname('192.168.1.1')).toBe(true);
    expect(isPrivateHostname('169.254.1.1')).toBe(true);
  });

  it('rejects a public IPv4 address, including one just outside a private range', () => {
    expect(isPrivateHostname('8.8.8.8')).toBe(false);
    expect(isPrivateHostname('172.32.0.1')).toBe(false); // one above 172.16.0.0/12
    expect(isPrivateHostname('172.15.255.255')).toBe(false); // one below it
  });

  it('accepts a unique-local or link-local IPv6 address, rejects a public one', () => {
    expect(isPrivateHostname('fd12:3456:789a::1')).toBe(true);
    expect(isPrivateHostname('fe80::1')).toBe(true);
    expect(isPrivateHostname('2001:4860:4860::8888')).toBe(false); // Google's public DNS
  });

  it('accepts a bare internal hostname with no dot', () => {
    expect(isPrivateHostname('llm-gpu01')).toBe(true);
  });

  it('accepts a name under a TLD reserved for internal use, rejects an ordinary domain', () => {
    expect(isPrivateHostname('model-server.internal')).toBe(true);
    expect(isPrivateHostname('model-server.corp')).toBe(true);
    expect(isPrivateHostname('api.openai.com')).toBe(false);
    expect(isPrivateHostname('sub.example.com')).toBe(false);
  });
});

describe('validateEndpointUrl', () => {
  it('accepts a private http and https URL', () => {
    expect(validateEndpointUrl('http://10.0.0.5:8000/v1/chat/completions').hostname).toBe('10.0.0.5');
    expect(validateEndpointUrl('https://llm-gpu01.internal/v1/chat/completions').hostname).toBe(
      'llm-gpu01.internal',
    );
  });

  it('refuses a public host', () => {
    expect(() => validateEndpointUrl('https://api.openai.com/v1/chat/completions')).toThrow(
      /private network/,
    );
  });

  it('refuses a scheme other than http or https', () => {
    expect(() => validateEndpointUrl('ftp://10.0.0.5/model')).toThrow(/http or https/);
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => validateEndpointUrl('not a url')).toThrow(/not a valid URL/);
  });
});
