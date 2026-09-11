import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import { renderPage } from '@/test-support';
import { EmbeddingMap } from '../embeddings';
import { status, T0 } from './fixtures';

describe('EmbeddingMap', () => {
  it('warns about the fallback embedder, lists the points, and submits a query to place', async () => {
    vi.spyOn(api, 'getStatus').mockResolvedValue(status);
    vi.spyOn(api, 'listSessions').mockResolvedValue({
      sessions: [{ session_id: 'alpha', turns: 2, first_ts: T0, last_ts: T0 }],
    });
    vi.spyOn(api, 'getProjection').mockResolvedValue({
      points: [
        { turn_id: 1, session_id: 'alpha', speaker: 'user', ts: T0, text: 'Maya owns billing.', x: 0.1, y: 0.2 },
        { turn_id: 2, session_id: 'alpha', speaker: 'assistant', ts: T0, text: 'Noted.', x: -0.3, y: 0.4 },
      ],
      basis: { mean: [], axes: [[], []], variance_explained: [0.41, 0.2] },
      query: null,
      embedder: 'hash-384',
      total: 2,
      generation: 0,
    });
    const onChange = vi.fn();
    renderPage(<EmbeddingMap options={{}} onChange={onChange} />, '/embeddings');

    expect(await screen.findByText('Turns on the projection plane')).toBeInTheDocument();
    expect(screen.getByText(/hash-384/)).toBeInTheDocument();
    expect(screen.getByText(/41%/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/fallback/i);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /table/i }));
    expect(await screen.findByText('Maya owns billing.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Drop a query onto the map'), 'billing owner');
    await user.click(screen.getByRole('button', { name: 'Place' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ query: 'billing owner' }));
  });
});
