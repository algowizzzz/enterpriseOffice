/**
 * Chat: a conversation that carries the open document as context
 * (docs/16-ai-integration.md §6, §11). Nothing here chunks or retrieves --
 * the document's own text is sent up to a byte cap and truncated past it,
 * said plainly to the caller when that happens, the same "say so, do not do
 * it silently" standard as everywhere else in this codebase. A real
 * chunking/retrieval approach is future work, not this phase.
 */
import type { Database } from '../db.js';
import { getChatSettings } from './chatSettings.js';
import { getDefaultEndpointId, runCompletion } from './llmEndpoints.js';

/** Characters of document text sent as context, not tokens: an honest first cap, not a tuned one. */
export const CHAT_CONTEXT_CHAR_LIMIT = 24000;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatReply {
  ok: boolean;
  reply?: string;
  /** True when the document's text was cut short to fit the context cap. */
  truncated?: boolean;
  /** An explanation, present whether or not the call succeeded. */
  message: string;
}

export async function sendChatMessage(
  db: Database,
  secretKey: Buffer,
  input: { documentText: string | null; history: ChatTurn[]; message: string },
): Promise<ChatReply> {
  const endpointId = getChatSettings(db).endpointId ?? getDefaultEndpointId(db);
  if (!endpointId) {
    return {
      ok: false,
      message:
        'No AI endpoint is configured. An administrator needs to register one and set it as the default, or choose one for Chat specifically.',
    };
  }

  let context = input.documentText;
  let truncated = false;
  if (context !== null && context.length > CHAT_CONTEXT_CHAR_LIMIT) {
    context = context.slice(0, CHAT_CONTEXT_CHAR_LIMIT);
    truncated = true;
  }

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
  if (context !== null) {
    messages.push({
      role: 'system',
      content:
        `You are answering questions about the document below.` +
        (truncated ? ' It has been cut off partway through.' : '') +
        `\n\n${context}`,
    });
  }
  messages.push(...input.history);
  messages.push({ role: 'user', content: input.message });

  const result = await runCompletion(db, secretKey, endpointId, messages, { maxTokens: 1024 });
  if (!result.ok || result.content === undefined) {
    return { ok: false, truncated, message: result.message };
  }
  return { ok: true, reply: result.content, truncated, message: result.message };
}
