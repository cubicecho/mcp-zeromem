import {
  forgetResponseSchema,
  recallResponseSchema,
  serverStatusSchema,
  sessionsResponseSchema,
} from '@mcp-zeromem/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { tempEngine, testConfig } from './test-support.ts';

let rig: ReturnType<typeof tempEngine>;

beforeEach(() => {
  rig = tempEngine();
});

afterEach(() => {
  rig.cleanup();
});

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

describe('buildApp', () => {
  it('serves /api/status without a token', async () => {
    const app = buildApp({ engine: rig.engine, config: testConfig({ dataDir: rig.home }), appDistDir: '/nonexistent' });
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    const status = serverStatusSchema.parse(res.body);
    expect(status.authEnabled).toBe(true);
    expect(status.engine).toMatchObject({ home: rig.home, turns: 0, sessions: 0 });
  });

  it('guards /mcp with the bearer token', async () => {
    const app = buildApp({ engine: rig.engine, config: testConfig({ dataDir: rig.home }), appDistDir: '/nonexistent' });
    const denied = await request(app).post('/mcp').send(initialize);
    expect(denied.status).toBe(401);

    const allowed = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer test-token')
      .set('Accept', 'application/json, text/event-stream')
      .send(initialize);
    expect(allowed.status).toBe(200);
    expect(allowed.body.result.serverInfo.name).toBe('mcp-zeromem');
  });

  it('serves the REST routes the UI needs, behind the token', async () => {
    const app = buildApp({ engine: rig.engine, config: testConfig({ dataDir: rig.home }), appDistDir: '/nonexistent' });
    const auth = { Authorization: 'Bearer test-token' };
    expect((await request(app).get('/api/sessions')).status).toBe(401);

    const ingested = await request(app)
      .post('/api/ingest')
      .set(auth)
      .send({ turns: [{ session_id: 's1', speaker: 'user', text: 'Priya Raghunathan is based in Lisbon.', ts: 5 }] });
    expect(ingested.status).toBe(200);
    expect(ingested.body).toEqual({ indexed: 1, duplicates: 0, rejected: 0 });

    const sessions = await request(app).get('/api/sessions').set(auth);
    expect(sessionsResponseSchema.parse(sessions.body).sessions).toEqual([
      { session_id: 's1', turns: 1, first_ts: 5, last_ts: 5 },
    ]);
    const turns = await request(app).get('/api/sessions/s1/turns').set(auth);
    expect(turns.body.turns[0].text).toMatch(/Lisbon/);
    expect((await request(app).get('/api/sessions/nope/turns').set(auth)).status).toBe(404);

    const recalled = await request(app).post('/api/recall').set(auth).send({ query: 'where is Priya based?' });
    expect(recallResponseSchema.parse(recalled.body).evidence[0]?.turn.session_id).toBe('s1');
    const traced = await request(app).post('/api/recall/trace').set(auth).send({ query: 'where is Priya based?' });
    expect(traced.body.views.length).toBeGreaterThan(0);
    expect((await request(app).post('/api/recall').set(auth).send({ query: '' })).status).toBe(400);

    const forgotten = await request(app).delete('/api/sessions/s1').set(auth);
    expect(forgetResponseSchema.parse(forgotten.body)).toEqual({ session_id: 's1', removed: 1 });
    expect((await request(app).delete('/api/sessions/s1').set(auth)).status).toBe(404);
  });

  it('refuses the REST writes when read-only', async () => {
    const app = buildApp({
      engine: rig.engine,
      config: testConfig({ dataDir: rig.home, readOnly: true }),
      appDistDir: '/nonexistent',
    });
    const auth = { Authorization: 'Bearer test-token' };
    const ingested = await request(app)
      .post('/api/ingest')
      .set(auth)
      .send({ turns: [{ session_id: 's1', speaker: 'user', text: 'x' }] });
    expect(ingested.status).toBe(403);
    expect((await request(app).delete('/api/sessions/s1').set(auth)).status).toBe(403);
  });

  it('leaves /mcp open when auth is disabled', async () => {
    const app = buildApp({
      engine: rig.engine,
      config: testConfig({ dataDir: rig.home, authToken: null }),
      appDistDir: '/nonexistent',
    });
    const res = await request(app).post('/mcp').set('Accept', 'application/json, text/event-stream').send(initialize);
    expect(res.status).toBe(200);
  });
});
