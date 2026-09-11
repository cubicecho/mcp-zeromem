import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import { renderPage } from '@/test-support';
import { ComparePage } from '../compare';
import { status, T0 } from './fixtures';

describe('ComparePage', () => {
  it('runs the query on both sides and diffs the evidence sets', async () => {
    vi.spyOn(api, 'getStatus').mockResolvedValue(status);
    const turn = (id: number, text: string) => ({
      id,
      uuid: `u${id}`,
      session_id: 'alpha',
      speaker: 'user',
      text,
      ts: T0,
    });
    const evidence = (id: number, text: string, score: number) => ({
      turn: turn(id, text),
      score,
      confidence: 1,
      role: 'primary' as const,
    });
    vi.spyOn(api, 'recall').mockImplementation(async (body) => ({
      query: body.query,
      evidence:
        body.top_k === 5
          ? [evidence(1, 'Maya owns billing.', 0.9), evidence(2, 'Kenji owns search.', 0.5)]
          : [evidence(2, 'Kenji owns search.', 0.7), evidence(3, 'Heron ships in May.', 0.4)],
      considered: 3,
      took_ms: 1,
    }));
    renderPage(<ComparePage />, '/compare');

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Query'), 'who owns what?');
    await user.click(screen.getByRole('button', { name: 'Run both' }));

    expect(await screen.findByText('only A')).toBeInTheDocument();
    expect(screen.getByText('only B')).toBeInTheDocument();
    expect(screen.getByText('up 1')).toBeInTheDocument();
  });
});
