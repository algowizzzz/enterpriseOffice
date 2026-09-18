import { useState, type FormEvent, type JSX } from 'react';
import { ApiError } from '../lib/api';
import { useSession } from '../lib/session';

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
      <form className="card" onSubmit={submit}>
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
    </div>
  );
}
