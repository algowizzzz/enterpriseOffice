/**
 * Registered LLM endpoints: where a future AI feature is allowed to send a
 * document or a prompt. Registering one is the one thing in this product
 * that turns on an outbound network call; see docs/16-ai-integration.md §7.
 * `authSecret` is encrypted at rest (lib/crypto.ts) and is never read back
 * out through the API: a GET response carries only whether a secret is set,
 * the closest match to how sessions already handle a credential
 * (lib/ids.ts's `hashToken`), except this one has to be decryptable, because
 * it exists to authenticate the very call this file makes on "Test
 * connection".
 */
import type { Database } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { transaction } from '../db.js';
import { newId, now } from '../lib/ids.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { validateEndpointUrl } from '../lib/network.js';

export const AUTH_SCHEMES = ['none', 'bearer', 'header'] as const;
export type AuthScheme = (typeof AUTH_SCHEMES)[number];

export const REQUEST_FORMATS = ['openai-chat'] as const;
export type RequestFormat = (typeof REQUEST_FORMATS)[number];

export interface LlmEndpoint {
  id: string;
  name: string;
  url: string;
  authScheme: AuthScheme;
  authHeaderName: string | null;
  /** Never the secret itself past this module: only whether one is stored. */
  hasSecret: boolean;
  requestFormat: RequestFormat;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

interface LlmEndpointRow extends Record<string, unknown> {
  id: string;
  name: string;
  url: string;
  auth_scheme: string;
  auth_header_name: string | null;
  auth_secret: string | null;
  request_format: string;
  created_at: string;
  updated_at: string;
  created_by: string;
}

const toEndpoint = (row: LlmEndpointRow): LlmEndpoint => ({
  id: row.id,
  name: row.name,
  url: row.url,
  authScheme: row.auth_scheme as AuthScheme,
  authHeaderName: row.auth_header_name,
  hasSecret: row.auth_secret !== null,
  requestFormat: row.request_format as RequestFormat,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  createdBy: row.created_by,
});

function getRowOrThrow(db: Database, id: string): LlmEndpointRow {
  const row = db.prepare('SELECT * FROM llm_endpoints WHERE id = ?').get(id) as
    | LlmEndpointRow
    | undefined;
  if (!row) throw notFound('LLM endpoint not found');
  return row;
}

export function listLlmEndpoints(db: Database): LlmEndpoint[] {
  const rows = db
    .prepare('SELECT * FROM llm_endpoints ORDER BY name COLLATE NOCASE')
    .all() as LlmEndpointRow[];
  return rows.map(toEndpoint);
}

export function getLlmEndpoint(db: Database, id: string): LlmEndpoint {
  return toEndpoint(getRowOrThrow(db, id));
}

export interface LlmEndpointInput {
  name: string;
  url: string;
  authScheme: AuthScheme;
  authHeaderName: string | null;
  /** `null` means no secret. Omitted entirely on a patch means "keep the current one". */
  authSecret: string | null;
  requestFormat: RequestFormat;
}

export type LlmEndpointPatch = Partial<LlmEndpointInput>;

function checkHeaderNamePresent(input: Pick<LlmEndpointInput, 'authScheme' | 'authHeaderName'>): void {
  if (input.authScheme === 'header' && !input.authHeaderName) {
    throw badRequest('A header-based endpoint needs the name of the header to send the secret in.');
  }
}

export function createLlmEndpoint(
  db: Database,
  secretKey: Buffer,
  input: LlmEndpointInput,
  actorId: string,
): LlmEndpoint {
  validateEndpointUrl(input.url);
  checkHeaderNamePresent(input);
  const id = newId();
  const timestamp = now();
  const encrypted = input.authSecret ? encryptSecret(input.authSecret, secretKey) : null;
  db.prepare(
    `INSERT INTO llm_endpoints
       (id, name, url, auth_scheme, auth_header_name, auth_secret, request_format, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.url,
    input.authScheme,
    input.authHeaderName,
    encrypted,
    input.requestFormat,
    timestamp,
    timestamp,
    actorId,
  );
  return getLlmEndpoint(db, id);
}

export function updateLlmEndpoint(
  db: Database,
  secretKey: Buffer,
  id: string,
  patch: LlmEndpointPatch,
): LlmEndpoint {
  return transaction(db, () => {
    const currentRow = getRowOrThrow(db, id);
    const current = toEndpoint(currentRow);
    const next = {
      name: patch.name ?? current.name,
      url: patch.url ?? current.url,
      authScheme: patch.authScheme ?? current.authScheme,
      authHeaderName:
        patch.authHeaderName !== undefined ? patch.authHeaderName : current.authHeaderName,
      requestFormat: patch.requestFormat ?? current.requestFormat,
    };
    validateEndpointUrl(next.url);
    checkHeaderNamePresent(next);
    // Omitting `authSecret` from a patch keeps the one already stored, so an
    // admin can rename an endpoint without retyping its key every time.
    const encrypted =
      patch.authSecret === undefined
        ? currentRow.auth_secret
        : patch.authSecret
          ? encryptSecret(patch.authSecret, secretKey)
          : null;
    db.prepare(
      `UPDATE llm_endpoints
       SET name = ?, url = ?, auth_scheme = ?, auth_header_name = ?, auth_secret = ?, request_format = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      next.name,
      next.url,
      next.authScheme,
      next.authHeaderName,
      encrypted,
      next.requestFormat,
      now(),
      id,
    );
    return getLlmEndpoint(db, id);
  });
}

export function deleteLlmEndpoint(db: Database, id: string): void {
  getRowOrThrow(db, id); // Throws the same "not found" a get would, before deleting nothing.
  db.prepare('DELETE FROM llm_endpoints WHERE id = ?').run(id);
}

export interface TestConnectionResult {
  ok: boolean;
  status?: number;
  message: string;
}

const TEST_TIMEOUT_MS = 8000;

/**
 * The one call in this codebase that reaches a network address a person
 * chose rather than one bundled with the product (docs/16-ai-integration.md
 * §7). Never throws: a registered endpoint being unreachable is ordinary (a
 * GPU box rebooting, a firewall rule not opened yet), not a bug in this
 * server, so the caller always gets a result to show, not an error page.
 */
export async function testLlmEndpoint(
  db: Database,
  secretKey: Buffer,
  id: string,
): Promise<TestConnectionResult> {
  const row = getRowOrThrow(db, id);
  const url = validateEndpointUrl(row.url);

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (row.auth_secret) {
    const secret = decryptSecret(row.auth_secret, secretKey);
    if (row.auth_scheme === 'bearer') headers['authorization'] = `Bearer ${secret}`;
    else if (row.auth_scheme === 'header' && row.auth_header_name) headers[row.auth_header_name] = secret;
  }

  // The smallest request an OpenAI-compatible chat/completions endpoint will
  // accept: this is a reachability check, not a real analysis run.
  const body = JSON.stringify({
    model: 'test',
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    return response.ok
      ? { ok: true, status: response.status, message: 'Connected.' }
      : { ok: false, status: response.status, message: `The endpoint answered with status ${response.status}.` };
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? `No response within ${TEST_TIMEOUT_MS / 1000} seconds.`
        : `Could not reach the endpoint: ${(error as Error).message}`;
    return { ok: false, message };
  } finally {
    clearTimeout(timeout);
  }
}
