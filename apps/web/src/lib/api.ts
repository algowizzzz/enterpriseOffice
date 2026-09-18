import type { CommentAnchor, PageSetup, PMNode, StyleTable } from '@docforge/model';

export type Role = 'admin' | 'editor' | 'viewer';
export type UserStatus = 'active' | 'disabled';
export type Access = 'owner' | 'edit' | 'view';
export type Permission = 'view' | 'edit';

export interface User {
  id: string;
  email: string;
  name: string;
  role?: Role;
  status?: UserStatus;
  createdAt?: string;
  lastLoginAt?: string | null;
}

export interface DocumentSummary {
  id: string;
  title: string;
  ownerId: string;
  ownerName: string;
  origin: 'blank' | 'import';
  sourceName: string | null;
  wordCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  access: Access;
  /** Framework, policy, standard, procedure: chosen at upload. */
  docType?: DocumentType | null;
  /** Held still for approval: open to comments, not to edits. */
  locked?: boolean;
}

export interface DocumentDetail extends DocumentSummary {
  content: PMNode;
  /** The running header, the running footer and the orientation of the page. */
  pageSetup: PageSetup;
  /** The document's own styles, when it was uploaded from Word. */
  styles?: StyleTable | null;
  /** Which shared document to join, when the server offers live co-editing. */
  collab?: { epoch: number };
}

export interface DocumentComment {
  id: string;
  parentId: string | null;
  authorId: string | null;
  authorName: string;
  body: string;
  anchor: CommentAnchor | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  /** Whether the person signed in may change or remove it. */
  mine: boolean;
}

export interface CommentThread extends DocumentComment {
  replies: DocumentComment[];
}

export interface VersionSummary {
  revision: number;
  title: string;
  authorName: string;
  createdAt: string;
}

export interface ShareEntry {
  userId: string;
  email: string;
  name: string;
  permission: Permission;
}

export interface AuditEntry {
  id: string;
  createdAt: string;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: unknown;
}

/** An error carrying the server's machine-readable code alongside its message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      ...init,
      headers: {
        // Only declare a JSON body when one is actually being sent. A request
        // that says it carries JSON but sends nothing is rejected as malformed.
        ...(init.body !== undefined && !(init.body instanceof FormData)
          ? { 'content-type': 'application/json' }
          : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
  }

  if (response.status === 204) return undefined as T;

  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  if (!response.ok) {
    if (isJson) {
      const body = (await response.json()) as { error?: { code?: string; message?: string; details?: unknown } };
      throw new ApiError(
        response.status,
        body.error?.code ?? 'ERROR',
        body.error?.message ?? 'The request failed.',
        body.error?.details,
      );
    }
    throw new ApiError(response.status, 'ERROR', `The request failed (${response.status}).`);
  }
  return (isJson ? await response.json() : await response.text()) as T;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

export const api = {
  health: () => request<{ status: string }>('/health'),

  bootstrapStatus: () => request<{ needsSetup: boolean }>('/auth/bootstrap'),

  register: (payload: { email: string; name: string; password: string }) =>
    request<{ user: User }>('/auth/register', { method: 'POST', ...json(payload) }),

  login: (payload: { email: string; password: string }) =>
    request<{ user: User }>('/auth/login', { method: 'POST', ...json(payload) }),

  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  me: () => request<{ user: User }>('/auth/me'),

  changePassword: (payload: { currentPassword: string; newPassword: string }) =>
    request<{ ok: boolean }>('/auth/password', { method: 'POST', ...json(payload) }),

  listUsers: () => request<{ users: User[] }>('/users'),

  createUser: (payload: { email: string; name: string; password: string; role: Role }) =>
    request<{ user: User }>('/users', { method: 'POST', ...json(payload) }),

  updateUser: (id: string, payload: { name?: string; role?: Role; status?: UserStatus }) =>
    request<{ user: User }>(`/users/${id}`, { method: 'PATCH', ...json(payload) }),

  resetUserPassword: (id: string, password: string) =>
    request<{ ok: boolean }>(`/users/${id}/password`, { method: 'POST', ...json({ password }) }),

  listAudit: () => request<{ entries: AuditEntry[] }>('/audit?limit=200'),

  listDocuments: () => request<{ documents: DocumentSummary[] }>('/documents'),

  createDocument: (payload: { title?: string; content?: PMNode } = {}) =>
    request<{ document: DocumentDetail }>('/documents', { method: 'POST', ...json(payload) }),

  getDocument: (id: string) => request<{ document: DocumentDetail }>(`/documents/${id}`),

  saveDocument: (
    id: string,
    payload: {
      title?: string;
      content?: PMNode;
      pageSetup?: PageSetup;
      expectedRevision?: number;
    },
  ) => request<{ document: DocumentDetail }>(`/documents/${id}`, { method: 'PUT', ...json(payload) }),

  deleteDocument: (id: string) =>
    request<{ ok: boolean }>(`/documents/${id}`, { method: 'DELETE' }),

  importDocx: (file: File, options: UploadOptions = {}) => {
    const form = new FormData();
    // Fields first: the server reads them as it reaches the file.
    if (options.docType) form.append('docType', options.docType);
    if (options.stripRunning) form.append('stripRunning', '1');
    form.append('file', file, file.name);
    return request<{ document: DocumentDetail; messages: string[] }>('/documents/import', {
      method: 'POST',
      body: form,
    });
  },

  listVersions: (id: string) =>
    request<{ versions: VersionSummary[] }>(`/documents/${id}/versions`),

  restoreVersion: (id: string, revision: number) =>
    request<{ document: DocumentDetail }>(`/documents/${id}/versions/${revision}/restore`, {
      method: 'POST',
    }),

  listShares: (id: string) => request<{ shares: ShareEntry[] }>(`/documents/${id}/shares`),

  share: (id: string, userId: string, permission: Permission) =>
    request<{ shares: ShareEntry[] }>(`/documents/${id}/shares`, {
      method: 'PUT',
      ...json({ userId, permission }),
    }),

  /** Hold the document still for approval, or release it. Its owner only. */
  setLocked: (id: string, locked: boolean) =>
    request<{ document: DocumentDetail }>(`/documents/${id}/lock`, { method: 'PUT', ...json({ locked }) }),

  /** Hand the document to somebody else. */
  transferOwnership: (id: string, userId: string) =>
    request<{ document: DocumentDetail }>(`/documents/${id}/owner`, { method: 'PUT', ...json({ userId }) }),

  unshare: (id: string, userId: string) =>
    request<{ shares: ShareEntry[] }>(`/documents/${id}/shares/${userId}`, { method: 'DELETE' }),

  /** What changed between two revisions, as a document with tracked changes. */
  compare: (id: string, from: number, to?: number) =>
    request<{ from: number; to: number; content: PMNode }>(
      `/documents/${id}/compare?from=${from}${to === undefined ? '' : `&to=${to}`}`,
    ),

  getVersion: (id: string, revision: number) =>
    request<{ content: PMNode }>(`/documents/${id}/versions/${revision}`),

  listComments: (id: string) => request<{ threads: CommentThread[] }>(`/documents/${id}/comments`),

  addComment: (id: string, input: { body: string; parentId?: string; anchor?: CommentAnchor }) =>
    request<{ comment: DocumentComment }>(`/documents/${id}/comments`, { method: 'POST', ...json(input) }),

  updateComment: (id: string, commentId: string, patch: { body?: string; resolved?: boolean }) =>
    request<{ comment: DocumentComment }>(`/documents/${id}/comments/${commentId}`, {
      method: 'PATCH',
      ...json(patch),
    }),

  removeComment: (id: string, commentId: string) =>
    request<{ ok: true }>(`/documents/${id}/comments/${commentId}`, { method: 'DELETE' }),

  /** The export endpoint returns a file, so it is fetched directly rather than as JSON. */
  exportUrl: (id: string, format: ExportFormat, options: ExportOptions = {}) =>
    `/api/documents/${id}/export?format=${format}${options.changes ? `&changes=${options.changes}` : ''}${
      options.compare ? `&compare=${options.compare}` : ''
    }`,
};

/** Trigger a browser download without leaving the page. */
export const DOCUMENT_TYPES = ['Framework', 'Policy', 'Standard', 'Procedure', 'Guideline', 'Other'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export interface UploadOptions {
  docType?: DocumentType;
  /** Leave the uploaded file's own header and footer out, so the approved ones can go in. */
  stripRunning?: boolean;
}

export type ExportFormat = 'docx' | 'pdf' | 'txt' | 'original';

export interface ExportOptions {
  /** Tracked changes as they stand, all accepted, or all rejected. */
  changes?: 'accepted' | 'rejected';
  /** A redline against an earlier revision: "1" or "1:7". */
  compare?: string;
}

export async function downloadExport(
  id: string,
  format: ExportFormat,
  options: ExportOptions = {},
): Promise<void> {
  const response = await fetch(api.exportUrl(id, format, options), { credentials: 'same-origin' });
  if (!response.ok) throw new ApiError(response.status, 'EXPORT_FAILED', 'The export failed.');
  const disposition = response.headers.get('content-disposition') ?? '';
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileNameFromDisposition(disposition) ?? `document.${format}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function fileNameFromDisposition(disposition: string): string | null {
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      // Fall through to the ASCII form below.
    }
  }
  const plain = /filename="([^"]+)"/iu.exec(disposition);
  return plain?.[1] ?? null;
}
