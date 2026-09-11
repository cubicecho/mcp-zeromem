import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import { renderPage } from '@/test-support';
import { TimelineExplorer } from '../timeline';
import { T0 } from './fixtures';

describe('TimelineExplorer', () => {
  it('draws one lane per session and lists them in the table twin', async () => {
    const segment = (start: number, end: number, first: number, last: number) => ({
      start_ts: start,
      end_ts: end,
      first_turn_id: first,
      last_turn_id: last,
      turns: last - first + 1,
      entities: ['maya okafor'],
    });
    vi.spyOn(api, 'getHierarchy').mockResolvedValue({
      sessions: [
        {
          session_id: 'alpha',
          turns: 4,
          first_ts: T0,
          last_ts: T0 + 600_000,
          windows: [segment(T0, T0 + 600_000, 1, 4)],
          episodes: [segment(T0, T0 + 200_000, 1, 2), segment(T0 + 300_000, T0 + 600_000, 3, 4)],
        },
        {
          session_id: 'beta',
          turns: 1,
          first_ts: T0 + 100_000,
          last_ts: T0 + 100_000,
          windows: [segment(T0 + 100_000, T0 + 100_000, 5, 5)],
          episodes: [segment(T0 + 100_000, T0 + 100_000, 5, 5)],
        },
      ],
      total_sessions: 2,
      generation: 1,
    });
    renderPage(<TimelineExplorer options={{}} onChange={vi.fn()} />, '/timeline');

    expect(await screen.findByText('Sessions, windows, episodes')).toBeInTheDocument();
    expect(screen.getByText('Window')).toBeInTheDocument();
    expect(screen.getByText('Episode')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /table/i }));
    expect(await screen.findByRole('cell', { name: 'alpha' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'beta' })).toBeInTheDocument();
  });
});
