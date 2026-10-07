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

  it('shows the probe numbers a run carries and a dash where it has none', async () => {
    const base = {
      recorded_at: '2026-10-07T00:00:00Z',
      commit: 'ccccccc',
      profile: 'large',
      k: 5,
      queries: 266,
      recall_at_k: 0.86,
      mrr: 0.95,
      ndcg_at_k: 0.78,
      missed: 3,
    };
    vi.spyOn(api, 'getEvalHistory').mockResolvedValue({
      source: 'docs/eval/history.jsonl',
      runs: [
        {
          ...base,
          embedder: 'hash-384',
          tokens_per_answer: 71.2,
          history_ndcg_at_k: 0.68,
          as_of_ndcg_at_k: 0.58,
          abstain_answered: 1,
          abstain_auc: 0.8,
        },
        { ...base, embedder: 'bge-small-en-v1.5' },
      ],
    });
    mount();

    expect(await screen.findByRole('columnheader', { name: 'History nDCG' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '68%' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '58%' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '0.80' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '71' })).toBeInTheDocument();
    // The run without probes shows a dash in each of the four columns.
    expect(screen.getAllByRole('cell', { name: '—' })).toHaveLength(4);
  });

  it('points at the recording script when the history is empty', async () => {
    vi.spyOn(api, 'getEvalHistory').mockResolvedValue({ source: 'docs/eval/history.jsonl', runs: [] });
    mount();
    expect(await screen.findByText(/No eval runs recorded yet/)).toBeInTheDocument();
    expect(screen.getByText('scripts/record-eval.sh')).toBeInTheDocument();
  });
});
