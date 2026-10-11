import type {
  CacheSummary,
  CompareResponse,
  ContentResponse,
  CostSummary,
  FiltersResponse,
  Finding,
  HealthResponse,
  OverviewResponse,
  Page,
  ProviderInfo,
  RequestContext,
  RequestDetail,
  RequestSummary,
  SessionDetail,
  SessionSummary,
  SettingsResponse,
  TimeBucket,
} from '@contextscope/shared';

/** Same-origin API client. In dev/preview Vite proxies /api to the ContextScope server. */

/** Base path the dashboard is served under (Vite `base`, default '/'), without the trailing slash. */
export const BASE_PATH = (import.meta.env.BASE_URL ?? '/').replace(/\/+$/, '');

/** Prefix an absolute app path such as '/api/health' with the base path. */
export const withBase = (path: string): string => `${BASE_PATH}${path}`;

export const TOKEN_KEY = 'cs.token';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();
export const onUnauthorized = (fn: UnauthorizedListener): (() => void) => {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
};

export const getToken = (): string | null => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

export const setToken = (token: string | null): void => {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (sandboxed) */
  }
};

export type QueryValue = string | number | boolean | null | undefined;

export const buildQuery = (params: Record<string, QueryValue> = {}): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

const request = async <T>(
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> => {
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (method !== 'GET') {
    headers['x-contextscope-csrf'] = '1';
    headers['content-type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(withBase(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: 'same-origin',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Could not reach the ContextScope server.');
  }
  if (res.status === 401) unauthorizedListeners.forEach((fn) => fn());
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = `${res.status} ${res.statusText || 'Request failed'}`;
    try {
      const data = (await res.json()) as { error?: { code?: string; message?: string } };
      if (data.error?.code) code = data.error.code;
      if (data.error?.message) message = data.error.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
};

export const apiGet = <T>(path: string, params?: Record<string, QueryValue>, signal?: AbortSignal) =>
  request<T>('GET', `${path}${buildQuery(params)}`, undefined, signal);

export interface RequestListParams {
  page?: number;
  pageSize?: number;
  q?: string;
  provider?: string;
  model?: string;
  state?: string;
  session?: string;
  sort?: 'startedAt' | 'cost' | 'duration' | 'inputTokens';
  dir?: 'asc' | 'desc';
  from?: string;
  to?: string;
}

export interface OverviewParams {
  from?: string;
  to?: string;
  provider?: string;
  model?: string;
}

export type Bucket = 'hour' | 'day';

export interface SettingsUpdate {
  captureMode?: string;
  contentRetentionHours?: number;
  metadataRetentionDays?: number;
  pricingOverrides?: unknown[];
}

const enc = encodeURIComponent;

export const api = {
  health: (s?: AbortSignal) => apiGet<HealthResponse>('/api/health', undefined, s),
  overview: (p: OverviewParams, s?: AbortSignal) =>
    apiGet<OverviewResponse>('/api/overview', { ...p }, s),
  filters: (s?: AbortSignal) => apiGet<FiltersResponse>('/api/filters', undefined, s),
  requests: (p: RequestListParams, s?: AbortSignal) =>
    apiGet<Page<RequestSummary>>('/api/requests', { ...p }, s),
  request: (id: string, s?: AbortSignal) => apiGet<RequestDetail>(`/api/requests/${enc(id)}`, undefined, s),
  requestContext: (id: string, s?: AbortSignal) =>
    apiGet<RequestContext>(`/api/requests/${enc(id)}/context`, undefined, s),
  requestFindings: (id: string, s?: AbortSignal) =>
    apiGet<Finding[]>(`/api/requests/${enc(id)}/findings`, undefined, s),
  /** Resolves to null when the server answers 404 content_unavailable. */
  requestContent: async (id: string, s?: AbortSignal): Promise<ContentResponse | null> => {
    try {
      return await apiGet<ContentResponse>(`/api/requests/${enc(id)}/content`, undefined, s);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.code === 'content_unavailable')) return null;
      throw err;
    }
  },
  sessions: (p: { page?: number; pageSize?: number }, s?: AbortSignal) =>
    apiGet<Page<SessionSummary>>('/api/sessions', { ...p }, s),
  session: (id: string, s?: AbortSignal) => apiGet<SessionDetail>(`/api/sessions/${enc(id)}`, undefined, s),
  cacheSummary: (s?: AbortSignal) => apiGet<CacheSummary>('/api/cache/summary', undefined, s),
  cacheTrends: (bucket: Bucket, s?: AbortSignal) => apiGet<TimeBucket[]>('/api/cache/trends', { bucket }, s),
  costSummary: (s?: AbortSignal) => apiGet<CostSummary>('/api/costs/summary', undefined, s),
  costTrends: (bucket: Bucket, s?: AbortSignal) => apiGet<TimeBucket[]>('/api/costs/trends', { bucket }, s),
  optimizations: (p: { severity?: string; type?: string }, s?: AbortSignal) =>
    apiGet<Finding[]>('/api/optimizations', { ...p }, s),
  compare: (a: string, b: string, s?: AbortSignal) => apiGet<CompareResponse>('/api/compare', { a, b }, s),
  providers: (s?: AbortSignal) => apiGet<ProviderInfo[]>('/api/providers', undefined, s),
  settings: (s?: AbortSignal) => apiGet<SettingsResponse>('/api/settings', undefined, s),
  updateSettings: (body: SettingsUpdate) => request<SettingsResponse>('PUT', '/api/settings', body),
};

/** Builds the SSE URL. EventSource cannot send headers, so the token travels as a query param. */
export const eventsUrl = (): string => {
  const token = getToken();
  return withBase(`/api/events${buildQuery({ token })}`);
};
