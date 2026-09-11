import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import { EvalDashboard } from '../eval';

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <EvalDashboard />
    </QueryClientProvider>,
  );
}

describe('EvalDashboard', () => {
  it('charts one series per profile × embedder and tables the latest recording', async () => {
    const run = (commit: string, recorded_at: string, embedder: string, recall: number) => ({
      recorded_at,
      commit,
      label: 'checkpoint',
      profile: 'large',
      embedder,
      k: 5,
      queries: 266,
      recall_at_k: recall,
      mrr: 0.9,
      ndcg_at_k: 0.8,
      missed: 2,
    });
    vi.spyOn(api, 'getEvalHistory').mockResolvedValue({
      source: 'docs/eval/history.jsonl',
      runs: [
        run('aaaaaaa', '2026-09-01T00:00:00Z', 'bge-small-en-v1.5', 0.85),
        run('aaaaaaa', '2026-09-01T00:00:00Z', 'hash-384', 0.7),
        run('bbbbbbb', '2026-09-08T00:00:00Z', 'bge-small-en-v1.5', 0.88),
        run('bbbbbbb', '2026-09-08T00:00:00Z', 'hash-384', 0.71),
      ],
    });
    mount();

    expect(await screen.findByRole('img', { name: 'Recall@5 per commit' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'nDCG@5 per commit' })).toBeInTheDocument();
    expect(screen.getByText(/2 recordings/)).toBeInTheDocument();
    expect(screen.getAllByText('large · hash-384').length).toBeGreaterThan(0);
    // Only the latest recording is tabled: two rows, both at commit bbbbbbb.
    expect(screen.getAllByRole('cell', { name: 'bbbbbbb' })).toHaveLength(2);
    expect(screen.queryByRole('cell', { name: 'aaaaaaa' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('cell', { name: '88%' })).toHaveLength(1);
  });

  it('points at the recording script when the history is empty', async () => {
    vi.spyOn(api, 'getEvalHistory').mockResolvedValue({ source: 'docs/eval/history.jsonl', runs: [] });
    mount();
    expect(await screen.findByText(/No eval runs recorded yet/)).toBeInTheDocument();
    expect(screen.getByText('scripts/record-eval.sh')).toBeInTheDocument();
  });
});
