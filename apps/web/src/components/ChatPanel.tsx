import { Fragment, useState, type FormEvent, type JSX } from 'react';
import { Send } from 'lucide-react';
import { api, ApiError, type ChatTurn } from '../lib/api';

interface ChatMessage {
  id: number;
  from: 'assistant' | 'me';
  text: string;
}

interface ChatPanelProps {
  documentId: string;
  onClose: () => void;
  /** True inside AiPanel's own Chat/Analysis tabs, which supply the outer panel and its Close button. */
  embedded?: boolean;
}

const OPENING: ChatMessage = {
  id: 0,
  from: 'assistant',
  text: 'Ask a question about this document.',
};

/**
 * Carries the open document as context (docs/16-ai-integration.md §6, §11):
 * the server sends the document's own text up to a cap and truncates past
 * it, which shows here as a one-line notice rather than happening silently.
 * There is no model bundled with this product; a message only goes anywhere
 * once an administrator has registered an endpoint (Administration > LLM
 * endpoints), and even then only within that endpoint's own network.
 */
export function ChatPanel({ documentId, onClose, embedded = false }: ChatPanelProps): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([OPENING]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [truncated, setTruncated] = useState(false);

  const send = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    // The opening line was never sent to a model, so it is not part of the
    // conversation history a real reply is asked to continue.
    const history: ChatTurn[] = messages
      .filter((message) => message.id !== OPENING.id)
      .map((message) => ({ role: message.from === 'me' ? 'user' : 'assistant', content: message.text }));
    setMessages((current) => [...current, { id: current.length, from: 'me', text }]);
    setDraft('');
    setSending(true);
    try {
      const reply = await api.sendChatMessage(documentId, text, history);
      if (reply.truncated) setTruncated(true);
      setMessages((current) => [
        ...current,
        { id: current.length, from: 'assistant', text: reply.ok ? (reply.reply ?? '') : reply.message },
      ]);
    } catch (caught) {
      setMessages((current) => [
        ...current,
        {
          id: current.length,
          from: 'assistant',
          text: caught instanceof ApiError ? caught.message : 'Could not reach the assistant.',
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const content = (
    <>
      <p className="ai-disclaimer" role="note">
        AI-generated: check anything important before relying on it. You remain responsible for this
        document.
      </p>
      {truncated ? (
        <p className="hint">This document is long: only part of it was sent as context.</p>
      ) : null}
      <div className="chat-messages" role="log" aria-label="Chat messages">
        {messages.map((message) => (
          <p key={message.id} className={`chat-message chat-message-${message.from}`}>
            {message.text}
          </p>
        ))}
        {sending ? <p className="muted">Thinking…</p> : null}
      </div>
      <form
        className="chat-form"
        onSubmit={(event) => {
          void send(event);
        }}
      >
        <label className="visually-hidden" htmlFor="chat-input">
          Message
        </label>
        <input
          id="chat-input"
          type="text"
          value={draft}
          placeholder="Type your message here…"
          disabled={sending}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="primary" disabled={draft.trim() === '' || sending} title="Send">
          <Send size={15} aria-hidden="true" />
          <span className="visually-hidden">Send</span>
        </button>
      </form>
    </>
  );

  if (embedded) return <Fragment>{content}</Fragment>;

  return (
    <aside className="comments-panel chat-panel" aria-label="Chat">
      <div className="comments-head">
        <h2>Chat</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      {content}
    </aside>
  );
}
