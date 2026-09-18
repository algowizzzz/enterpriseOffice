import { useCallback, useEffect, useState, type FormEvent, type JSX } from 'react';
import { api, ApiError, type AuditEntry, type Role, type User } from '../lib/api';
import { useSession } from '../lib/session';
import { textField } from '../lib/forms';

export function AdminPage(): JSX.Element {
  const { user: currentUser } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ users: list }, { entries }] = await Promise.all([api.listUsers(), api.listAudit()]);
      setUsers(list);
      setAudit(entries);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load administration data.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addUser = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    // Hold on to the element itself. React clears `currentTarget` once the
    // handler yields, so reading it after the await below threw and the
    // account was created while the page reported a failure.
    const element = event.currentTarget;
    const form = new FormData(element);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createUser({
        email: textField(form, 'email'),
        name: textField(form, 'name'),
        password: textField(form, 'password'),
        role: textField(form, 'role', 'editor') as Role,
      });
      element.reset();
      setNotice('Account created.');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the account.');
    } finally {
      setBusy(false);
    }
  };

  const change = async (id: string, patch: { role?: Role; status?: 'active' | 'disabled' }) => {
    setError(null);
    try {
      await api.updateUser(id, patch);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update that account.');
    }
  };

  const resetPassword = async (target: User): Promise<void> => {
    const password = window.prompt(`New password for ${target.email}`);
    if (password === null) return;
    try {
      await api.resetUserPassword(target.id, password);
      setNotice(`Password reset for ${target.email}. Their other sessions were signed out.`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reset that password.');
    }
  };

  return (
    <div className="page-wrap">
      <h1>Administration</h1>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="notice">{notice}</p> : null}

      <section>
        <h2>Add an account</h2>
        <form
          className="inline-form"
          onSubmit={(event) => {
            void addUser(event);
          }}
        >
          <label>
            Name
            <input name="name" type="text" required maxLength={120} />
          </label>
          <label>
            Email
            <input name="email" type="email" required />
          </label>
          <label>
            Password
            <input name="password" type="password" required />
          </label>
          <label>
            Role
            <select name="role" defaultValue="editor">
              <option value="admin">Administrator</option>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
          </label>
          <button type="submit" className="primary" disabled={busy}>
            Create
          </button>
        </form>
        <p className="hint">
          At least 12 characters, with an uppercase letter, a lowercase letter and a digit.
        </p>
      </section>

      <section>
        <h2>Accounts</h2>
        <table className="grid">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col">Last sign-in</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((account) => (
              <tr key={account.id}>
                <td>{account.name}</td>
                <td>{account.email}</td>
                <td>
                  <select
                    aria-label={`Role for ${account.email}`}
                    value={account.role ?? 'editor'}
                    onChange={(event) => void change(account.id, { role: event.target.value as Role })}
                  >
                    <option value="admin">Administrator</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </td>
                <td>{account.status}</td>
                <td>
                  {account.lastLoginAt
                    ? new Date(account.lastLoginAt).toLocaleString()
                    : 'Never signed in'}
                </td>
                <td className="row-actions">
                  <button type="button" onClick={() => void resetPassword(account)}>
                    Reset password
                  </button>
                  {account.id === currentUser?.id ? null : account.status === 'active' ? (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void change(account.id, { status: 'disabled' })}
                    >
                      Disable
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void change(account.id, { status: 'active' })}
                    >
                      Enable
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Audit trail</h2>
        <table className="grid">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">Action</th>
              <th scope="col">Target</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.createdAt).toLocaleString()}</td>
                <td>{entry.actorEmail ?? 'anonymous'}</td>
                <td>{entry.action}</td>
                <td className="mono">{entry.targetId ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
