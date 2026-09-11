import { curatorSettingsSchema, curatorTokenResponseSchema } from '@mcp-zeromem/shared';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { tempEngine, testConfig } from '../../test-support.ts';

const auth = { Authorization: 'Bearer test-token' };
const CURATOR_TOKEN = 'curator-token-0123456789';

let rig: ReturnType<typeof tempEngine>;

beforeEach(() => {
  rig = tempEngine();
});

afterEach(() => {
  rig.cleanup();
});

function app(overrides: Parameters<typeof testConfig>[0] = {}) {
  return buildApp({
    engine: rig.engine,
    config: testConfig({ dataDir: rig.home, ...overrides }),
    appDistDir: '/nonexistent',
  });
}

/** tools/list over /mcp with a bearer token; the names, or the status when refused. */
async function toolNames(server: Express, token: string): Promise<string[] | number> {
  const res = await request(server)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  if (res.status !== 200) {
    return res.status;
  }
  return (res.body.result.tools as Array<{ name: string }>).map((t) => t.name);
}

const hasCurator = (names: string[] | number) => Array.isArray(names) && names.includes('zeromem_curate_apply');

const limits = { max_per_call: 100, max_per_run: 300, min_age_ms: 86_400_000, expose_to_all: false };

describe('/api/settings/curator', () => {
  it('reports the defaults and never the token', async () => {
    const server = app();
    expect((await request(server).get('/api/settings/curator')).status).toBe(401);
    const res = await request(server).get('/api/settings/curator').set(auth);
    expect(curatorSettingsSchema.parse(res.body)).toEqual({
      ...limits,
      token_set: false,
      token_source: 'none',
      last_run_at: null,
      cursor: 0,
    });

    const put = await request(server)
      .put('/api/settings/curator')
      .set(auth)
      .send({ ...limits, token: CURATOR_TOKEN });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ token_set: true, token_source: 'store' });
    expect(JSON.stringify(put.body)).not.toContain(CURATOR_TOKEN);
  });

  it('scopes /mcp by token: the curator token adds the curator tools and opens nothing under /api', async () => {
    const server = app();
    expect(hasCurator(await toolNames(server, 'test-token'))).toBe(false);
    expect(await toolNames(server, CURATOR_TOKEN)).toBe(401);

    await request(server)
      .put('/api/settings/curator')
      .set(auth)
      .send({ ...limits, token: CURATOR_TOKEN });
    expect(hasCurator(await toolNames(server, CURATOR_TOKEN))).toBe(true);
    expect(hasCurator(await toolNames(server, 'test-token'))).toBe(false);
    expect((await request(server).get('/api/sessions').set('Authorization', `Bearer ${CURATOR_TOKEN}`)).status).toBe(
      401,
    );

    // Keeping the token while changing the limits: an omitted token is kept.
    await request(server)
      .put('/api/settings/curator')
      .set(auth)
      .send({ ...limits, expose_to_all: true });
    expect(hasCurator(await toolNames(server, 'test-token'))).toBe(true);
    expect(hasCurator(await toolNames(server, CURATOR_TOKEN))).toBe(true);

    // null clears it.
    await request(server)
      .put('/api/settings/curator')
      .set(auth)
      .send({ ...limits, token: null });
    expect(await toolNames(server, CURATOR_TOKEN)).toBe(401);
  });

  it('generates a token that replaces the previous one', async () => {
    const server = app();
    await request(server)
      .put('/api/settings/curator')
      .set(auth)
      .send({ ...limits, token: CURATOR_TOKEN });
    const res = await request(server).post('/api/settings/curator/token').set(auth);
    expect(res.status).toBe(200);
    const { token, settings } = curatorTokenResponseSchema.parse(res.body);
    expect(token.length).toBeGreaterThanOrEqual(16);
    expect(settings).toMatchObject({ token_set: true, token_source: 'store' });
    expect(hasCurator(await toolNames(server, token))).toBe(true);
    expect(await toolNames(server, CURATOR_TOKEN)).toBe(401);
  });

  it('lets MCP_ZEROMEM_CURATOR_TOKEN override the stored token', async () => {
    const envToken = 'env-curator-token-abcdefgh';
    const server = app({ curatorToken: envToken });
    const res = await request(server).get('/api/settings/curator').set(auth);
    expect(res.body).toMatchObject({ token_set: true, token_source: 'env' });
    expect((await request(server).post('/api/settings/curator/token').set(auth)).status).toBe(409);
    expect(
      (
        await request(server)
          .put('/api/settings/curator')
          .set(auth)
          .send({ ...limits, token: CURATOR_TOKEN })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(server)
          .put('/api/settings/curator')
          .set(auth)
          .send({ ...limits, max_per_call: 10 })
      ).status,
    ).toBe(200);
    expect(hasCurator(await toolNames(server, envToken))).toBe(true);
  });

  it('refuses bad limits, and every change when read-only', async () => {
    const server = app();
    expect(
      (
        await request(server)
          .put('/api/settings/curator')
          .set(auth)
          .send({ ...limits, max_per_call: 0 })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(server)
          .put('/api/settings/curator')
          .set(auth)
          .send({ ...limits, token: 'short' })
      ).status,
    ).toBe(400);

    const readOnly = app({ readOnly: true });
    expect((await request(readOnly).put('/api/settings/curator').set(auth).send(limits)).status).toBe(403);
    expect((await request(readOnly).post('/api/settings/curator/token').set(auth)).status).toBe(403);
    expect((await request(readOnly).get('/api/settings/curator').set(auth)).status).toBe(200);
  });
});
