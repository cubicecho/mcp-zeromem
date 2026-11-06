import type { DiscoverySettings, EmbedderSettings, ServerStatus } from '@mcp-zeromem/shared';
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

const off: DiscoverySettings = { lan_advertise: false, loopback_only: false };

/**
 * Answers the Settings page's reads.
 *
 * @param discovery - What the discovery settings say.
 * @param [serverStatus] - The status, for a read-only server.
 */
function mockPage(discovery: DiscoverySettings, serverStatus: ServerStatus = status) {
  vi.spyOn(api, 'getStatus').mockResolvedValue(serverStatus);
  vi.spyOn(api, 'getEmbedderSettings').mockResolvedValue(embedder);
  vi.spyOn(api, 'getDiscoverySettings').mockResolvedValue(discovery);
}

describe('SettingsPage → Network discovery', () => {
  it('is off by default and saves the switch when it is turned on', async () => {
    mockPage(off);
    const update = vi.spyOn(api, 'updateDiscoverySettings').mockResolvedValue({ ...off, lan_advertise: true });
    renderPage(<SettingsPage />, '/settings');
    const user = userEvent.setup();

    const card = within(await screen.findByRole('form', { name: 'Network discovery' }));
    const toggle = card.getByRole('switch', { name: 'Advertise on the local network' });
    const save = card.getByRole('button', { name: 'Save' });
    expect(toggle).not.toBeChecked();
    expect(card.getByText(/Anything on this network can then see/)).toBeInTheDocument();
    expect(save).toBeDisabled();

    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(save).toBeEnabled();
    await user.click(save);
    expect(update).toHaveBeenCalledWith({ lan_advertise: true });
  });

  it('says why a server on a loopback address is never announced', async () => {
    mockPage({ lan_advertise: true, loopback_only: true });
    renderPage(<SettingsPage />, '/settings');

    expect(await screen.findByRole('switch', { name: 'Advertise on the local network' })).toBeChecked();
    expect(screen.getByText(/listens on a loopback address \(HOST\)/)).toBeInTheDocument();
  });

  it('cannot be changed on a read-only server', async () => {
    mockPage(off, { ...status, readOnly: true });
    renderPage(<SettingsPage />, '/settings');

    expect(await screen.findByRole('switch', { name: 'Advertise on the local network' })).toBeDisabled();
    expect(screen.getByText(/so network discovery cannot be changed from here/)).toBeInTheDocument();
  });
});
