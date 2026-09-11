import type { EmbedderSettings } from '@mcp-zeromem/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import { renderPage } from '@/test-support';
import { SettingsPage } from '../settings';
import { status } from './fixtures';

const hashSettings: EmbedderSettings = {
  spec: { kind: 'hash' },
  embedder: 'hash-384',
  embedder_kind: 'hash',
  embedder_dim: 384,
  active: true,
  embedder_is_fallback: true,
  embedder_warning: 'no model',
  embedding_backlog: 0,
  api_key_source: 'none',
  onnx_available: true,
};

describe('SettingsPage', () => {
  it('shows the current embedder, tests a candidate and confirms a switch', async () => {
    vi.spyOn(api, 'getStatus').mockResolvedValue(status);
    vi.spyOn(api, 'getEmbedderSettings').mockResolvedValue(hashSettings);
    const test = vi.spyOn(api, 'testEmbedder').mockResolvedValue({
      embedder: 'openai:nomic-embed-text@768',
      embedder_kind: 'openai',
      embedder_dim: 768,
      latency_ms: 42,
    });
    const set = vi.spyOn(api, 'setEmbedder').mockResolvedValue({
      embedder: 'openai:nomic-embed-text@768',
      embedder_dim: 768,
      turns_to_embed: 3,
      vectors_kept: false,
    });
    renderPage(<SettingsPage />, '/settings');
    const user = userEvent.setup();

    // The name shows in the current line and in the re-embed offer.
    expect(await screen.findAllByText('hash-384')).toHaveLength(2);
    expect(screen.getByText('no model')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Kind' }));
    await user.click(await screen.findByRole('option', { name: 'OpenAI-compatible endpoint' }));
    await user.type(screen.getByLabelText('Base URL'), 'http://npu:8080/v1');
    await user.type(screen.getByLabelText('Model'), 'nomic-embed-text');
    await user.type(screen.getByLabelText('API key'), 'sk-test');

    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('openai:nomic-embed-text@768')).toBeInTheDocument();
    expect(screen.getByText(/768 dims · 42 ms/)).toBeInTheDocument();
    expect(test).toHaveBeenCalledWith({
      spec: {
        kind: 'openai',
        url: 'http://npu:8080/v1',
        model: 'nomic-embed-text',
        api_key: 'sk-test',
        query_prefix: '',
        document_prefix: '',
        timeout_ms: 5000,
        max_chars: 8000,
      },
      keep_stored_key: false,
    });

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/drops 3 vectors and re-embeds 3 turns with nomic-embed-text/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Switch' }));
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ keep_stored_key: false }));
  });

  it('shows a failed test inline and the re-embedding progress', async () => {
    vi.spyOn(api, 'getStatus').mockResolvedValue({
      ...status,
      engine: { ...status.engine, turns: 10, embedding_backlog: 4 },
    });
    vi.spyOn(api, 'getEmbedderSettings').mockResolvedValue({
      ...hashSettings,
      spec: {
        kind: 'openai',
        url: 'http://npu:8080/v1',
        model: 'nomic-embed-text',
        query_prefix: '',
        document_prefix: '',
        timeout_ms: 5000,
        max_chars: 8000,
      },
      embedder: 'openai:nomic-embed-text@768',
      embedder_kind: 'openai',
      embedder_dim: 768,
      embedder_is_fallback: false,
      embedder_warning: null,
      embedding_backlog: 4,
      api_key_source: 'env',
    });
    vi.spyOn(api, 'testEmbedder').mockRejectedValue(
      new api.ApiRequestError(502, 'The embedder could not be used', 'connection refused'),
    );
    renderPage(<SettingsPage />, '/settings');
    const user = userEvent.setup();

    expect(await screen.findByText(/Re-embedding · 6 of 10 turns/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60');
    expect(screen.getByText(/ZEROMEM_EMBEDDING_API_KEY is in use/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('connection refused');
  });

  it('hides the form under read-only', async () => {
    vi.spyOn(api, 'getStatus').mockResolvedValue({ ...status, readOnly: true });
    vi.spyOn(api, 'getEmbedderSettings').mockResolvedValue(hashSettings);
    renderPage(<SettingsPage />, '/settings');
    expect(await screen.findByText(/embedder cannot be changed from here/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('re-embeds with the store embedder after confirming', async () => {
    vi.spyOn(api, 'getStatus').mockResolvedValue(status);
    vi.spyOn(api, 'getEmbedderSettings').mockResolvedValue(hashSettings);
    const reembed = vi.spyOn(api, 'reembed').mockResolvedValue({
      embedder: 'hash-384',
      embedder_dim: 384,
      turns_to_embed: 3,
      vectors_kept: false,
    });
    renderPage(<SettingsPage />, '/settings');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Re-embed all turns' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Re-embed every turn with hash-384?')).toBeInTheDocument();
    expect(within(dialog).getByText(/drops 3 vectors and re-embeds 3 turns/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Re-embed' }));
    expect(reembed).toHaveBeenCalledOnce();
  });

  it('clears the vectors, and clears the memory only once the word is typed', async () => {
    vi.spyOn(api, 'getStatus').mockResolvedValue(status);
    vi.spyOn(api, 'getEmbedderSettings').mockResolvedValue(hashSettings);
    const clear = vi
      .spyOn(api, 'clearStore')
      .mockResolvedValue({ turns_removed: 3, sessions_removed: 2, vectors_removed: 3, turns_to_embed: 0 });
    renderPage(<SettingsPage />, '/settings');
    const user = userEvent.setup();

    expect(await screen.findByText(/3 turns in 2 sessions/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear vectors' }));
    let dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Clear vectors' }));
    expect(clear).toHaveBeenLastCalledWith('embeddings');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Clear all memory' }));
    dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/deletes 3 turns from 2 sessions/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Clear memory' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), 'clear');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(clear).toHaveBeenLastCalledWith('memory');
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it('offers no re-embed or clear under read-only', async () => {
    vi.spyOn(api, 'getStatus').mockResolvedValue({ ...status, readOnly: true });
    vi.spyOn(api, 'getEmbedderSettings').mockResolvedValue(hashSettings);
    renderPage(<SettingsPage />, '/settings');
    expect(await screen.findByText(/nothing can be cleared from here/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-embed all turns' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear all memory' })).not.toBeInTheDocument();
  });
});
