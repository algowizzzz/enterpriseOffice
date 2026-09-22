import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * Reversible encryption for a secret that has to be read back in full to be
 * useful, unlike a session token (`lib/ids.ts`'s `hashToken`), which only
 * ever needs comparing. `llm_endpoints.auth_secret` is the first thing in
 * this codebase with that requirement: it has to be handed back to whatever
 * HTTP call authenticates against the registered endpoint.
 *
 * Stored as `iv.authTag.ciphertext`, each base64url, so the column stays a
 * single opaque string next to `auth_scheme` and needs no extra columns for
 * the pieces GCM produces alongside the ciphertext.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((part) => part.toString('base64url')).join('.');
}

export function decryptSecret(encrypted: string, key: Buffer): string {
  const [ivPart, tagPart, dataPart] = encrypted.split('.');
  if (!ivPart || !tagPart || !dataPart) {
    throw new Error('Malformed encrypted secret: expected iv.authTag.ciphertext');
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
