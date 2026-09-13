import {
  graphSnapshotSchema,
  growthSchema,
  hierarchySnapshotSchema,
  projectionSchema,
  sessionTurnsWithEntitiesResponseSchema,
} from '@mcp-zeromem/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.ts';
import { tempEngine, testConfig } from '../../../test-support.ts';

let rig: ReturnType<typeof tempEngine>;
let app: ReturnType<typeof buildApp>;
const auth = { Authorization: 'Bearer test-token' };

const DAY = 86_400_000;

beforeEach(async () => {
  rig = tempEngine();
  app = buildApp({ engine: rig.engine, config: testConfig({ dataDir: rig.home }), appDistDir: '/nonexistent' });
  await rig.engine.ingestMany([
    { session_id: 'alpha', speaker: 'user', text: 'Maya Okafor owns the billing service on Project Heron.', ts: DAY },
    { session_id: 'alpha', speaker: 'assistant', text: 'Noted: Maya Okafor, billing, Project Heron.', ts: DAY + 1000 },
    { session_id: 'alpha', speaker: 'user', text: 'Heron ships on March 3, 2026 at $12,000 a month.', ts: DAY + 2000 },
    { session_id: 'beta', speaker: 'user', text: 'Kenji Sato took over Project Basalt from Maya Okafor.', ts: 2 * DAY },
    {
      session_id: 'beta',
      speaker: 'assistant',
      text: 'Basalt is Kenji Sato now; Heron stays with Maya.',
      ts: 2 * DAY + 5,
    },
  ]);
});

afterEach(() => {
  rig.cleanup();
});

describe('/api/viz', () => {
  it('needs the bearer token like the other REST reads', async () => {
    expect((await request(app).get('/api/viz/graph')).status).toBe(401);
    expect((await request(app).get('/api/viz/growth')).status).toBe(401);
  });

  it('returns the entity graph, capped and filterable', async () => {
    const res = await request(app).get('/api/viz/graph').set(auth);
    expect(res.status).toBe(200);
    const graph = graphSnapshotSchema.parse(res.body);
    const names = graph.nodes.map((n) => n.entity);
    expect(names).toContain('maya okafor');
    expect(names).toContain('project heron');
    expect(graph.edges.some((e) => [e.a, e.b].includes('maya okafor'))).toBe(true);
    expect(graph.total_entities).toBe(graph.nodes.length);
    expect(graph.truncated).toBe(false);

    const capped = graphSnapshotSchema.parse((await request(app).get('/api/viz/graph?limit=2').set(auth)).body);
    expect(capped.nodes).toHaveLength(2);
    expect(capped.truncated).toBe(true);

    const focused = graphSnapshotSchema.parse(
      (await request(app).get('/api/viz/graph?focus=kenji%20sato&hops=1').set(auth)).body,
    );
    expect(focused.nodes.map((n) => n.entity)).toContain('kenji sato');
    expect(focused.nodes.map((n) => n.entity)).toContain('project basalt');
    expect(focused.nodes.map((n) => n.entity)).not.toContain('project heron');

    const dates = graphSnapshotSchema.parse((await request(app).get('/api/viz/graph?kind=date').set(auth)).body);
    expect(dates.nodes.every((n) => n.kind === 'date')).toBe(true);
    expect(dates.nodes.length).toBeGreaterThan(0);
  });

  it('rejects options outside the caps', async () => {
    expect((await request(app).get('/api/viz/graph?limit=5000').set(auth)).status).toBe(400);
    expect((await request(app).get('/api/viz/graph?hops=9').set(auth)).status).toBe(400);
    expect((await request(app).get('/api/viz/projection?limit=1').set(auth)).status).toBe(400);
  });

  it('returns the hierarchy, paged and range-filtered', async () => {
    const all = hierarchySnapshotSchema.parse((await request(app).get('/api/viz/hierarchy').set(auth)).body);
    expect(all.total_sessions).toBe(2);
    expect(all.sessions.map((s) => s.session_id)).toEqual(['beta', 'alpha']);
    const alpha = all.sessions.find((s) => s.session_id === 'alpha');
    expect(alpha?.turns).toBe(3);
    expect(alpha?.windows.length).toBeGreaterThanOrEqual(1);
    expect(alpha?.windows[0]?.entities).toContain('maya okafor');

    const late = hierarchySnapshotSchema.parse(
      (
        await request(app)
          .get(`/api/viz/hierarchy?since=${2 * DAY}`)
          .set(auth)
      ).body,
    );
    expect(late.sessions.map((s) => s.session_id)).toEqual(['beta']);

    const paged = hierarchySnapshotSchema.parse(
      (await request(app).get('/api/viz/hierarchy?limit=1&offset=1').set(auth)).body,
    );
    expect(paged.total_sessions).toBe(2);
    expect(paged.sessions.map((s) => s.session_id)).toEqual(['alpha']);
  });

  it("returns a session's turns with their entity spans", async () => {
    const res = await request(app).get('/api/viz/sessions/alpha/turns').set(auth);
    expect(res.status).toBe(200);
    const body = sessionTurnsWithEntitiesResponseSchema.parse(res.body);
    expect(body.turns).toHaveLength(3);
    const first = body.turns[0];
    const maya = first?.entities.find((m) => m.key === 'maya okafor');
    expect(maya).toBeDefined();
    expect(first?.text.slice(maya?.start, maya?.end)).toBe('Maya Okafor');
    const third = body.turns[2];
    expect(third?.entities.map((m) => m.kind)).toEqual(expect.arrayContaining(['date', 'quantity']));

    expect((await request(app).get('/api/viz/sessions/nope/turns').set(auth)).status).toBe(404);
  });

  it('kinds paths, symbols and env vars, and filters the graph by them', async () => {
    await rig.engine.ingestMany([
      {
        session_id: 'gamma',
        speaker: 'user',
        text: 'Maya moved HERON_LEDGER_URL into src/heron/ledger.rs, next to heron::ledger::flush.',
        ts: 3 * DAY,
      },
    ]);
    const turns = sessionTurnsWithEntitiesResponseSchema.parse(
      (await request(app).get('/api/viz/sessions/gamma/turns').set(auth)).body,
    );
    const mentions = turns.turns[0]?.entities.map((m) => [m.key, m.kind]);
    expect(mentions).toEqual(
      expect.arrayContaining([
        ['heron_ledger_url', 'env'],
        ['src/heron/ledger.rs', 'path'],
        ['heron::ledger::flush', 'symbol'],
      ]),
    );

    const paths = graphSnapshotSchema.parse((await request(app).get('/api/viz/graph?kind=path').set(auth)).body);
    expect(paths.nodes.map((n) => [n.entity, n.kind])).toEqual([['src/heron/ledger.rs', 'path']]);
  });

  it('projects the vectors and overlays a query', async () => {
    const plain = projectionSchema.parse((await request(app).get('/api/viz/projection').set(auth)).body);
    expect(plain.points).toHaveLength(5);
    expect(plain.total).toBe(5);
    expect(plain.embedder).toBe('hash-384');
    expect(plain.query).toBeNull();
    expect(plain.basis.axes[0]).toHaveLength(384);

    const withQuery = projectionSchema.parse(
      (await request(app).get('/api/viz/projection?query=who%20owns%20billing%20on%20Heron').set(auth)).body,
    );
    expect(withQuery.query?.neighbours[0]).toBe(
      plain.points.find((p) => p.text.startsWith('Maya Okafor owns'))?.turn_id,
    );
    // The sample and its plane are the same request to request.
    expect(withQuery.points).toEqual(plain.points);

    const beta = projectionSchema.parse((await request(app).get('/api/viz/projection?session=beta').set(auth)).body);
    expect(beta.points.every((p) => p.session_id === 'beta')).toBe(true);
    expect(beta.total).toBe(2);
  });

  it('counts turns and sessions per day', async () => {
    const growth = growthSchema.parse((await request(app).get('/api/viz/growth').set(auth)).body);
    expect(growth.days).toEqual([
      { day: '1970-01-02', turns: 3, sessions: 1, cumulative_turns: 3 },
      { day: '1970-01-03', turns: 2, sessions: 1, cumulative_turns: 5 },
    ]);
    const late = growthSchema.parse(
      (
        await request(app)
          .get(`/api/viz/growth?since=${2 * DAY}`)
          .set(auth)
      ).body,
    );
    expect(late.days.map((d) => d.day)).toEqual(['1970-01-03']);
  });
});
