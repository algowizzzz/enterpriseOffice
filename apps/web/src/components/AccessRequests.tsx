import { useCallback, useEffect, useState, type JSX } from 'react';
import { api, ApiError, type AccessRequestEntry } from '../lib/api';

/** Open requests this person can answer, for one document or for all of theirs. */
export function AccessRequests({ documentId, onChanged }: { documentId?: string; onChanged?: () => void }): JSX.Element | null {
  const [requests, setRequests] = useState<AccessRequestEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const { requests: open } = await api.listAccessRequests();
      setRequests(open.filter((entry) => (documentId ? entry.documentId === documentId : true)));
    } catch {
      // Said nothing about. This sits on pages whose business is something
      // else, and a second alert there for a list that may well be empty
      // buried the message the page was actually trying to show.
      setRequests([]);
    }
  }, [documentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const decide = async (id: string, approve: boolean): Promise<void> => {
    try {
      await api.decideAccessRequest(id, approve);
      await reload();
      onChanged?.();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not answer that request.');
    }
  };

  if (requests.length === 0 && !error) return null;
  return (
    <section className="access-requests" aria-label="Requests for access">
      <h3>Requests for access</h3>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="version-list">
        {requests.map((entry) => (
          <li key={entry.id}>
            <span>
              <strong>{entry.name}</strong> ({entry.email}){' '}
              {entry.wanted === 'account'
                ? 'asks for an account'
                : `asks to edit ${entry.documentTitle ? `“${entry.documentTitle}”` : 'this document'}`}
              {entry.note ? `: ${entry.note}` : ''}
            </span>
            <span className="row-actions">
              <button
                type="button"
                className="primary"
                title={
                  entry.wanted === 'account'
                    ? 'Mark as dealt with once you have made the account below'
                    : 'Give this person edit access'
                }
                onClick={() => void decide(entry.id, true)}
              >
                {entry.wanted === 'account' ? 'Done' : 'Approve'}
              </button>
              <button type="button" onClick={() => void decide(entry.id, false)}>
                Decline
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
