import { useState, type JSX } from 'react';
import { MessageCircle, Sparkles } from 'lucide-react';
import { ChatPanel } from './ChatPanel';
import { AnalysisPanel } from './AnalysisPanel';
import { IconLabel } from './IconLabel';

interface AiPanelProps {
  documentId: string;
  onClose: () => void;
}

/**
 * Chat and Analysis as two sub-tabs of one panel (docs/16-ai-integration.md
 * §2), matching the `view-tabs` pattern `EditorPage.tsx` already uses for
 * Document/Original/Redline: one in-place switch, not two separate toggles
 * opening the same side slot. Comments and Review stay their own toggles
 * (§11): a person reviewing a document and a model reviewing it are
 * different trust relationships, and this tab strip is for the second one.
 */
export function AiPanel({ documentId, onClose }: AiPanelProps): JSX.Element {
  const [tab, setTab] = useState<'chat' | 'analysis'>('chat');

  return (
    <aside className="comments-panel ai-panel" aria-label="AI">
      <div className="comments-head">
        <h2>AI</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <nav className="ai-tabs" role="tablist" aria-label="Chat or analysis">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'chat'}
          className={`ai-tab${tab === 'chat' ? ' is-active' : ''}`}
          onClick={() => setTab('chat')}
        >
          <IconLabel icon={MessageCircle} size={14}>
            Chat
          </IconLabel>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'analysis'}
          className={`ai-tab${tab === 'analysis' ? ' is-active' : ''}`}
          onClick={() => setTab('analysis')}
        >
          <IconLabel icon={Sparkles} size={14}>
            Analysis
          </IconLabel>
        </button>
      </nav>
      <div role="tabpanel" className="ai-tabpanel">
        {tab === 'chat' ? (
          <ChatPanel documentId={documentId} onClose={onClose} embedded />
        ) : (
          <AnalysisPanel documentId={documentId} onClose={onClose} embedded />
        )}
      </div>
    </aside>
  );
}
