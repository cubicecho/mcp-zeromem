import { curationActionsSchema, curationAliasesSchema, curationRunsSchema } from '@mcp-zeromem/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { tempEngine, testConfig } from '../../test-support.ts';

const auth = { Authorization: 'Bearer test-token' };

let rig: ReturnType<typeof tempEngine>;

beforeEach(async () => {
  rig = tempEngine();
  await rig.engine.ingestMany([
    { session_id: 'a', speaker: 'user', text: 'Maya Okafor owns billing.', ts: 1000, uuid: 'u1' },
    { session_id: 'a', speaker: 'user', text: 'Maya owns billing too.', ts: 2000, uuid: 'u2' },
  ]);
  await rig.engine.curateApply('r1', 'tester', [
    { op: 'hide', turn_ids: [2], reason: 'repeat of #1' },
    { op: 'alias', alias: 'Maya', canonical: 'Maya Okafor', reason: 'same person' },
    { op: 'run_end', summary: 'tidied' },
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

describe('/api/curation', () => {
  it('lists runs, their actions and the aliases behind the token', async () => {
    expect((await request(app()).get('/api/curation/runs')).status).toBe(401);

    const runs = curationRunsSchema.parse((await request(app()).get('/api/curation/runs').set(auth)).body);
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]).toMatchObject({ run_id: 'r1', actor: 'tester', finished: true, summary: 'tidied' });
    expect(runs.runs[0]?.ops).toMatchObject({ hide: 1, alias: 1 });

    const actions = curationActionsSchema.parse(
      (await request(app()).get('/api/curation/actions?run_id=r1').set(auth)).body,
    );
    const hide = actions.actions.find((a) => a.op === 'hide');
    expect(hide).toMatchObject({ reason: 'repeat of #1', undone_at: null });
    expect(hide?.targets).toEqual([expect.objectContaining({ uuid: 'u2', id: 2, text: 'Maya owns billing too.' })]);

    const aliases = curationAliasesSchema.parse((await request(app()).get('/api/curation/aliases').set(auth)).body);
    expect(aliases.aliases).toEqual([expect.objectContaining({ canonical: expect.stringMatching(/maya okafor/i) })]);
  });

  it('undoes one action, then the rest of the run', async () => {
    const actions = curationActionsSchema.parse(
      (await request(app()).get('/api/curation/actions?run_id=r1').set(auth)).body,
    );
    const alias = actions.actions.find((a) => a.op === 'alias');
    const one = await request(app()).post('/api/curation/undo').set(auth).send({ action_id: alias?.id });
    expect(one.status).toBe(200);
    expect(one.body.undone).toEqual([alias?.id]);
    expect((await rig.engine.curationAliases()).aliases).toEqual([]);

    const run = await request(app()).post('/api/curation/undo').set(auth).send({ run_id: 'r1' });
    expect(run.status).toBe(200);
    expect((await rig.engine.stats()).hidden).toBe(0);

    const actor = curationActionsSchema.parse(
      (await request(app()).get('/api/curation/actions?run_id=r1').set(auth)).body,
    );
    expect(actor.actions.find((a) => a.op === 'hide')?.undone_by).toBe('ui');
  });

  it('refuses a malformed undo, and every undo when read-only', async () => {
    expect((await request(app()).post('/api/curation/undo').set(auth).send({})).status).toBe(400);
    expect(
      (await request(app()).post('/api/curation/undo').set(auth).send({ action_id: 1, run_id: 'r1' })).status,
    ).toBe(400);
    expect((await request(app()).post('/api/curation/undo').set(auth).send({ action_id: 999 })).status).toBe(400);
    const readOnly = await request(app({ readOnly: true }))
      .post('/api/curation/undo')
      .set(auth)
      .send({ run_id: 'r1' });
    expect(readOnly.status).toBe(403);
    expect((await rig.engine.stats()).hidden).toBe(1);
  });
});
