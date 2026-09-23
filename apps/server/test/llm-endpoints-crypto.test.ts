import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/lib/crypto.js';

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a secret under its own key', () => {
    const key = randomBytes(32);
    const encrypted = encryptSecret('sk-a-genuinely-secret-value', key);
    expect(encrypted).not.toContain('sk-a-genuinely-secret-value');
    expect(decryptSecret(encrypted, key)).toBe('sk-a-genuinely-secret-value');
  });

  it('refuses to decrypt under the wrong key', () => {
    const encrypted = encryptSecret('top secret', randomBytes(32));
    expect(() => decryptSecret(encrypted, randomBytes(32))).toThrow();
  });

  it('refuses a tampered ciphertext rather than returning silently wrong plaintext', () => {
    const key = randomBytes(32);
    const encrypted = encryptSecret('top secret', key);
    const [iv, tag, data] = encrypted.split('.');
    const tamperedByte = Buffer.from(data as string, 'base64url');
    tamperedByte[0] = (tamperedByte[0] ?? 0) ^ 0xff;
    const tampered = [iv, tag, tamperedByte.toString('base64url')].join('.');
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it('produces a different ciphertext each time, even for the same plaintext and key', () => {
    const key = randomBytes(32);
    const first = encryptSecret('same value', key);
    const second = encryptSecret('same value', key);
    expect(first).not.toBe(second);
    expect(decryptSecret(first, key)).toBe('same value');
    expect(decryptSecret(second, key)).toBe('same value');
  });
});
