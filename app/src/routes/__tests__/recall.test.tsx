import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import { RecallPage } from '../recall';

describe('RecallPage', () => {
  it('runs a full-detail recall and renders the evidence with its role and sources', async () => {
    const recall = vi.spyOn(api, 'recall').mockResolvedValue({
      query: 'who owns billing?',
      route: {
        profile: {
          text: 'who owns billing?',
          tokens: ['owns', 'billing'],
          entities: [],
          temporal: false,
          question: true,
        },
        views: [
          { view: 'lexical', weight: 1, candidates: 3 },
          { view: 'dense', weight: 0.8, candidates: 5 },
        ],
      },
      evidence: [
        {
          turn: {
            id: 1,
            uuid: 'u1',
            session_id: 's1',
            speaker: 'user',
            text: 'Maya owns billing.',
            ts: 1_700_000_000_000,
          },
          score: 0.91,
          confidence: 1,
          role: 'primary',
          sources: ['lexical', 'dense'],
          entities: ['maya'],
        },
      ],
      considered: 6,
      took_ms: 3,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RecallPage />
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Query'), 'who owns billing?');
    await user.click(screen.getByRole('button', { name: /recall/i }));

    expect(await screen.findByText('Maya owns billing.')).toBeInTheDocument();
    expect(recall).toHaveBeenCalledWith({ query: 'who owns billing?', top_k: 5, detail: 'full' });
    expect(screen.getByText('primary')).toBeInTheDocument();
    expect(screen.getByText('lexical · 3')).toBeInTheDocument();
    expect(screen.getByText(/1 of 6 candidates/)).toBeInTheDocument();
  });
});
