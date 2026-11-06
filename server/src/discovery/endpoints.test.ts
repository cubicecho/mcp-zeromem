import { cardConnection, parseAiCatalog, parseServerCard } from '@cubicecho/mcp-discovery';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { tempEngine, testConfig } from '../test-support.ts';
import { discoveryEndpoints } from './endpoints.ts';

let rig: ReturnType<typeof tempEngine>;

beforeEach(() => {
  rig = tempEngine();
});

afterEach(() => {
  rig.cleanup();
});

/**
 * Builds the full app, auth guards included, over the test's store.
 *
 * @param [overrides] - Config fields the test is about.
 * @returns The app, ready for supertest.
 */
function app(overrides: Parameters<typeof testConfig>[0] = {}) {
  return buildApp({
    engine: rig.engine,
    config: testConfig({ dataDir: rig.home, ...overrides }),
    appDistDir: '/nonexistent',
  });
}

describe('discovery documents', () => {
  it('serves the catalog without a token while /mcp still asks for one', async () => {
    const server = app();
    const catalog = await request(server).get('/.well-known/ai-catalog.json');
    expect(catalog.status).toBe(200);
    expect(catalog.headers['content-type']).toContain('application/ai-catalog+json');
    expect((await request(server).post('/mcp').send({})).status).toBe(401);
  });

  it('lists /mcp with a card on the address the client used', async () => {
    const server = app();
    const catalog = parseAiCatalog((await request(server).get('/.well-known/ai-catalog.json')).body, 'test');
    expect(catalog.entries.map((entry) => new URL(entry.url ?? '').pathname)).toEqual(['/mcp/server-card']);

    const response = await request(server).get('/mcp/server-card').set('Host', 'nas.local:3200');
    expect(response.status).toBe(200);
    const card = parseServerCard(response.body, 'test');
    expect(card.repository?.url).toBe('https://github.com/cubicecho/mcp-zeromem');
    expect(cardConnection(card)).toEqual({ url: 'http://nas.local:3200/mcp', requiredHeaders: ['Authorization'] });
    expect(JSON.stringify(card)).not.toContain('test-token');
  });

  it('asks for no token when auth is off', async () => {
    const card = parseServerCard((await request(app({ authToken: null })).get('/mcp/server-card')).body, 'test');
    expect(cardConnection(card)?.requiredHeaders).toEqual([]);
  });

  it('leaves every other /mcp path behind the guard', async () => {
    expect((await request(app()).get('/mcp/w/team/server-card')).status).toBe(401);
  });

  it('names the card after the host, so two servers on one network stay apart', () => {
    const [root] = discoveryEndpoints({ isAuthRequired: true, host: 'NAS.lan' });
    expect(root?.identifier).toBe('urn:air:nas.zeromem:mcp:memory');
  });
});
