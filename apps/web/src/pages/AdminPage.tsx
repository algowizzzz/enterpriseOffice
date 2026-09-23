import { AccessRequests } from '../components/AccessRequests';
import { Fragment, useCallback, useEffect, useState, type FormEvent, type JSX } from 'react';
import {
  api,
  ApiError,
  DOCUMENT_TYPES,
  type AuditEntry,
  type BodyStyle,
  type ChatSettings,
  type DocumentType,
  type ExportTemplate,
  type HeaderFooterSide,
  type HeadingStyle,
  type LlmAuthScheme,
  type LlmEndpoint,
  type Role,
  type TableStyle,
  type TocLevelStyle,
  type User,
  type WorkflowGroup,
  type WorkflowGroupPrompt,
} from '../lib/api';
import { useSession } from '../lib/session';
import { textField } from '../lib/forms';

export function AdminPage(): JSX.Element {
  const { user: currentUser } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [workflowGroups, setWorkflowGroups] = useState<WorkflowGroup[]>([]);
  const [llmEndpoints, setLlmEndpoints] = useState<LlmEndpoint[]>([]);
  const [chatSettings, setChatSettingsState] = useState<ChatSettings>({ endpointId: null });
  const [templateDraft, setTemplateDraft] = useState<ExportTemplate | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState('');
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [dragPromptId, setDragPromptId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeSection, setActiveSection] = useState<'users' | 'ai' | 'export' | 'audit'>('users');

  const load = useCallback(async () => {
    try {
      const [{ users: list }, { entries }, { groups }, { endpoints }, settings, { template }] = await Promise.all([
        api.listUsers(),
        api.listAudit(),
        api.listWorkflowGroups(),
        api.listLlmEndpoints(),
        api.getChatSettings(),
        api.getExportTemplate(),
      ]);
      setUsers(list);
      setAudit(entries);
      setWorkflowGroups(groups);
      setLlmEndpoints(endpoints);
      setChatSettingsState(settings);
      setTemplateDraft(template);
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
   * A workflow group names a set of prompts for one kind of document: each
   * analysis prompt reads the document, and the one summary prompt reads
   * their collected output afterwards (docs/16-ai-integration.md §4-5).
   * Configuration only here at creation; adding, editing, deleting and
   * reordering prompts on an existing group are separate actions below,
   * once there is a group to manage them on.
   */
  const addWorkflowGroup = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const docType = textField(form, 'docType');
    const endpointId = textField(form, 'endpointId');
    const analysisPrompts = textField(form, 'analysisPrompts')
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
        endpointId: endpointId === '' ? null : endpointId,
        analysisPrompts,
        summaryPrompt: textField(form, 'summaryPrompt'),
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
      if (expandedGroupId === group.id) setExpandedGroupId(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not delete that workflow group.');
    }
  };

  const addPrompt = async (groupId: string): Promise<void> => {
    const text = promptDraft.trim();
    if (!text) return;
    setError(null);
    try {
      await api.addWorkflowGroupPrompt(groupId, { role: 'analysis', text });
      setPromptDraft('');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not add that prompt.');
    }
  };

  const startEditingPrompt = (prompt: WorkflowGroupPrompt): void => {
    setEditingPromptId(prompt.id);
    setEditingText(prompt.text);
  };

  const saveEditingPrompt = async (groupId: string): Promise<void> => {
    if (!editingPromptId || !editingText.trim()) return;
    setError(null);
    try {
      await api.updateWorkflowGroupPrompt(groupId, editingPromptId, editingText.trim());
      setEditingPromptId(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save that prompt.');
    }
  };

  const removePrompt = async (groupId: string, prompt: WorkflowGroupPrompt): Promise<void> => {
    if (!window.confirm('Delete this prompt?')) return;
    setError(null);
    try {
      await api.deleteWorkflowGroupPrompt(groupId, prompt.id);
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not delete that prompt.',
      );
    }
  };

  const reorderAnalysisPrompts = async (group: WorkflowGroup, reordered: string[]): Promise<void> => {
    setError(null);
    try {
      await api.reorderWorkflowGroupPrompts(group.id, reordered);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reorder those prompts.');
    }
  };

  /** Drag-and-drop reorder of the analysis prompts only; the summary prompt is pinned and never moves. */
  const dropPromptOn = async (group: WorkflowGroup, targetId: string): Promise<void> => {
    const draggedId = dragPromptId;
    setDragPromptId(null);
    if (!draggedId || draggedId === targetId) return;
    const analysisIds = group.prompts.filter((p) => p.role === 'analysis').map((p) => p.id);
    const from = analysisIds.indexOf(draggedId);
    const to = analysisIds.indexOf(targetId);
    if (from === -1 || to === -1) return;
    const reordered = [...analysisIds];
    reordered.splice(from, 1);
    reordered.splice(to, 0, draggedId);
    await reorderAnalysisPrompts(group, reordered);
  };

  /** The same reorder, one step at a time, for a keyboard- and screen-reader-reachable alternative to drag. */
  const movePrompt = async (group: WorkflowGroup, promptId: string, direction: -1 | 1): Promise<void> => {
    const analysisIds = group.prompts.filter((p) => p.role === 'analysis').map((p) => p.id);
    const from = analysisIds.indexOf(promptId);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= analysisIds.length) return;
    const reordered = [...analysisIds];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved as string);
    await reorderAnalysisPrompts(group, reordered);
  };

  /**
   * Where a future AI feature is allowed to send a document or a prompt.
   * Registering one is the one thing in this product that turns on an
   * outbound network call, and only to a private-network address: the
   * server refuses a public one outright (docs/16-ai-integration.md §7, §12).
   */
  const addLlmEndpoint = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const authScheme = textField(form, 'authScheme', 'none') as LlmAuthScheme;
    const authHeaderName = textField(form, 'authHeaderName');
    const authSecret = textField(form, 'authSecret');
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createLlmEndpoint({
        name: textField(form, 'name'),
        url: textField(form, 'url'),
        authScheme,
        authHeaderName: authScheme === 'header' && authHeaderName ? authHeaderName : null,
        authSecret: authSecret || null,
        isDefault: form.get('isDefault') === 'on',
      });
      element.reset();
      setNotice('Endpoint registered.');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not register that endpoint.');
    } finally {
      setBusy(false);
    }
  };

  const removeLlmEndpoint = async (endpoint: LlmEndpoint): Promise<void> => {
    if (!window.confirm(`Delete the endpoint "${endpoint.name}"?`)) return;
    setError(null);
    try {
      await api.deleteLlmEndpoint(endpoint.id);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not delete that endpoint.');
    }
  };

  const testEndpoint = async (endpoint: LlmEndpoint): Promise<void> => {
    setTestResults((current) => ({ ...current, [endpoint.id]: 'Testing…' }));
    try {
      const result = await api.testLlmEndpoint(endpoint.id);
      setTestResults((current) => ({ ...current, [endpoint.id]: result.message }));
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : 'Could not run the test.';
      setTestResults((current) => ({ ...current, [endpoint.id]: message }));
    }
  };

  const setEndpointDefault = async (endpoint: LlmEndpoint): Promise<void> => {
    setError(null);
    try {
      await api.updateLlmEndpoint(endpoint.id, { isDefault: true });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update that endpoint.');
    }
  };

  /** The endpoint Chat is explicitly set to, if any -- for showing its configuration alongside the picker. */
  const chatEndpoint = llmEndpoints.find((endpoint) => endpoint.id === chatSettings.endpointId) ?? null;

  /** Which endpoint Chat itself uses; null falls back to the installation default. */
  const changeChatEndpoint = async (endpointId: string): Promise<void> => {
    setError(null);
    try {
      const settings = await api.setChatSettings(endpointId === '' ? null : endpointId);
      setChatSettingsState(settings);
      setNotice('Chat settings updated.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update chat settings.');
    }
  };

  /**
   * The house style for Standardized export (docs/17-standardized-export.md).
   * Edited as a local draft and saved in one call rather than per keystroke:
   * this form has around sixty fields, and an API call per character would
   * be its own kind of bug.
   */
  const updateSide = (
    section: 'header' | 'footer',
    side: 'left' | 'right',
    patch: Partial<HeaderFooterSide>,
  ): void => {
    setTemplateDraft((current) =>
      current
        ? { ...current, [section]: { ...current[section], [side]: { ...current[section][side], ...patch } } }
        : current,
    );
  };

  const updateHeading = (index: number, patch: Partial<HeadingStyle>): void => {
    setTemplateDraft((current) =>
      current
        ? { ...current, headings: current.headings.map((h, i) => (i === index ? { ...h, ...patch } : h)) }
        : current,
    );
  };

  const updateBody = (patch: Partial<BodyStyle>): void => {
    setTemplateDraft((current) => (current ? { ...current, body: { ...current.body, ...patch } } : current));
  };

  const updateTable = (patch: Partial<TableStyle>): void => {
    setTemplateDraft((current) => (current ? { ...current, table: { ...current.table, ...patch } } : current));
  };

  const updateTocLevel = (index: number, patch: Partial<TocLevelStyle>): void => {
    setTemplateDraft((current) =>
      current ? { ...current, toc: current.toc.map((level, i) => (i === index ? { ...level, ...patch } : level)) } : current,
    );
  };

  const saveExportTemplate = async (): Promise<void> => {
    if (!templateDraft) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { template } = await api.updateExportTemplate({
        header: templateDraft.header,
        footer: templateDraft.footer,
        headings: templateDraft.headings,
        body: templateDraft.body,
        table: templateDraft.table,
        toc: templateDraft.toc,
      });
      setTemplateDraft(template);
      setNotice('Export template saved.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the export template.');
    } finally {
      setBusy(false);
    }
  };

  const uploadExportLogo = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const element = event.currentTarget;
    const input = element.elements.namedItem('logo') as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { template } = await api.uploadExportLogo(file);
      setTemplateDraft(template);
      element.reset();
      setNotice('Logo uploaded.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not upload that logo.');
    } finally {
      setBusy(false);
    }
  };

  const removeExportLogo = async (): Promise<void> => {
    setError(null);
    try {
      const { template } = await api.removeExportLogo();
      setTemplateDraft(template);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not remove the logo.');
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

      <div className="admin-layout">
        <nav className="admin-nav" aria-label="Administration sections">
          {(
            [
              ['users', 'Users'],
              ['ai', 'AI'],
              ['export', 'Export'],
              ['audit', 'Audit'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`admin-nav-item${activeSection === key ? ' is-active' : ''}`}
              aria-pressed={activeSection === key}
              onClick={() => setActiveSection(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="admin-content">
      {activeSection === 'users' ? (
      <>
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
      </>
      ) : null}

      {activeSection === 'ai' ? (
      <>
      <section>
        <h2>Workflow groups</h2>
        <p className="hint">
          A named set of prompts for one kind of document: each analysis prompt reads the document, and
          the one summary prompt reads their collected findings afterwards.
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
          <label>
            Endpoint
            <select name="endpointId" defaultValue="">
              <option value="">Installation default</option>
              {llmEndpoints.map((endpoint) => (
                <option key={endpoint.id} value={endpoint.id}>
                  {endpoint.name}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox-field">
            <input name="isDefault" type="checkbox" />
            Set as default for its document type
          </label>
          <label className="full-width">
            Analysis prompts, one per line
            <textarea name="analysisPrompts" rows={4} placeholder="Does the document name an owner?" />
          </label>
          <label className="full-width">
            Summary prompt
            <textarea
              name="summaryPrompt"
              rows={2}
              required
              placeholder="Summarise the findings above for the document owner."
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
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {workflowGroups.map((group) => {
                const analysisPrompts = group.prompts
                  .filter((prompt) => prompt.role === 'analysis')
                  .sort((a, b) => a.position - b.position);
                const summaryPrompt = group.prompts.find((prompt) => prompt.role === 'summary');
                const expanded = expandedGroupId === group.id;
                return (
                  <Fragment key={group.id}>
                    <tr>
                      <td>
                        {group.name}
                        {group.description ? <div className="muted">{group.description}</div> : null}
                      </td>
                      <td>{group.docType ?? 'Any'}</td>
                      <td>{group.isDefault ? 'Yes' : 'No'}</td>
                      <td>{analysisPrompts.length}</td>
                      <td className="row-actions">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => {
                            setExpandedGroupId(expanded ? null : group.id);
                            setEditingPromptId(null);
                            setPromptDraft('');
                          }}
                        >
                          {expanded ? 'Hide prompts' : 'Manage prompts'}
                        </button>
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
                    {expanded ? (
                      <tr>
                        <td colSpan={5}>
                          <div className="prompt-manager">
                            {summaryPrompt ? (
                              <div className="prompt-row prompt-row-summary">
                                <span className="badge">Summary</span>
                                {editingPromptId === summaryPrompt.id ? (
                                  <>
                                    <textarea
                                      value={editingText}
                                      onChange={(event) => setEditingText(event.target.value)}
                                      rows={2}
                                    />
                                    <button type="button" onClick={() => void saveEditingPrompt(group.id)}>
                                      Save
                                    </button>
                                    <button type="button" className="link" onClick={() => setEditingPromptId(null)}>
                                      Cancel
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <span>{summaryPrompt.text}</span>
                                    <button type="button" onClick={() => startEditingPrompt(summaryPrompt)}>
                                      Edit
                                    </button>
                                  </>
                                )}
                              </div>
                            ) : null}
                            <p className="hint">
                              Analysis prompts run first, in this order: drag a row, or use its ↑ / ↓ buttons, to reorder it.
                            </p>
                            <ul className="prompt-list">
                              {analysisPrompts.map((prompt, index) => (
                                <li
                                  key={prompt.id}
                                  className={`prompt-row${dragPromptId === prompt.id ? ' is-dragging' : ''}`}
                                  draggable
                                  onDragStart={() => setDragPromptId(prompt.id)}
                                  onDragOver={(event) => event.preventDefault()}
                                  onDrop={() => void dropPromptOn(group, prompt.id)}
                                >
                                  <span className="badge">Step {index + 1}</span>
                                  <div className="prompt-move">
                                    <button
                                      type="button"
                                      className="link"
                                      title="Move up"
                                      aria-label={`Move step ${index + 1} up`}
                                      disabled={index === 0}
                                      onClick={() => void movePrompt(group, prompt.id, -1)}
                                    >
                                      ↑
                                    </button>
                                    <button
                                      type="button"
                                      className="link"
                                      title="Move down"
                                      aria-label={`Move step ${index + 1} down`}
                                      disabled={index === analysisPrompts.length - 1}
                                      onClick={() => void movePrompt(group, prompt.id, 1)}
                                    >
                                      ↓
                                    </button>
                                  </div>
                                  {editingPromptId === prompt.id ? (
                                    <>
                                      <textarea
                                        value={editingText}
                                        onChange={(event) => setEditingText(event.target.value)}
                                        rows={2}
                                      />
                                      <button type="button" onClick={() => void saveEditingPrompt(group.id)}>
                                        Save
                                      </button>
                                      <button type="button" className="link" onClick={() => setEditingPromptId(null)}>
                                        Cancel
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      <span>{prompt.text}</span>
                                      <button type="button" onClick={() => startEditingPrompt(prompt)}>
                                        Edit
                                      </button>
                                      <button
                                        type="button"
                                        className="danger"
                                        onClick={() => void removePrompt(group.id, prompt)}
                                      >
                                        Delete
                                      </button>
                                    </>
                                  )}
                                </li>
                              ))}
                            </ul>
                            {analysisPrompts.length >= 10 ? (
                              <p className="muted">At the cap of 10 analysis prompts.</p>
                            ) : (
                              <div className="inline-form">
                                <label className="full-width">
                                  New analysis prompt
                                  <textarea
                                    value={promptDraft}
                                    onChange={(event) => setPromptDraft(event.target.value)}
                                    rows={2}
                                  />
                                </label>
                                <button type="button" onClick={() => void addPrompt(group.id)}>
                                  Add prompt
                                </button>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>LLM endpoints</h2>
        <p className="hint">
          Where a future AI feature is allowed to send a document or a prompt. Registering one is the
          only thing in this product that reaches outside its own machine, and only to an address on
          your own network: a public internet address is refused.
        </p>
        <form
          className="inline-form"
          onSubmit={(event) => {
            void addLlmEndpoint(event);
          }}
        >
          <label>
            Endpoint name
            <input name="name" type="text" required maxLength={200} />
          </label>
          <label>
            URL
            <input
              name="url"
              type="text"
              required
              placeholder="A private address, e.g. 10.0.0.5:8000/v1/chat/completions"
            />
          </label>
          <label>
            Authentication
            <select name="authScheme" defaultValue="none">
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="header">Custom header</option>
            </select>
          </label>
          <label>
            Header name
            <input name="authHeaderName" type="text" maxLength={200} placeholder="Only for a custom header" />
          </label>
          <label>
            Secret
            <input name="authSecret" type="password" placeholder="Bearer token or header value" />
          </label>
          <label className="checkbox-field">
            <input name="isDefault" type="checkbox" />
            Set as installation default
          </label>
          <button type="submit" className="primary" disabled={busy}>
            Register
          </button>
        </form>

        {llmEndpoints.length === 0 ? (
          <p className="muted">No endpoints registered yet.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">URL</th>
                <th scope="col">Authentication</th>
                <th scope="col">Secret</th>
                <th scope="col">Default</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {llmEndpoints.map((endpoint) => (
                <tr key={endpoint.id}>
                  <td>{endpoint.name}</td>
                  <td className="mono">{endpoint.url}</td>
                  <td>{endpoint.authScheme}</td>
                  <td>{endpoint.hasSecret ? 'Set' : <span className="muted">None</span>}</td>
                  <td>{endpoint.isDefault ? 'Yes' : 'No'}</td>
                  <td className="row-actions">
                    <button type="button" onClick={() => void testEndpoint(endpoint)}>
                      Test connection
                    </button>
                    <button
                      type="button"
                      disabled={endpoint.isDefault}
                      onClick={() => void setEndpointDefault(endpoint)}
                    >
                      Set as default
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void removeLlmEndpoint(endpoint)}
                    >
                      Delete
                    </button>
                    {testResults[endpoint.id] ? (
                      <div className="muted" role="status">
                        {testResults[endpoint.id]}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Chat</h2>
        <p className="hint">
          Which registered endpoint Chat sends a conversation to. Chat is not scoped to one kind of
          document, so it has no dropdown of its own the way a workflow group does: it always uses
          this choice, or the installation default when none is set here.
        </p>
        <label>
          Endpoint for Chat
          <select
            value={chatSettings.endpointId ?? ''}
            onChange={(event) => void changeChatEndpoint(event.target.value)}
          >
            <option value="">Installation default</option>
            {llmEndpoints.map((endpoint) => (
              <option key={endpoint.id} value={endpoint.id}>
                {endpoint.name}
              </option>
            ))}
          </select>
        </label>
        {chatEndpoint ? (
          <dl className="endpoint-detail">
            <dt>URL</dt>
            <dd className="mono">{chatEndpoint.url}</dd>
            <dt>Authentication</dt>
            <dd>{chatEndpoint.authScheme}</dd>
            <dt>Secret</dt>
            <dd>{chatEndpoint.hasSecret ? 'Set' : <span className="muted">None</span>}</dd>
            <dt>Request format</dt>
            <dd>{chatEndpoint.requestFormat}</dd>
          </dl>
        ) : (
          <p className="hint">
            The installation default is {llmEndpoints.find((endpoint) => endpoint.isDefault)?.name ?? 'not set'}.
          </p>
        )}
      </section>
      </>
      ) : null}

      {activeSection === 'export' ? (
      <section>
        <h2>Export template</h2>
        <p className="hint">
          The house style for Standardized export: applied to any document exported that way,
          overriding the document&rsquo;s own formatting. Header and footer content may use{' '}
          <code>{'{{document.title}}'}</code>, <code>{'{{document.type}}'}</code>,{' '}
          <code>{'{{date}}'}</code>, <code>{'{{page}}'}</code> and <code>{'{{pageCount}}'}</code>.
        </p>
        {templateDraft ? (
          <div className="export-template-editor">
            <h3>Footer logo</h3>
            <p className="hint">
              Shown at the footer&rsquo;s left, beside its text. PNG or JPEG only, up to 512 KB and
              2000&times;2000 pixels.
            </p>
            <div className="logo-editor">
              {templateDraft.logo ? (
                <img src={templateDraft.logo.dataUrl} alt="Current footer logo" className="logo-preview" />
              ) : (
                <span className="muted">No logo set.</span>
              )}
              <form
                className="inline-form"
                onSubmit={(event) => {
                  void uploadExportLogo(event);
                }}
              >
                <label className="visually-hidden" htmlFor="logo-upload">
                  Logo file
                </label>
                <input id="logo-upload" name="logo" type="file" accept="image/png,image/jpeg" />
                <button type="submit" disabled={busy}>
                  Upload
                </button>
              </form>
              {templateDraft.logo ? (
                <button type="button" className="danger" onClick={() => void removeExportLogo()}>
                  Remove logo
                </button>
              ) : null}
            </div>

            <h3>Header</h3>
            <table className="grid">
              <thead>
                <tr>
                  <th scope="col">Side</th>
                  <th scope="col">Content</th>
                  <th scope="col">Font</th>
                  <th scope="col">Size</th>
                  <th scope="col">Colour</th>
                  <th scope="col">Bold</th>
                  <th scope="col">Italic</th>
                </tr>
              </thead>
              <tbody>
                {(['left', 'right'] as const).map((side) => (
                  <tr key={side}>
                    <td>{side === 'left' ? 'Left' : 'Right'}</td>
                    <td>
                      <input
                        aria-label={`Header ${side} content`}
                        value={templateDraft.header[side].content}
                        onChange={(event) => updateSide('header', side, { content: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Header ${side} font`}
                        value={templateDraft.header[side].fontFamily}
                        onChange={(event) => updateSide('header', side, { fontFamily: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Header ${side} size`}
                        type="number"
                        min={6}
                        max={96}
                        value={templateDraft.header[side].fontSize}
                        onChange={(event) => updateSide('header', side, { fontSize: Number(event.target.value) })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Header ${side} colour`}
                        type="color"
                        value={templateDraft.header[side].color}
                        onChange={(event) => updateSide('header', side, { color: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Header ${side} bold`}
                        type="checkbox"
                        checked={templateDraft.header[side].bold}
                        onChange={(event) => updateSide('header', side, { bold: event.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Header ${side} italic`}
                        type="checkbox"
                        checked={templateDraft.header[side].italic}
                        onChange={(event) => updateSide('header', side, { italic: event.target.checked })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>Footer</h3>
            <table className="grid">
              <thead>
                <tr>
                  <th scope="col">Side</th>
                  <th scope="col">Content</th>
                  <th scope="col">Font</th>
                  <th scope="col">Size</th>
                  <th scope="col">Colour</th>
                  <th scope="col">Bold</th>
                  <th scope="col">Italic</th>
                </tr>
              </thead>
              <tbody>
                {(['left', 'right'] as const).map((side) => (
                  <tr key={side}>
                    <td>{side === 'left' ? 'Left' : 'Right'}</td>
                    <td>
                      <input
                        aria-label={`Footer ${side} content`}
                        value={templateDraft.footer[side].content}
                        onChange={(event) => updateSide('footer', side, { content: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Footer ${side} font`}
                        value={templateDraft.footer[side].fontFamily}
                        onChange={(event) => updateSide('footer', side, { fontFamily: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Footer ${side} size`}
                        type="number"
                        min={6}
                        max={96}
                        value={templateDraft.footer[side].fontSize}
                        onChange={(event) => updateSide('footer', side, { fontSize: Number(event.target.value) })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Footer ${side} colour`}
                        type="color"
                        value={templateDraft.footer[side].color}
                        onChange={(event) => updateSide('footer', side, { color: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Footer ${side} bold`}
                        type="checkbox"
                        checked={templateDraft.footer[side].bold}
                        onChange={(event) => updateSide('footer', side, { bold: event.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Footer ${side} italic`}
                        type="checkbox"
                        checked={templateDraft.footer[side].italic}
                        onChange={(event) => updateSide('footer', side, { italic: event.target.checked })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>Headings</h3>
            <table className="grid">
              <thead>
                <tr>
                  <th scope="col">Level</th>
                  <th scope="col">Font</th>
                  <th scope="col">Size</th>
                  <th scope="col">Colour</th>
                  <th scope="col">Bold</th>
                  <th scope="col">Italic</th>
                  <th scope="col">Space before (pt)</th>
                  <th scope="col">Space after (pt)</th>
                </tr>
              </thead>
              <tbody>
                {templateDraft.headings.map((heading, index) => (
                  <tr key={index}>
                    <td>Heading {index + 1}</td>
                    <td>
                      <input
                        aria-label={`Heading ${index + 1} font`}
                        value={heading.fontFamily}
                        onChange={(event) => updateHeading(index, { fontFamily: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Heading ${index + 1} size`}
                        type="number"
                        min={6}
                        max={96}
                        value={heading.fontSize}
                        onChange={(event) => updateHeading(index, { fontSize: Number(event.target.value) })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Heading ${index + 1} colour`}
                        type="color"
                        value={heading.color}
                        onChange={(event) => updateHeading(index, { color: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Heading ${index + 1} bold`}
                        type="checkbox"
                        checked={heading.bold}
                        onChange={(event) => updateHeading(index, { bold: event.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Heading ${index + 1} italic`}
                        type="checkbox"
                        checked={heading.italic}
                        onChange={(event) => updateHeading(index, { italic: event.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Heading ${index + 1} space before`}
                        type="number"
                        min={0}
                        max={144}
                        value={heading.spacingBeforePt}
                        onChange={(event) => updateHeading(index, { spacingBeforePt: Number(event.target.value) })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Heading ${index + 1} space after`}
                        type="number"
                        min={0}
                        max={144}
                        value={heading.spacingAfterPt}
                        onChange={(event) => updateHeading(index, { spacingAfterPt: Number(event.target.value) })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>Body text</h3>
            <table className="grid">
              <thead>
                <tr>
                  <th scope="col">Font</th>
                  <th scope="col">Size</th>
                  <th scope="col">Colour</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <input
                      aria-label="Body font"
                      value={templateDraft.body.fontFamily}
                      onChange={(event) => updateBody({ fontFamily: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label="Body size"
                      type="number"
                      min={6}
                      max={96}
                      value={templateDraft.body.fontSize}
                      onChange={(event) => updateBody({ fontSize: Number(event.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label="Body colour"
                      type="color"
                      value={templateDraft.body.color}
                      onChange={(event) => updateBody({ color: event.target.value })}
                    />
                  </td>
                </tr>
              </tbody>
            </table>

            <h3>Tables</h3>
            <table className="grid">
              <thead>
                <tr>
                  <th scope="col">Border colour</th>
                  <th scope="col">Border width (pt)</th>
                  <th scope="col">Header row background</th>
                  <th scope="col">Banded rows</th>
                  <th scope="col">Band background</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <input
                      aria-label="Table border colour"
                      type="color"
                      value={templateDraft.table.borderColor}
                      onChange={(event) => updateTable({ borderColor: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label="Table border width"
                      type="number"
                      min={0.25}
                      max={6}
                      step={0.25}
                      value={templateDraft.table.borderWidthPt}
                      onChange={(event) => updateTable({ borderWidthPt: Number(event.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label="Table header row background"
                      type="color"
                      value={templateDraft.table.headerRowBackground}
                      onChange={(event) => updateTable({ headerRowBackground: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label="Table banded rows"
                      type="checkbox"
                      checked={templateDraft.table.bandedRows}
                      onChange={(event) => updateTable({ bandedRows: event.target.checked })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label="Table band background"
                      type="color"
                      value={templateDraft.table.bandedRowBackground}
                      onChange={(event) => updateTable({ bandedRowBackground: event.target.value })}
                    />
                  </td>
                </tr>
              </tbody>
            </table>

            <h3>Table of contents</h3>
            <table className="grid">
              <thead>
                <tr>
                  <th scope="col">Level</th>
                  <th scope="col">Font</th>
                  <th scope="col">Size</th>
                  <th scope="col">Colour</th>
                  <th scope="col">Indent (pt)</th>
                </tr>
              </thead>
              <tbody>
                {templateDraft.toc.map((level, index) => (
                  <tr key={index}>
                    <td>TOC {index + 1}</td>
                    <td>
                      <input
                        aria-label={`TOC ${index + 1} font`}
                        value={level.fontFamily}
                        onChange={(event) => updateTocLevel(index, { fontFamily: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`TOC ${index + 1} size`}
                        type="number"
                        min={6}
                        max={96}
                        value={level.fontSize}
                        onChange={(event) => updateTocLevel(index, { fontSize: Number(event.target.value) })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`TOC ${index + 1} colour`}
                        type="color"
                        value={level.color}
                        onChange={(event) => updateTocLevel(index, { color: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`TOC ${index + 1} indent`}
                        type="number"
                        min={0}
                        max={144}
                        value={level.indentPt}
                        onChange={(event) => updateTocLevel(index, { indentPt: Number(event.target.value) })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <button type="button" className="primary" disabled={busy} onClick={() => void saveExportTemplate()}>
              Save export template
            </button>
          </div>
        ) : null}
      </section>
      ) : null}

      {activeSection === 'audit' ? (
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
      ) : null}
        </div>
      </div>
    </div>
  );
}
