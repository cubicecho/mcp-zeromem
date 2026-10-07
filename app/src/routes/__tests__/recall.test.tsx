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

  it('shows that a question was read as one about the past, and when a hit stopped holding', async () => {
    vi.spyOn(api, 'recall').mockResolvedValue({
      query: 'who owned billing in April 2025?',
      route: {
        profile: {
          text: 'who owned billing in April 2025?',
          tokens: ['owned', 'billing'],
          entities: [],
          temporal: false,
          question: true,
          history: true,
          window: { start: Date.UTC(2025, 3, 1), end: Date.UTC(2025, 4, 1) },
        },
        views: [{ view: 'lexical', weight: 1, candidates: 2 }],
      },
      evidence: [
        {
          turn: {
            id: 1,
            uuid: 'u1',
            session_id: 's1',
            speaker: 'user',
            text: 'Tomas owns billing.',
            ts: Date.UTC(2025, 2, 5),
          },
          score: 0.9,
          confidence: 1,
          role: 'primary',
          superseded_by: 4,
          valid_until: Date.UTC(2025, 5, 2, 9),
        },
      ],
      considered: 2,
      took_ms: 1,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RecallPage />
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Query'), 'who owned billing in April 2025?');
    await user.click(screen.getByRole('button', { name: /recall/i }));

    expect(await screen.findByText('Tomas owns billing.')).toBeInTheDocument();
    expect(screen.getByText('history')).toBeInTheDocument();
    expect(screen.getByText('2025-04-01 – 2025-04-30')).toBeInTheDocument();
    expect(screen.getByText(/superseded 2025-06-02 by #\s*4/)).toBeInTheDocument();
  });

  it('says when memory does not hold the answer, above the turns that came closest', async () => {
    vi.spyOn(api, 'recall').mockResolvedValue({
      query: 'who owns billing on Quill?',
      abstained: { missing: ['quill'], best: 0.62 },
      evidence: [
        {
          turn: {
            id: 1,
            uuid: 'u1',
            session_id: 's1',
            speaker: 'user',
            text: 'Maya owns billing on Heron.',
            ts: 1_700_000_000_000,
          },
          score: 0.62,
          confidence: 1,
          role: 'supporting',
        },
      ],
      considered: 3,
      took_ms: 1,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RecallPage />
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Query'), 'who owns billing on Quill?');
    await user.click(screen.getByRole('button', { name: /recall/i }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('Memory does not hold the answer.');
    expect(notice).toHaveTextContent('No turn mentions quill.');
    expect(screen.getByText('Maya owns billing on Heron.')).toBeInTheDocument();
  });
});
