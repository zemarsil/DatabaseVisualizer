import type {
  ApplySchemaRequest,
  ApplySchemaResponse,
  ConnectionConfig,
  ContainerInfo,
  CreateContainerRequest,
  IntrospectResponse,
} from '@shared/types';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      ...init,
    });
  } catch {
    throw new ApiError('Cannot reach the local API server. Start it with "npm run dev" (or "npm start").', 0);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }
  if (!res.ok) {
    const msg = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : res.statusText;
    throw new ApiError(msg || `Request failed (${res.status})`, res.status);
  }
  return body as T;
}

export interface DockerStatus {
  available: boolean;
  version?: string;
  error?: string;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  defaultDbHost?: string;
}

export const api = {
  health: () => request<HealthResponse>('/health'),
  docker: {
    status: () => request<DockerStatus>('/docker/status'),
    list: () => request<ContainerInfo[]>('/docker/containers'),
    create: (req: CreateContainerRequest) =>
      request<{ container: ContainerInfo; connection: ConnectionConfig }>('/docker/containers', { method: 'POST', body: JSON.stringify(req) }),
    start: (id: string) => request<{ ok: true }>(`/docker/containers/${encodeURIComponent(id)}/start`, { method: 'POST' }),
    stop: (id: string) => request<{ ok: true }>(`/docker/containers/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
    remove: (id: string) => request<{ ok: true }>(`/docker/containers/${encodeURIComponent(id)}/remove`, { method: 'POST' }),
  },
  db: {
    test: (connection: ConnectionConfig) => request<{ ok: boolean; serverVersion?: string; error?: string }>('/db/test', { method: 'POST', body: JSON.stringify(connection) }),
    apply: (req: ApplySchemaRequest) => request<ApplySchemaResponse>('/db/apply', { method: 'POST', body: JSON.stringify(req) }),
    introspect: (connection: ConnectionConfig) => request<IntrospectResponse>('/db/introspect', { method: 'POST', body: JSON.stringify(connection) }),
  },
};
