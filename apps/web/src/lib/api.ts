import type { PageSetup, PMNode } from '@docforge/model';

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
}

export interface DocumentDetail extends DocumentSummary {
  content: PMNode;
  /** The running header, the running footer and the orientation of the page. */
  pageSetup: PageSetup;
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

  importDocx: (file: File) => {
    const form = new FormData();
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

  unshare: (id: string, userId: string) =>
    request<{ shares: ShareEntry[] }>(`/documents/${id}/shares/${userId}`, { method: 'DELETE' }),

  /** The export endpoint returns a file, so it is fetched directly rather than as JSON. */
  exportUrl: (id: string, format: 'docx' | 'txt') =>
    `/api/documents/${id}/export?format=${format}`,
};

/** Trigger a browser download without leaving the page. */
export async function downloadExport(id: string, format: 'docx' | 'txt'): Promise<void> {
  const response = await fetch(api.exportUrl(id, format), { credentials: 'same-origin' });
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
