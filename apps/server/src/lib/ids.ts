import { randomBytes, randomUUID, createHash } from 'node:crypto';

export const newId = (): string => randomUUID();

/** A 256-bit URL-safe opaque token. Only its hash is ever stored. */
export const newToken = (): string => randomBytes(32).toString('base64url');

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** The last timestamp handed out, so two writes in a row cannot share one. */
let lastMillis = 0;

/**
 * The current time, never repeating and never going backwards.
 *
 * The clock has millisecond resolution, and creating two documents or saving
 * twice takes less than that. Equal timestamps left the document list in an
 * arbitrary order: a document somebody had just edited could stay below one
 * they had not touched, and no ordering rule based on the stored time could
 * tell them apart. A run of writes now advances a millisecond at a time until
 * the clock catches up, which is invisible in the interface and makes the
 * order of the list match the order things happened.
 */
export const now = (): string => {
  const millis = Math.max(Date.now(), lastMillis + 1);
  lastMillis = millis;
  return new Date(millis).toISOString();
};
