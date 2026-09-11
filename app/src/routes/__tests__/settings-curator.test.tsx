import type { CuratorSettings, EmbedderSettings } from '@mcp-zeromem/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import { renderPage } from '@/test-support';
import { SettingsPage } from '../settings';
import { status } from './fixtures';

const embedder: EmbedderSettings = {
  spec: { kind: 'hash' },
  embedder: 'hash-384',
  embedder_kind: 'hash',
  embedder_dim: 384,
  active: true,
  embedder_is_fallback: false,
  embedder_warning: null,
  embedding_backlog: 0,
  api_key_source: 'none',
  onnx_available: true,
};

const curator: CuratorSettings = {
  max_per_call: 100,
  max_per_run: 300,
  min_age_ms: 86_400_000,
  expose_to_all: false,
  token_set: false,
  token_source: 'none',
  last_run_at: null,
  cursor: 0,
};

function mockPage(settings: CuratorSettings) {
  vi.spyOn(api, 'getStatus').mockResolvedValue(status);
  vi.spyOn(api, 'getEmbedderSettings').mockResolvedValue(embedder);
  vi.spyOn(api, 'getCuratorSettings').mockResolvedValue(settings);
}

describe('SettingsPage → Curator', () => {
  it('generates a token and shows it once', async () => {
    mockPage(curator);
    const generate = vi.spyOn(api, 'generateCuratorToken').mockResolvedValue({
      token: 'tok_abcdefghijklmnopqrstuvwx',
      settings: { ...curator, token_set: true, token_source: 'store' },
    });
    renderPage(<SettingsPage />, '/settings');
    const user = userEvent.setup();

    expect(await screen.findByText('not set')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Generate a token' }));
    expect(generate).toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByLabelText('Curator token')).toHaveValue('tok_abcdefghijklmnopqrstuvwx');
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('button', { name: 'Generate a new token' })).toBeInTheDocument();
  });

  it('saves the limits and the exposure switch', async () => {
    mockPage(curator);
    const update = vi
      .spyOn(api, 'updateCuratorSettings')
      .mockResolvedValue({ ...curator, max_per_call: 50, min_age_ms: 3_600_000, expose_to_all: true });
    renderPage(<SettingsPage />, '/settings');
    const user = userEvent.setup();

    const perCall = await screen.findByLabelText('Actions per call');
    await user.clear(perCall);
    await user.type(perCall, '50');
    const minAge = screen.getByLabelText('Minimum turn age (hours)');
    await user.clear(minAge);
    await user.type(minAge, '1');
    await user.click(screen.getByRole('switch', { name: 'Serve the curator tools to every client' }));
    expect(screen.getByText(/Every agent will see five more tools/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith({
      max_per_call: 50,
      max_per_run: 300,
      min_age_ms: 3_600_000,
      expose_to_all: true,
    });
  });

  it('points at the environment when it sets the token', async () => {
    mockPage({ ...curator, token_set: true, token_source: 'env', last_run_at: Date.now() - 60_000, cursor: 12 });
    renderPage(<SettingsPage />, '/settings');

    expect(await screen.findByText('set by MCP_ZEROMEM_CURATOR_TOKEN')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Last run ended/)).toBeInTheDocument();
    expect(screen.getByText('#12')).toBeInTheDocument();
  });
});
