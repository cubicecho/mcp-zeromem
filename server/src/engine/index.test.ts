import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZeroMemEngine } from './index.ts';

let home: string;
let engine: ZeroMemEngine;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'zeromem-engine-'));
  engine = ZeroMemEngine.open(home, { embedder: 'hash' });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('ZeroMemEngine', () => {
  it('opens an empty store and reports zero counts', async () => {
    const stats = await engine.stats();
    expect(stats).toMatchObject({
      home,
      turns: 0,
      sessions: 0,
      entities: 0,
      embeddings: 0,
      embedder: 'hash-384',
      embedder_is_fallback: true,
      generation: 0,
      schema_version: 3,
    });
  });

  it('refuses an unknown embedder name', () => {
    const other = mkdtempSync(path.join(tmpdir(), 'zeromem-engine-'));
    try {
      expect(() => ZeroMemEngine.open(other, { embedder: 'bogus' as 'hash' })).toThrow(/unknown embedder/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('reopens without an embedder and leaves the vectors alone', async () => {
    await engine.ingestTurn({ session_id: 's1', speaker: 'user', text: 'the dense view is on', ts: 1 });
    const plain = ZeroMemEngine.open(home, { embedder: 'none' });
    const stats = await plain.stats();
    // The store still names its embedder; this process just cannot use it.
    expect(stats.embedder).toBe('hash-384');
    expect(stats.embedder_active).toBe(false);
    expect(stats.embeddings).toBe(1);
    // The option reaches the engine; the switch itself needs the ONNX model
    // and is covered by the crate's own tests.
    expect(() => ZeroMemEngine.open(home, { embedder: 'hash', allowEmbedderSwitch: true })).not.toThrow();
  });

  it('recalls what was remembered, with the route under full detail', async () => {
    await engine.ingestMany([
      { session_id: 's1', speaker: 'user', text: 'Maya Okafor owns the billing service on Heron.', ts: 1000 },
      { session_id: 's1', speaker: 'assistant', text: 'Noted, Maya owns billing.', ts: 1001 },
      { session_id: 's2', speaker: 'user', text: 'Coffee with Kenji turned into an hour on Basalt.', ts: 2000 },
    ]);
    const compact = await engine.query('who owns the billing service on Heron?');
    expect(compact.evidence[0]?.turn.text).toMatch(/Maya Okafor owns/);
    expect(compact.evidence[0]?.role).toBe('primary');
    expect(compact.route).toBeUndefined();

    const full = await engine.query('who owns the billing service on Heron?', { detail: 'full', top_k: 2 });
    expect(full.route?.views.map((v) => v.view)).toContain('lexical');
    expect(full.evidence.length).toBeLessThanOrEqual(2);
    expect(full.evidence[0]?.sources).toBeDefined();

    const excluded = await engine.query('who owns billing?', { exclude_session: 's1' });
    expect(excluded.evidence.every((e) => e.turn.session_id !== 's1')).toBe(true);

    const trace = await engine.queryTrace('who owns the billing service on Heron?');
    expect(trace.evidence.map((e) => e.turn.id)).toEqual(compact.evidence.map((e) => e.turn.id));
    expect(trace.views.length).toBeGreaterThan(0);
  });

  it('rebuilds without changing the counts', async () => {
    await engine.ingestTurn({ session_id: 's1', speaker: 'user', text: 'Rebuild keeps Maya on billing.', ts: 5 });
    const before = await engine.stats();
    await engine.rebuild();
    const after = await engine.stats();
    expect(after).toMatchObject({ turns: before.turns, entities: before.entities, embeddings: before.embeddings });
    expect(after.generation).toBe(before.generation + 1);
  });

  it('ingests, dedups and lists', async () => {
    const turn = { session_id: 's1', speaker: 'user', text: 'we picked postgres', ts: 1000 };
    const first = await engine.ingestTurn(turn);
    expect(first.outcome).toBe('indexed');
    const again = await engine.ingestTurn(turn);
    expect(again).toEqual({ outcome: 'duplicate', id: first.id });

    const report = await engine.ingestMany([
      { session_id: 's1', speaker: 'assistant', text: 'noted', ts: 1001 },
      { session_id: 's2', speaker: 'user', text: '  ' },
    ]);
    expect(report).toEqual({ indexed: 1, duplicates: 0, rejected: 1 });

    const sessions = await engine.listSessions();
    expect(sessions).toEqual([{ session_id: 's1', turns: 2, first_ts: 1000, last_ts: 1001 }]);
    const turns = await engine.sessionTurns('s1');
    expect(turns.map((t) => t.text)).toEqual(['we picked postgres', 'noted']);

    expect(await engine.deleteSession('s1')).toBe(2);
    expect((await engine.stats()).generation).toBe(1);
  });
});
