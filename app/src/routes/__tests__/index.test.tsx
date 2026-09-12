import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import { OverviewPage } from '../index';

describe('OverviewPage', () => {
  it('renders the store counts from /api/status', async () => {
    vi.spyOn(api, 'getStatus').mockResolvedValue({
      name: 'mcp-zeromem',
      version: '1.2.3',
      uptimeSeconds: 3725,
      authEnabled: true,
      readOnly: false,
      engine: {
        home: '/data',
        turns: 12345,
        sessions: 7,
        entities: 40,
        edges: 90,
        windows: 20,
        episodes: 9,
        embeddings: 12340,
        embedding_backlog: 0,
        embedder: 'bge-small-en-v1.5',
        embedder_kind: 'onnx',
        embedder_dim: 384,
        embedder_active: true,
        embedder_is_fallback: false,
        embedder_warning: null,
        generation: 2,
        schema_version: 3,
        curation_seq: 0,
        hidden: 0,
        notes: 0,
      },
    });
    vi.spyOn(api, 'getGrowth').mockResolvedValue({
      days: [
        { day: '2026-09-01', turns: 10, sessions: 2, cumulative_turns: 12335 },
        { day: '2026-09-02', turns: 10, sessions: 1, cumulative_turns: 12345 },
      ],
      generation: 2,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <OverviewPage />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('12,345')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('1h 02m')).toBeInTheDocument();
    expect(screen.getByText(/Store: \/data/)).toBeInTheDocument();
    expect(await screen.findByText('Turns per day')).toBeInTheDocument();
    expect(screen.getByText('Turns in the store')).toBeInTheDocument();
  });
});
