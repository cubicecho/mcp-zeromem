import { briefResponseSchema } from '@mcp-zeromem/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { tempEngine, testConfig } from '../../test-support.ts';

const auth = { Authorization: 'Bearer test-token' };

let rig: ReturnType<typeof tempEngine>;

beforeEach(async () => {
  rig = tempEngine();
  await rig.engine.ingestMany([
    { session_id: 'a', speaker: 'user', text: 'Maya Okafor owns billing.', ts: 1000, scope: 'project:atlas' },
    { session_id: 'b', speaker: 'user', text: 'Standup is at ten.', ts: 2000 },
  ]);
  await rig.engine.curateApply('r1', 'tester', [
    { op: 'brief', scope: 'project:atlas', text: 'Maya Okafor owns billing.', source_ids: [1], reason: 'first brief' },
  ]);
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

async function brief(server: ReturnType<typeof app>, query = '') {
  return briefResponseSchema.parse((await request(server).get(`/api/brief${query}`).set(auth)).body);
}

describe('GET /api/brief', () => {
  it('serves a scope’s brief behind the token, and null where there is none', async () => {
    expect((await request(app()).get('/api/brief')).status).toBe(401);

    const atlas = await brief(app(), '?scope=project%3Aatlas');
    expect(atlas).toMatchObject({
      scope: 'project:atlas',
      brief: { kind: 'brief', text: 'Maya Okafor owns billing.' },
    });

    expect(await brief(app())).toEqual({ scope: '', brief: null });
    expect(await brief(app(), '?scope=project%3Abasalt')).toEqual({ scope: 'project:basalt', brief: null });
  });

  it('defaults to the server’s scope, and an empty scope still means the unscoped store', async () => {
    const scoped = app({ scope: 'project:atlas' });
    expect((await brief(scoped)).brief?.text).toBe('Maya Okafor owns billing.');
    expect(await brief(scoped, '?scope=')).toEqual({ scope: '', brief: null });
  });
});
