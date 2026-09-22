import type { JSX } from 'react';

interface AnalysisPanelProps {
  onClose: () => void;
}

/**
 * Where AI-assisted analysis of a document would surface its findings,
 * against whichever workflow group an administrator has set up for this
 * kind of document (see the "Workflow groups" section of Administration).
 *
 * There is no model behind this yet, so this says that plainly rather than
 * showing a spinner that would never finish. A refusal that is honest about
 * what it is beats an "Analyzing…" that never resolves.
 */
export function AnalysisPanel({ onClose }: AnalysisPanelProps): JSX.Element {
  return (
    <aside className="comments-panel" aria-label="Document analysis">
      <div className="comments-head">
        <h2>Document analysis</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="hint">Review AI-generated insights and suggestions.</p>
      <div className="analysis-empty">
        <p className="muted">
          Analysis is not connected to a model in this build. Once it is, findings from the workflow
          group set up for this kind of document will appear here, and an administrator remains
          responsible for reviewing them before anything changes.
        </p>
        <button type="button" disabled title="Not available until an analysis model is configured">
          Run analysis
        </button>
      </div>
    </aside>
  );
}
