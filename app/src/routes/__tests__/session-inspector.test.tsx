import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import { renderPage } from '@/test-support';
import { SessionInspector } from '../sessions_.$sessionId';
import { turns } from './fixtures';

describe('SessionInspector', () => {
  it('renders the turns with entity spans and counts the entities in the aside', async () => {
    const get = vi.spyOn(api, 'getSessionTurnsWithEntities').mockResolvedValue({ session_id: 'alpha', turns });
    renderPage(<SessionInspector sessionId="alpha" />, '/sessions/alpha');

    expect(await screen.findByRole('heading', { name: 'alpha' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('alpha', expect.objectContaining({ limit: 1000 }));
    expect(await screen.findByText('Entities in this session')).toBeInTheDocument();

    // The mention is a clickable span carrying its entity key.
    const mention = screen.getByRole('button', { name: 'Maya Okafor' });
    expect(mention).toHaveAttribute('data-entity', 'maya okafor');
    expect(screen.getByText(/owns billing\./)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /maya okafor/i, pressed: false }));
    expect(screen.getByRole('button', { name: /maya okafor/i, pressed: true })).toBeInTheDocument();
  });
});
