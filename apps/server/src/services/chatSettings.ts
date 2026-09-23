/**
 * Which registered endpoint Chat talks to. Chat is not scoped to a document
 * type the way a workflow group is, so it has nowhere else to keep this: one
 * fixed row, or null to fall back to the installation's default endpoint
 * (docs/16-ai-integration.md §3).
 */
import type { Database } from '../db.js';
import { now } from '../lib/ids.js';

const SINGLETON_ID = 'singleton';

export interface ChatSettings {
  endpointId: string | null;
}

export function getChatSettings(db: Database): ChatSettings {
  const row = db.prepare('SELECT endpoint_id FROM chat_settings WHERE id = ?').get(SINGLETON_ID) as
    | { endpoint_id: string | null }
    | undefined;
  return { endpointId: row?.endpoint_id ?? null };
}

export function setChatSettings(db: Database, endpointId: string | null): ChatSettings {
  db.prepare(
    `INSERT INTO chat_settings (id, endpoint_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET endpoint_id = excluded.endpoint_id, updated_at = excluded.updated_at`,
  ).run(SINGLETON_ID, endpointId, now());
  return getChatSettings(db);
}
