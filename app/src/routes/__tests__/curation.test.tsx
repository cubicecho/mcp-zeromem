import type { CurationActions, CurationRuns } from '@mcp-zeromem/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import { renderPage } from '@/test-support';
import { CurationPage } from '../curation';
import { status } from './fixtures';

const runs: CurationRuns = {
  runs: [
    {
      run_id: 'curate-2026-09-11T0300Z',
      actor: 'mcp-curator',
      started_at: 1_000,
      ended_at: 2_000,
      actions: 3,
      undone: 0,
      ops: { hide: 1, alias: 1, run_end: 1 },
      summary: 'Hid one repeat and merged Maya.',
      finished: true,
    },
  ],
  total: 1,
  cursor: 42,
  curation_seq: 3,
};

const actions: CurationActions = {
  actions: [
    {
      id: 7,
      run_id: 'curate-2026-09-11T0300Z',
      actor: 'mcp-curator',
      ts: 1_500,
      op: 'hide',
      payload: { turns: ['u2'] },
      reason: 'repeat of #1',
      undone_at: null,
      undone_by: null,
      targets: [{ uuid: 'u2', id: 2, session_id: 'alpha', text: 'Maya owns billing too.' }],
    },
    {
      id: 8,
      run_id: 'curate-2026-09-11T0300Z',
      actor: 'mcp-curator',
      ts: 1_600,
      op: 'alias',
      payload: { alias: 'maya', canonical: 'maya okafor' },
      reason: 'same person',
      undone_at: null,
      undone_by: null,
      targets: [],
    },
  ],
  total: 2,
};

describe('CurationPage', () => {
  it('lists runs, opens one and undoes an action', async () => {
    vi.spyOn(api, 'getStatus').mockResolvedValue(status);
    vi.spyOn(api, 'getCurationRuns').mockResolvedValue(runs);
    const getActions = vi.spyOn(api, 'getCurationActions').mockResolvedValue(actions);
    const undo = vi.spyOn(api, 'undoCuration').mockResolvedValue({ undone: [7] });
    renderPage(<CurationPage />, '/curation');
    const user = userEvent.setup();

    await user.click(await screen.findByText('curate-2026-09-11T0300Z'));
    expect(getActions).toHaveBeenCalledWith(expect.objectContaining({ run_id: 'curate-2026-09-11T0300Z' }));
    expect(await screen.findByText('repeat of #1')).toBeInTheDocument();
    expect(screen.getByText('Hid one repeat and merged Maya.')).toBeInTheDocument();
    expect(screen.getByText('alias “maya” → “maya okafor”')).toBeInTheDocument();
    expect(screen.getByText(/Maya owns billing too\./)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo action 7' }));
    expect(undo).toHaveBeenCalledWith({ action_id: 7 });
  });

  it('confirms before undoing a whole run', async () => {
    vi.spyOn(api, 'getStatus').mockResolvedValue(status);
    vi.spyOn(api, 'getCurationRuns').mockResolvedValue(runs);
    vi.spyOn(api, 'getCurationActions').mockResolvedValue(actions);
    const undo = vi.spyOn(api, 'undoCuration').mockResolvedValue({ undone: [8, 7] });
    renderPage(<CurationPage />, '/curation');
    const user = userEvent.setup();

    await user.click(await screen.findByText('curate-2026-09-11T0300Z'));
    await user.click(await screen.findByRole('button', { name: 'Undo run' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Undo 3 actions?');
    await user.click(screen.getAllByRole('button', { name: 'Undo run' }).at(-1) as HTMLElement);
    expect(undo).toHaveBeenCalledWith({ run_id: 'curate-2026-09-11T0300Z' });
  });

  it('lists the aliases and removes one by undoing its action', async () => {
    vi.spyOn(api, 'getStatus').mockResolvedValue(status);
    vi.spyOn(api, 'getCurationRuns').mockResolvedValue(runs);
    vi.spyOn(api, 'getCurationAliases').mockResolvedValue({
      aliases: [{ alias: 'maya', canonical: 'maya okafor', action_id: 8 }],
      blocklist: [{ entity: 'sure', action_id: 9 }],
    });
    const undo = vi.spyOn(api, 'undoCuration').mockResolvedValue({ undone: [8] });
    renderPage(<CurationPage />, '/curation');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Aliases and blocklist' }));
    expect(await screen.findByText('maya okafor')).toBeInTheDocument();
    expect(screen.getByText('sure')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove the alias maya' }));
    expect(undo).toHaveBeenCalledWith({ action_id: 8 });
  });

  it('explains how to start when there are no runs', async () => {
    vi.spyOn(api, 'getStatus').mockResolvedValue(status);
    vi.spyOn(api, 'getCurationRuns').mockResolvedValue({ runs: [], total: 0, cursor: 0, curation_seq: 0 });
    renderPage(<CurationPage />, '/curation');
    expect(await screen.findByText(/No curation runs yet/)).toBeInTheDocument();
  });
});
