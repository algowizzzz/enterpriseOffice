import { randomBytes, randomUUID, createHash } from 'node:crypto';

export const newId = (): string => randomUUID();

/** A 256-bit URL-safe opaque token. Only its hash is ever stored. */
export const newToken = (): string => randomBytes(32).toString('base64url');

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const now = (): string => new Date().toISOString();
