import { useState, type FormEvent, type JSX } from 'react';
import { Send } from 'lucide-react';

interface ChatMessage {
  id: number;
  from: 'assistant' | 'me';
  text: string;
}

interface ChatPanelProps {
  onClose: () => void;
}

const OPENING: ChatMessage = {
  id: 0,
  from: 'assistant',
  text: 'Welcome. Ask a question about this document.',
};

/**
 * The shape of a document assistant, with nowhere yet for a message to go.
 *
 * This is a preview of the interface, not a preview of the feature: no
 * request leaves this browser, because there is no model in this build to
 * send one to, on- or off-machine. Wiring this to one is a separate,
 * later decision (see docs/14-word-like-shell.md), and a real one: it either
 * needs a network call, which the rest of this product refuses to make, or a
 * model bundled to run locally, which is real infrastructure. Saying so here,
 * every time, is cheaper than someone assuming this box already works.
 */
export function ChatPanel({ onClose }: ChatPanelProps): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([OPENING]);
  const [draft, setDraft] = useState('');

  const send = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setMessages((current) => [
      ...current,
      { id: current.length, from: 'me', text },
      {
        id: current.length + 1,
        from: 'assistant',
        text: 'This assistant is not connected to a model in this build. What you type here is kept on this page and is not sent anywhere.',
      },
    ]);
    setDraft('');
  };

  return (
    <aside className="comments-panel chat-panel" aria-label="Chat">
      <div className="comments-head">
        <h2>Chat</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="hint">Nothing typed here is sent anywhere or kept once you leave.</p>
      <div className="chat-messages" role="log" aria-label="Chat messages">
        {messages.map((message) => (
          <p key={message.id} className={`chat-message chat-message-${message.from}`}>
            {message.text}
          </p>
        ))}
      </div>
      <form className="chat-form" onSubmit={send}>
        <label className="visually-hidden" htmlFor="chat-input">
          Message
        </label>
        <input
          id="chat-input"
          type="text"
          value={draft}
          placeholder="Type your message here…"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="primary" disabled={draft.trim() === ''} title="Send">
          <Send size={15} aria-hidden="true" />
          <span className="visually-hidden">Send</span>
        </button>
      </form>
    </aside>
  );
}
