import { useEffect, useState, type JSX } from 'react';
import { api, ApiError, type AnalysisRunResult, type WorkflowGroupOption } from '../lib/api';

interface AnalysisPanelProps {
  documentId: string;
  onClose: () => void;
}

/**
 * Runs a workflow group set up for this kind of document: every analysis
 * prompt against the document, then the group's one summary prompt against
 * their collected output (docs/16-ai-integration.md §5). Both the individual
 * outputs and the summary are shown, never only the rolled-up answer, and
 * the analysis output already produced is kept even if the summary step
 * fails: this codebase does not hide what happened to a person's content,
 * and that applies to a model's intermediate output too.
 */
export function AnalysisPanel({ documentId, onClose }: AnalysisPanelProps): JSX.Element {
  const [groups, setGroups] = useState<WorkflowGroupOption[]>([]);
  const [groupId, setGroupId] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisRunResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listWorkflowGroupsForDocument(documentId)
      .then(({ groups: list }) => {
        if (cancelled) return;
        setGroups(list);
        setGroupId((current) => current || (list[0]?.id ?? ''));
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setLoadError(caught instanceof ApiError ? caught.message : 'Could not load workflow groups.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  const run = async (): Promise<void> => {
    if (!groupId || running) return;
    setRunning(true);
    setRunError(null);
    setResult(null);
    try {
      setResult(await api.runAnalysis(documentId, groupId));
    } catch (caught) {
      setRunError(caught instanceof ApiError ? caught.message : 'Could not run the analysis.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <aside className="comments-panel" aria-label="Document analysis">
      <div className="comments-head">
        <h2>Document analysis</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="ai-disclaimer" role="note">
        AI-generated: check anything important before relying on it. You remain responsible for this
        document.
      </p>
      {loadError ? (
        <p className="error" role="alert">
          {loadError}
        </p>
      ) : groups.length === 0 ? (
        <p className="analysis-empty muted">
          No workflow group is set up for this kind of document yet. An administrator can add one under
          Administration.
        </p>
      ) : (
        <div className="analysis-controls">
          <label className="visually-hidden" htmlFor="analysis-group">
            Workflow group
          </label>
          <select id="analysis-group" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
          <button type="button" className="primary" disabled={running} onClick={() => void run()}>
            {running ? 'Running…' : 'Run analysis'}
          </button>
        </div>
      )}

      {runError ? (
        <p className="error" role="alert">
          {runError}
        </p>
      ) : null}

      {result && !result.ok ? (
        <p className="error" role="alert">
          {result.message}
        </p>
      ) : null}

      {result?.analysis && result.analysis.length > 0 ? (
        <div className="analysis-results">
          {!result.ok ? (
            <p className="hint">The prompts below still completed before the summary failed.</p>
          ) : null}
          {result.analysis.map((entry) => (
            <details key={entry.promptId}>
              <summary>{entry.text}</summary>
              <p>{entry.output}</p>
            </details>
          ))}
          {result.ok && result.summary ? (
            <div className="analysis-summary">
              <h3>Summary</h3>
              <p>{result.summary}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
