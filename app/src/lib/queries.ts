import type {
  ClearScope,
  EmbedderChangeRequest,
  GraphOptions,
  GrowthOptions,
  HierarchyOptions,
  PageQuery,
  ProjectionOptions,
  RecallRequest,
} from '@mcp-zeromem/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from './api';

export const queryKeys = {
  status: ['status'] as const,
  sessions: (page: PageQuery = {}) => ['sessions', page] as const,
  sessionTurns: (sessionId: string) => ['sessions', sessionId, 'turns'] as const,
  recall: (body: RecallRequest) => ['recall', body] as const,
  recallTrace: (body: RecallRequest) => ['recall', 'trace', body] as const,
  graph: (options: GraphOptions) => ['viz', 'graph', options] as const,
  hierarchy: (options: HierarchyOptions) => ['viz', 'hierarchy', options] as const,
  sessionEntities: (sessionId: string) => ['viz', 'sessions', sessionId, 'turns'] as const,
  projection: (options: ProjectionOptions) => ['viz', 'projection', options] as const,
  growth: (options: GrowthOptions) => ['viz', 'growth', options] as const,
  health: ['viz', 'health'] as const,
  evalHistory: ['viz', 'eval'] as const,
  embedderSettings: ['settings', 'embedder'] as const,
};

// --- queries ---

export function useServerStatus() {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: api.getStatus,
    // The counts move whenever a hook or an agent remembers something; poll so
    // the overview stays honest, and faster while a re-embed is draining.
    refetchInterval: (query) => ((query.state.data?.engine.embedding_backlog ?? 0) > 0 ? 2_000 : 15_000),
  });
}

export function useSessions(page: PageQuery = {}) {
  return useQuery({
    queryKey: queryKeys.sessions(page),
    queryFn: () => api.listSessions(page),
    refetchInterval: 15_000,
  });
}

export function useSessionTurns(sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.sessionTurns(sessionId ?? ''),
    queryFn: () => api.getSessionTurns(sessionId ?? '', { limit: 1000 }),
    enabled: sessionId !== null,
  });
}

/** A recall is a read, but it is issued on demand, so it is a query that is only enabled once there is text. */
export function useRecall(body: RecallRequest | null) {
  return useQuery({
    queryKey: queryKeys.recall(body ?? { query: '' }),
    queryFn: () => api.recall(body ?? { query: '' }),
    enabled: body !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useRecallTrace(body: RecallRequest | null) {
  return useQuery({
    queryKey: queryKeys.recallTrace(body ?? { query: '' }),
    queryFn: () => api.recallTrace(body ?? { query: '' }),
    enabled: body !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

// --- visualisations ---

/**
 * Structure snapshots are keyed by their options and kept for a minute: a
 * force layout is expensive to restart, so the page holds the previous
 * snapshot while a new one loads (`placeholderData`) rather than blanking.
 */
export function useGraph(options: GraphOptions) {
  return useQuery({
    queryKey: queryKeys.graph(options),
    queryFn: () => api.getGraph(options),
    placeholderData: (previous) => previous,
    staleTime: 60_000,
  });
}

export function useHierarchy(options: HierarchyOptions) {
  return useQuery({
    queryKey: queryKeys.hierarchy(options),
    queryFn: () => api.getHierarchy(options),
    placeholderData: (previous) => previous,
    staleTime: 60_000,
  });
}

export function useSessionTurnsWithEntities(sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.sessionEntities(sessionId ?? ''),
    queryFn: () => api.getSessionTurnsWithEntities(sessionId ?? '', { limit: 1000 }),
    enabled: sessionId !== null,
  });
}

export function useProjection(options: ProjectionOptions) {
  return useQuery({
    queryKey: queryKeys.projection(options),
    queryFn: () => api.getProjection(options),
    placeholderData: (previous) => previous,
    staleTime: 60_000,
  });
}

export function useGrowth(options: GrowthOptions = {}) {
  return useQuery({
    queryKey: queryKeys.growth(options),
    queryFn: () => api.getGrowth(options),
    placeholderData: (previous) => previous,
    refetchInterval: 60_000,
  });
}

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: api.getHealth,
    placeholderData: (previous) => previous,
    refetchInterval: 15_000,
  });
}

export function useEvalHistory() {
  return useQuery({
    queryKey: queryKeys.evalHistory,
    queryFn: api.getEvalHistory,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

// --- settings ---

export function useEmbedderSettings() {
  return useQuery({
    queryKey: queryKeys.embedderSettings,
    queryFn: api.getEmbedderSettings,
    // While the worker re-embeds, the backlog is the progress bar.
    refetchInterval: (query) => ((query.state.data?.embedding_backlog ?? 0) > 0 ? 2_000 : 15_000),
  });
}

// --- mutations ---

/** Try a candidate embedder without changing anything; the result is the spec's name, dimension and latency. */
export function useTestEmbedder() {
  return useMutation({ mutationFn: (body: EmbedderChangeRequest) => api.testEmbedder(body) });
}

/** Switch the store's embedder; every read is invalidated because the dense view is being rebuilt. */
export function useSetEmbedder() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: EmbedderChangeRequest) => api.setEmbedder(body),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.embedderSettings });
      client.invalidateQueries({ queryKey: queryKeys.status });
      client.invalidateQueries({ queryKey: ['sessions'] });
      client.invalidateQueries({ queryKey: ['recall'] });
      client.invalidateQueries({ queryKey: ['viz'] });
    },
  });
}

/** Re-make every vector with the store's embedder; invalidates what a switch does. */
export function useReembed() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.reembed(),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.embedderSettings });
      client.invalidateQueries({ queryKey: queryKeys.status });
      client.invalidateQueries({ queryKey: ['recall'] });
      client.invalidateQueries({ queryKey: ['viz'] });
    },
  });
}

/** Clear the vectors or the whole memory; every cached read is stale after either. */
export function useClearStore() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (scope: ClearScope) => api.clearStore(scope),
    onSuccess: () => client.invalidateQueries(),
  });
}

export function useForgetSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api.forgetSession(sessionId),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['sessions'] });
      client.invalidateQueries({ queryKey: queryKeys.status });
      client.invalidateQueries({ queryKey: ['recall'] });
      client.invalidateQueries({ queryKey: ['viz'] });
    },
  });
}

export function useIngest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.ingest,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['sessions'] });
      client.invalidateQueries({ queryKey: queryKeys.status });
      client.invalidateQueries({ queryKey: ['recall'] });
      client.invalidateQueries({ queryKey: ['viz'] });
    },
  });
}
