import { AccessRequests } from '../components/AccessRequests';
import { useCallback, useEffect, useState, type FormEvent, type JSX } from 'react';
import {
  api,
  ApiError,
  DOCUMENT_TYPES,
  type AuditEntry,
  type DocumentType,
  type Role,
  type User,
  type WorkflowGroup,
} from '../lib/api';
import { useSession } from '../lib/session';
import { textField } from '../lib/forms';

export function AdminPage(): JSX.Element {
  const { user: currentUser } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [workflowGroups, setWorkflowGroups] = useState<WorkflowGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ users: list }, { entries }, { groups }] = await Promise.all([
        api.listUsers(),
        api.listAudit(),
        api.listWorkflowGroups(),
      ]);
      setUsers(list);
      setAudit(entries);
      setWorkflowGroups(groups);
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

  /**
   * A workflow group names a set of prompts for one kind of document, and
   * what running them together is meant to produce. Configuration only:
   * nothing here calls a model. One line of the textarea is one prompt, the
   * same "one thing per line" shape as the footnote and comment text boxes
   * elsewhere, rather than a picker that would need its own list of prompts
   * to choose from before there is anything to choose.
   */
  const addWorkflowGroup = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const docType = textField(form, 'docType');
    const prompts = textField(form, 'prompts')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createWorkflowGroup({
        name: textField(form, 'name'),
        description: textField(form, 'description'),
        docType: docType === '' ? null : (docType as DocumentType),
        isDefault: form.get('isDefault') === 'on',
        prompts,
        outputSummary: textField(form, 'outputSummary'),
      });
      element.reset();
      setNotice('Workflow group created.');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create that workflow group.');
    } finally {
      setBusy(false);
    }
  };

  const setGroupDefault = async (group: WorkflowGroup, isDefault: boolean): Promise<void> => {
    setError(null);
    try {
      await api.updateWorkflowGroup(group.id, { isDefault });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update that workflow group.');
    }
  };

  const removeWorkflowGroup = async (group: WorkflowGroup): Promise<void> => {
    if (!window.confirm(`Delete the workflow group "${group.name}"? Its prompts go with it.`)) return;
    setError(null);
    try {
      await api.deleteWorkflowGroup(group.id);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not delete that workflow group.');
    }
  };

  return (
    <div className="page-wrap">
      <h1>Administration</h1>
      <AccessRequests />

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
        <h2>Workflow groups</h2>
        <p className="hint">
          A named set of prompts for one kind of document, and a summary of what running them together
          is meant to produce. This configures a future analysis assistant; nothing here calls a model
          yet.
        </p>
        <form
          className="inline-form"
          onSubmit={(event) => {
            void addWorkflowGroup(event);
          }}
        >
          <label>
            Group name
            <input name="name" type="text" required maxLength={200} />
          </label>
          <label>
            Description
            <input name="description" type="text" maxLength={2000} />
          </label>
          <label>
            Document type
            <select name="docType" defaultValue="">
              <option value="">Any</option>
              {DOCUMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox-field">
            <input name="isDefault" type="checkbox" />
            Set as default
          </label>
          <label className="full-width">
            Prompts, one per line
            <textarea name="prompts" rows={4} placeholder="Does the document name an owner?" />
          </label>
          <label className="full-width">
            Summary of the prompt outputs
            <textarea
              name="outputSummary"
              rows={2}
              placeholder="What running these prompts together is meant to produce."
            />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            Add group
          </button>
        </form>

        {workflowGroups.length === 0 ? (
          <p className="muted">No workflow groups yet.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Document type</th>
                <th scope="col">Default</th>
                <th scope="col">Prompts</th>
                <th scope="col">Output summary</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {workflowGroups.map((group) => (
                <tr key={group.id}>
                  <td>
                    {group.name}
                    {group.description ? <div className="muted">{group.description}</div> : null}
                  </td>
                  <td>{group.docType ?? 'Any'}</td>
                  <td>{group.isDefault ? 'Yes' : 'No'}</td>
                  <td>{group.prompts.length}</td>
                  <td>{group.outputSummary || <span className="muted">Not set</span>}</td>
                  <td className="row-actions">
                    <button
                      type="button"
                      disabled={group.isDefault}
                      title={
                        group.docType
                          ? `Makes this the default group for ${group.docType}, in place of whichever one has that now`
                          : 'Set as the default group'
                      }
                      onClick={() => void setGroupDefault(group, true)}
                    >
                      Set as default
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void removeWorkflowGroup(group)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
