import type { QueryTrace, ServerStatus, TurnWithEntities } from '@mcp-zeromem/shared';

export const status: ServerStatus = {
  name: 'mcp-zeromem',
  version: '0',
  uptimeSeconds: 1,
  authEnabled: false,
  readOnly: false,
  engine: {
    home: '/data',
    turns: 3,
    sessions: 2,
    entities: 3,
    edges: 2,
    windows: 2,
    episodes: 2,
    embeddings: 3,
    embedding_backlog: 0,
    embedder: 'hash-384',
    embedder_kind: 'hash',
    embedder_dim: 384,
    embedder_active: true,
    embedder_is_fallback: true,
    embedder_warning: 'no model',
    generation: 0,
    schema_version: 3,
    curation_seq: 0,
    hidden: 0,
    notes: 0,
  },
};

export const T0 = 1_700_000_000_000;

export const turns: TurnWithEntities[] = [
  {
    id: 1,
    uuid: 'u1',
    session_id: 'alpha',
    speaker: 'user',
    text: 'Maya Okafor owns billing.',
    ts: T0,
    entities: [{ key: 'maya okafor', kind: 'name', surface: 'Maya Okafor', start: 0, end: 11 }],
  },
  {
    id: 2,
    uuid: 'u2',
    session_id: 'alpha',
    speaker: 'assistant',
    text: 'Noted, 3 services then.',
    ts: T0 + 60_000,
    entities: [{ key: '3', kind: 'quantity', surface: '3', start: 7, end: 8 }],
  },
];

export const trace: QueryTrace = {
  query: 'who owns billing?',
  profile: { text: 'who owns billing?', tokens: ['owns', 'billing'], entities: [], temporal: false, question: true },
  views: [
    {
      view: 'lexical',
      weight: 1,
      candidates: [
        [1, 2.4],
        [2, 0.3],
      ],
    },
    {
      view: 'dense',
      weight: 0.8,
      candidates: [
        [1, 0.9],
        [3, 0.4],
      ],
    },
  ],
  fused: [
    { id: 1, score: 0.91, sources: ['lexical', 'dense'], ts: T0, uuid: 'u1' },
    { id: 3, score: 0.2, sources: ['dense'], ts: T0, uuid: 'u3' },
  ],
  dropped: [{ id: 3, score: 0.2, reason: 'below the calibrated floor' }],
  evidence: [
    {
      turn: { id: 1, uuid: 'u1', session_id: 'alpha', speaker: 'user', text: 'Maya Okafor owns billing.', ts: T0 },
      score: 0.91,
      confidence: 1,
      role: 'primary',
      sources: ['lexical', 'dense'],
      entities: ['maya okafor'],
    },
  ],
  took_ms: 3,
};
