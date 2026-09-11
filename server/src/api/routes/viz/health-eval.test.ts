import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evalHistorySchema, healthSchema } from '@mcp-zeromem/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.ts';
import { tempEngine, testConfig } from '../../../test-support.ts';
import { parseEvalHistory } from './eval.ts';

let rig: ReturnType<typeof tempEngine>;
let dir: string;
const auth = { Authorization: 'Bearer test-token' };

beforeEach(() => {
  rig = tempEngine();
  dir = mkdtempSync(path.join(tmpdir(), 'zeromem-eval-'));
});

afterEach(() => {
  rig.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/viz/health', () => {
  it('reports the recalls and ingests this process has served', async () => {
    const app = buildApp({ engine: rig.engine, config: testConfig({ dataDir: rig.home }), appDistDir: '/nonexistent' });
    await request(app)
      .post('/api/ingest')
      .set(auth)
      .send({ turns: [{ session_id: 's', speaker: 'user', text: 'Maya owns billing.', ts: 1 }] });
    await request(app).post('/api/recall').set(auth).send({ query: 'who owns billing' });
    await request(app).post('/api/recall/trace').set(auth).send({ query: 'who owns billing' });

    const res = await request(app).get('/api/viz/health').set(auth);
    expect(res.status).toBe(200);
    const health = healthSchema.parse(res.body);
    expect(health.recall.count).toBe(2);
    expect(health.recall.p50_ms).not.toBeNull();
    expect(health.ingest).toEqual({ calls: 1, turns: 1 });
    expect(health.open_ms).toBeGreaterThan(0);
    expect(health.series).toHaveLength(60);
    expect((health.series.at(-1)?.recalls ?? 0) + (health.series.at(-2)?.recalls ?? 0)).toBe(2);
  });
});

describe('GET /api/viz/eval', () => {
  it('serves the committed history and says where it came from', async () => {
    const file = path.join(dir, 'history.jsonl');
    writeFileSync(
      file,
      [
        '# a comment',
        JSON.stringify({
          recorded_at: '2026-09-01T00:00:00Z',
          commit: 'abc1234',
          profile: 'small',
          embedder: 'hash-384',
          k: 5,
          queries: 10,
          recall_at_k: 0.9,
          mrr: 0.8,
          ndcg_at_k: 0.85,
          missed: 1,
        }),
        'not json',
        JSON.stringify({ commit: 'missing fields' }),
        '',
      ].join('\n'),
    );
    const app = buildApp({
      engine: rig.engine,
      config: testConfig({ dataDir: rig.home }),
      appDistDir: '/nonexistent',
      evalHistoryPath: file,
    });
    const res = await request(app).get('/api/viz/eval').set(auth);
    expect(res.status).toBe(200);
    const history = evalHistorySchema.parse(res.body);
    expect(history.source).toBe(file);
    expect(history.runs).toHaveLength(1);
    expect(history.runs[0]?.commit).toBe('abc1234');
  });

  it('is empty, not an error, when the file does not exist', async () => {
    const app = buildApp({
      engine: rig.engine,
      config: testConfig({ dataDir: rig.home }),
      appDistDir: '/nonexistent',
      evalHistoryPath: path.join(dir, 'nope.jsonl'),
    });
    const res = await request(app).get('/api/viz/eval').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([]);
  });

  it('parses the repo history file', async () => {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(path.resolve(import.meta.dirname, '../../../../../docs/eval/history.jsonl'), 'utf8');
    const runs = parseEvalHistory(text);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.k === 5)).toBe(true);
  });
});
