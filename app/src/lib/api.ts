import type {
  ApiError,
  EmbedderChangeRequest,
  EmbedderProbe,
  EmbedderSettings,
  EmbedderSwitch,
  EvalHistory,
  ForgetResponse,
  GraphOptions,
  GraphSnapshot,
  Growth,
  GrowthOptions,
  Health,
  HierarchyOptions,
  HierarchySnapshot,
  IngestReport,
  IngestRequest,
  PageQuery,
  Projection,
  ProjectionOptions,
  QueryResult,
  QueryTrace,
  RecallRequest,
  ServerStatus,
  SessionsResponse,
  SessionTurnsResponse,
  SessionTurnsWithEntitiesResponse,
} from '@mcp-zeromem/shared';
import { getToken, requireAuth } from './auth';

/** Non-2xx responses throw this; carries the HTTP status and the server's { error, detail? } envelope. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly detail?: string;

  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.detail = detail;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 401) {
    requireAuth();
  }

  if (!response.ok) {
    let message = response.statusText || `Request failed (${response.status})`;
    let detail: string | undefined;
    try {
      const payload = (await response.json()) as Partial<ApiError>;
      if (typeof payload.error === 'string' && payload.error.length > 0) {
        message = payload.error;
      }
      if (typeof payload.detail === 'string') {
        detail = payload.detail;
      }
    } catch {
      // non-JSON error body — keep the status text
    }
    throw new ApiRequestError(response.status, message, detail);
  }

  const text = await response.text();
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

/** `?a=1&b=x` from an options object, skipping undefined and empty values. */
function queryString(options: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== '') {
      params.set(key, String(value));
    }
  }
  return params.size > 0 ? `?${params}` : '';
}

// --- status ---

export function getStatus(): Promise<ServerStatus> {
  return request('/api/status');
}

// --- sessions ---

export function listSessions(page: PageQuery = {}): Promise<SessionsResponse> {
  const params = new URLSearchParams();
  if (page.limit !== undefined) {
    params.set('limit', String(page.limit));
  }
  if (page.offset !== undefined) {
    params.set('offset', String(page.offset));
  }
  const suffix = params.size > 0 ? `?${params}` : '';
  return request(`/api/sessions${suffix}`);
}

export function getSessionTurns(sessionId: string, page: PageQuery = {}): Promise<SessionTurnsResponse> {
  const params = new URLSearchParams();
  if (page.limit !== undefined) {
    params.set('limit', String(page.limit));
  }
  if (page.offset !== undefined) {
    params.set('offset', String(page.offset));
  }
  const suffix = params.size > 0 ? `?${params}` : '';
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/turns${suffix}`);
}

export function forgetSession(sessionId: string): Promise<ForgetResponse> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}

// --- recall ---

export function recall(body: RecallRequest): Promise<QueryResult> {
  return request('/api/recall', { method: 'POST', body });
}

export function recallTrace(body: RecallRequest): Promise<QueryTrace> {
  return request('/api/recall/trace', { method: 'POST', body });
}

// --- ingest ---

export function ingest(body: IngestRequest): Promise<IngestReport> {
  return request('/api/ingest', { method: 'POST', body });
}

// --- visualisations ---

export function getGraph(options: GraphOptions = {}): Promise<GraphSnapshot> {
  return request(`/api/viz/graph${queryString(options)}`);
}

export function getHierarchy(options: HierarchyOptions = {}): Promise<HierarchySnapshot> {
  return request(`/api/viz/hierarchy${queryString(options)}`);
}

export function getSessionTurnsWithEntities(
  sessionId: string,
  page: PageQuery = {},
): Promise<SessionTurnsWithEntitiesResponse> {
  return request(`/api/viz/sessions/${encodeURIComponent(sessionId)}/turns${queryString(page)}`);
}

export function getProjection(options: ProjectionOptions = {}): Promise<Projection> {
  return request(`/api/viz/projection${queryString(options)}`);
}

export function getGrowth(options: GrowthOptions = {}): Promise<Growth> {
  return request(`/api/viz/growth${queryString(options)}`);
}

export function getHealth(): Promise<Health> {
  return request('/api/viz/health');
}

export function getEvalHistory(): Promise<EvalHistory> {
  return request('/api/viz/eval');
}

// --- settings ---

export function getEmbedderSettings(): Promise<EmbedderSettings> {
  return request('/api/settings/embedder');
}

export function testEmbedder(body: EmbedderChangeRequest): Promise<EmbedderProbe> {
  return request('/api/settings/embedder/test', { method: 'POST', body });
}

export function setEmbedder(body: EmbedderChangeRequest): Promise<EmbedderSwitch> {
  return request('/api/settings/embedder', { method: 'PUT', body });
}
