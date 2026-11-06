import { discoverySettingsSchema } from '@mcp-zeromem/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.ts';
import { DiscoverySettingsStore, isLoopbackHost } from '../../discovery/settings.ts';
import { tempEngine, testConfig } from '../../test-support.ts';

const auth = { Authorization: 'Bearer test-token' };

let rig: ReturnType<typeof tempEngine>;

beforeEach(() => {
  rig = tempEngine();
});

afterEach(() => {
  rig.cleanup();
});

/**
 * Builds the full app over the test's store.
 *
 * @param [options] - Config fields, and the discovery store when the test watches it.
 * @param options.config - Config fields the test is about.
 * @param options.discoverySettings - The store the app writes through.
 * @returns The app, ready for supertest.
 */
function app(options: { config?: Parameters<typeof testConfig>[0]; discoverySettings?: DiscoverySettingsStore } = {}) {
  return buildApp({
    engine: rig.engine,
    config: testConfig({ dataDir: rig.home, ...options.config }),
    appDistDir: '/nonexistent',
    discoverySettings: options.discoverySettings,
  });
}

describe('/api/settings/discovery', () => {
  it('is off by default and asks for the token', async () => {
    const server = app();
    expect((await request(server).get('/api/settings/discovery')).status).toBe(401);
    const res = await request(server).get('/api/settings/discovery').set(auth);
    expect(discoverySettingsSchema.parse(res.body)).toEqual({ lan_advertise: false, loopback_only: false });
  });

  it('stores the switch in the store and tells the advertiser', async () => {
    const onChange = vi.fn();
    const discoverySettings = new DiscoverySettingsStore(rig.engine, { listenHost: null, onChange });
    const server = app({ discoverySettings });

    const put = await request(server).put('/api/settings/discovery').set(auth).send({ lan_advertise: true });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ lan_advertise: true, loopback_only: false });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(discoverySettings.isAdvertiseWanted).toBe(true);
    expect(await rig.engine.discoveryConfig()).toEqual({ lan_advertise: true });
  });

  it('refuses a body that is not the whole settings object', async () => {
    const res = await request(app()).put('/api/settings/discovery').set(auth).send({ lanAdvertise: true });
    expect(res.status).toBe(400);
  });

  it('refuses a change on a read-only server', async () => {
    const res = await request(app({ config: { readOnly: true } }))
      .put('/api/settings/discovery')
      .set(auth)
      .send({ lan_advertise: true });
    expect(res.status).toBe(403);
    expect(await rig.engine.discoveryConfig()).toEqual({ lan_advertise: false });
  });

  it('keeps the setting but never advertises from a loopback address', async () => {
    const discoverySettings = new DiscoverySettingsStore(rig.engine, { listenHost: '127.0.0.1' });
    const put = await request(app({ discoverySettings }))
      .put('/api/settings/discovery')
      .set(auth)
      .send({ lan_advertise: true });
    expect(put.body).toEqual({ lan_advertise: true, loopback_only: true });
    expect(discoverySettings.isAdvertiseRequested).toBe(true);
    expect(discoverySettings.isAdvertiseWanted).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it.each([
    ['localhost', true],
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['::1', true],
    ['[::1]', true],
    ['::ffff:127.0.0.1', true],
    ['0.0.0.0', false],
    ['::', false],
    ['192.168.1.20', false],
    ['nas.lan', false],
  ])('%s → %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});
