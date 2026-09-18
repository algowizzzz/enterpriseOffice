import { useState, type FormEvent, type JSX } from 'react';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';

/** For somebody with no account: a note to the administrators, who make accounts by hand. */
function AccountRequest(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (sent) return <p className="hint">Your request has gone to the administrators. They will be in touch.</p>;
  if (!open) {
    return (
      <button type="button" className="link" onClick={() => setOpen(true)}>
        No account? Ask for one
      </button>
    );
  }
  return (
    <form
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        // Read the form before yielding: React clears currentTarget.
        const form = new FormData(event.currentTarget);
        const field = (name: string): string => {
          const value = form.get(name);
          return typeof value === 'string' ? value : '';
        };
        void api
          .requestAccount({ name: field('name'), email: field('email'), note: field('note') })
          .then(() => setSent(true))
          .catch((caught: unknown) => setProblem(caught instanceof ApiError ? caught.message : 'Could not send that.'));
      }}
    >
      <h2>Ask for an account</h2>
      <label>
        Your name
        <input name="name" required maxLength={120} />
      </label>
      <label>
        Work email
        <input name="email" type="email" required maxLength={254} />
      </label>
      <label>
        What you need it for
        <input name="note" maxLength={500} />
      </label>
      {problem ? (
        <p className="error" role="alert">
          {problem}
        </p>
      ) : null}
      <button type="submit" className="primary">
        Send request
      </button>
    </form>
  );
}

export function SignInPage(): JSX.Element {
  const { signIn, setUp, needsSetup } = useSession();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (needsSetup) await setUp(email, name, password);
      else await signIn(email, password);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Sign in failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="centred-panel">
      <form
        className="card"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <h1>DocForge</h1>
        <p className="muted">
          {needsSetup
            ? 'No accounts exist yet. Create the first administrator.'
            : 'Sign in to your documents.'}
        </p>

        {needsSetup ? (
          <label>
            Full name
            <input
              type="text"
              value={name}
              autoComplete="name"
              required
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        ) : null}

        <label>
          Email
          <input
            type="email"
            value={email}
            autoComplete="username"
            required
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            autoComplete={needsSetup ? 'new-password' : 'current-password'}
            required
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {needsSetup ? (
          <p className="hint">
            At least 12 characters, with an uppercase letter, a lowercase letter and a digit.
          </p>
        ) : null}

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Working…' : needsSetup ? 'Create administrator' : 'Sign in'}
        </button>
      </form>
      {needsSetup ? null : <AccountRequest />}
    </div>
  );
}
