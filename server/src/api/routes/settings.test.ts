import { embedderProbeSchema, embedderSettingsSchema, embedderSwitchSchema } from '@mcp-zeromem/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { EmbedWorker } from '../../engine/embed-worker.ts';
import { type MockEmbeddingsServer, mockEmbeddingsServer, tempEngine, testConfig } from '../../test-support.ts';

const auth = { Authorization: 'Bearer test-token' };

let rig: ReturnType<typeof tempEngine>;
let endpoint: MockEmbeddingsServer;

beforeEach(async () => {
  rig = tempEngine();
  endpoint = await mockEmbeddingsServer();
});

afterEach(async () => {
  await endpoint.close();
  rig.cleanup();
});

function app(overrides: Parameters<typeof testConfig>[0] = {}, worker?: EmbedWorker) {
  return buildApp({
    engine: rig.engine,
    config: testConfig({ dataDir: rig.home, ...overrides }),
    worker,
    appDistDir: '/nonexistent',
  });
}

const remote = (url: string) => ({ kind: 'openai', url, model: 'mock-embed', api_key: 'sk-secret' });

describe('/api/settings/embedder', () => {
  it('reports the store embedder behind the token, never the key', async () => {
    expect((await request(app()).get('/api/settings/embedder')).status).toBe(401);
    const res = await request(app()).get('/api/settings/embedder').set(auth);
    expect(res.status).toBe(200);
    const settings = embedderSettingsSchema.parse(res.body);
    expect(settings).toMatchObject({
      spec: { kind: 'hash' },
      embedder: 'hash-384',
      embedder_kind: 'hash',
      embedder_dim: 384,
      active: true,
      embedder_is_fallback: true,
      embedding_backlog: 0,
      api_key_source: 'none',
    });
  });

  it('tests a candidate without touching the store, and answers 502 when it fails', async () => {
    const ok = await request(app())
      .post('/api/settings/embedder/test')
      .set(auth)
      .send({ spec: remote(endpoint.url) });
    expect(ok.status).toBe(200);
    expect(embedderProbeSchema.parse(ok.body)).toMatchObject({
      embedder: 'openai:mock-embed@8',
      embedder_kind: 'openai',
      embedder_dim: 8,
    });
    expect(endpoint.requests[0]?.authorization).toBe('Bearer sk-secret');

    const dead = await request(app())
      .post('/api/settings/embedder/test')
      .set(auth)
      .send({ spec: remote('http://127.0.0.1:9/v1') });
    expect(dead.status).toBe(502);
    expect(String(dead.body.detail)).toMatch(/127\.0\.0\.1:9/);
    expect(String(dead.body.detail)).not.toMatch(/sk-secret/);

    const invalid = await request(app())
      .post('/api/settings/embedder/test')
      .set(auth)
      .send({ spec: { kind: 'laser' } });
    expect(invalid.status).toBe(400);

    const after = await request(app()).get('/api/settings/embedder').set(auth);
    expect(after.body.embedder).toBe('hash-384');
  });

  it('switches the store, drops the vectors and lets the worker re-embed them', async () => {
    await rig.engine.ingestMany(
      Array.from({ length: 5 }, (_, i) => ({
        session_id: 's1',
        speaker: 'user',
        text: `turn number ${i} about Lisbon`,
        ts: i + 1,
      })),
    );
    expect((await rig.engine.stats()).embeddings).toBe(5);

    const worker = new EmbedWorker(rig.engine, { batch: 2, log: () => {} });
    const switched = await request(app({}, worker))
      .put('/api/settings/embedder')
      .set(auth)
      .send({ spec: remote(endpoint.url) });
    expect(switched.status).toBe(200);
    const report = embedderSwitchSchema.parse(switched.body);
    // The engine embeds one batch on its own refresh; the rest is the worker's.
    expect(report).toMatchObject({ embedder: 'openai:mock-embed@8', embedder_dim: 8, vectors_kept: false });

    worker.start();
    await worker.drained();
    await worker.stop();
    const stats = await rig.engine.stats();
    expect(stats).toMatchObject({
      embeddings: 5,
      embedding_backlog: 0,
      embedder: 'openai:mock-embed@8',
      embedder_dim: 8,
    });

    const settings = embedderSettingsSchema.parse((await request(app()).get('/api/settings/embedder').set(auth)).body);
    expect(settings.api_key_source).toBe('store');
    expect(JSON.stringify(settings)).not.toMatch(/sk-secret/);

    // Re-applying the same model with a new timeout keeps the vectors and, with
    // keep_stored_key, the key.
    const edited = await request(app())
      .put('/api/settings/embedder')
      .set(auth)
      .send({
        spec: { kind: 'openai', url: endpoint.url, model: 'mock-embed', timeout_ms: 900 },
        keep_stored_key: true,
      });
    expect(embedderSwitchSchema.parse(edited.body)).toMatchObject({ vectors_kept: true, turns_to_embed: 0 });
    expect(endpoint.requests.at(-1)?.authorization).toBe('Bearer sk-secret');

    const recalled = await request(app()).post('/api/recall/trace').set(auth).send({ query: 'Lisbon' });
    expect(
      recalled.body.views.some(
        (v: { view: string; candidates: unknown[] }) => v.view === 'dense' && v.candidates.length > 0,
      ),
    ).toBe(true);
  });

  it('leaves the store alone when the new endpoint fails, and refuses under read-only', async () => {
    const dead = await request(app())
      .put('/api/settings/embedder')
      .set(auth)
      .send({ spec: remote('http://127.0.0.1:9/v1') });
    expect(dead.status).toBe(502);
    expect((await rig.engine.stats()).embedder).toBe('hash-384');

    const readOnly = await request(app({ readOnly: true }))
      .put('/api/settings/embedder')
      .set(auth)
      .send({ spec: { kind: 'hash' } });
    expect(readOnly.status).toBe(403);
  });
});
