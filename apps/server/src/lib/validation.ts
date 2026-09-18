import { z } from 'zod';

/**
 * Email addresses accepted by the portal.
 *
 * Deliberately more permissive than Zod's built-in `.email()`, which requires a
 * dotted domain and so rejects `admin@localhost` and `someone@intranet`. Those
 * are ordinary addresses on an air-gapped corporate network, and the seed
 * administrator uses one, so rejecting them would lock people out of their own
 * installation.
 *
 * The rules kept are the ones that protect the system rather than the ones that
 * guess at deliverability: exactly one at sign, a non-empty local part, at
 * least one domain label, no whitespace, no control characters, and a length
 * within the limit in RFC 5321.
 */
const EMAIL_PATTERN = /^[^\s@,;:<>"\\]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/iu;

export const emailSchema = z
  .string()
  .trim()
  .min(3, 'Enter an email address')
  .max(254, 'That email address is too long')
  .refine((value) => EMAIL_PATTERN.test(value), 'Enter a valid email address');

/** Shared so that a route and a service cannot disagree about what is valid. */
export const isValidEmail = (value: string): boolean =>
  value.trim().length >= 3 && value.trim().length <= 254 && EMAIL_PATTERN.test(value.trim());
