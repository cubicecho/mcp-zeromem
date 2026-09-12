import type { ServerStatus } from '@mcp-zeromem/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import { renderPage } from '@/test-support';
import { SessionsPage } from '../sessions';

const status: ServerStatus = {
  name: 'mcp-zeromem',
  version: '0',
  uptimeSeconds: 1,
  authEnabled: false,
  readOnly: false,
  engine: {
    home: '/data',
    turns: 3,
    sessions: 1,
    entities: 0,
    edges: 0,
    windows: 0,
    episodes: 0,
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

describe('SessionsPage', () => {
  it('lists sessions, shows a session on click, and forgets after confirming', async () => {
    vi.spyOn(api, 'getStatus').mockResolvedValue(status);
    vi.spyOn(api, 'listSessions').mockResolvedValue({
      sessions: [{ session_id: 'alpha', turns: 3, first_ts: 1_700_000_000_000, last_ts: 1_700_000_100_000 }],
    });
    vi.spyOn(api, 'getSessionTurns').mockResolvedValue({
      session_id: 'alpha',
      turns: [{ id: 1, uuid: 'u1', session_id: 'alpha', speaker: 'user', text: 'first words', ts: 1_700_000_000_000 }],
    });
    const forget = vi.spyOn(api, 'forgetSession').mockResolvedValue({ session_id: 'alpha', removed: 3 });
    renderPage(<SessionsPage />, '/sessions');

    const user = userEvent.setup();
    await user.click(await screen.findByText('alpha'));
    expect(await screen.findByText('first words')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Forget session alpha' }));
    await user.click(await screen.findByRole('button', { name: 'Forget' }));
    expect(forget).toHaveBeenCalledWith('alpha');
  });
});
