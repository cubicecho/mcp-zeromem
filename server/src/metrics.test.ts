import { describe, expect, it } from 'vitest';
import { Metrics, percentile, SERIES_MINUTES } from './metrics.ts';

describe('Metrics', () => {
  it('reports percentiles over what it has seen', () => {
    let now = 1_000_000 * 60_000;
    const metrics = new Metrics(() => now);
    for (const ms of [5, 10, 15, 20, 100]) {
      metrics.recordRecall(ms);
    }
    now += 60_000;
    metrics.recordRecall(50);
    metrics.recordIngest(3);
    const snap = metrics.snapshot();
    expect(snap.recall.count).toBe(6);
    expect(snap.recall.p50_ms).toBe(15);
    expect(snap.recall.p95_ms).toBe(100);
    expect(snap.recall.max_ms).toBe(100);
    expect(snap.ingest).toEqual({ calls: 1, turns: 3 });
    expect(snap.series).toHaveLength(SERIES_MINUTES);
    expect(snap.series.at(-1)).toMatchObject({ recalls: 1, ingested: 3, p50_ms: 50 });
    expect(snap.series.at(-2)).toMatchObject({ recalls: 5, ingested: 0, p50_ms: 15 });
    expect(snap.series[0]).toMatchObject({ recalls: 0, p50_ms: null });
    expect(snap.uptime_seconds).toBe(60);
  });

  it('times a recall and counts a failure', async () => {
    const metrics = new Metrics();
    await metrics.timeRecall(async () => 'ok');
    await expect(metrics.timeRecall(async () => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
    const snap = metrics.snapshot();
    expect(snap.recall.count).toBe(1);
    expect(snap.recall.errors).toBe(1);
    expect(snap.series.at(-1)?.errors).toBe(1);
  });

  it('drops minutes older than the series window', () => {
    let now = 0;
    const metrics = new Metrics(() => now);
    metrics.recordRecall(1);
    now = (SERIES_MINUTES + 5) * 60_000;
    metrics.recordRecall(2);
    const snap = metrics.snapshot();
    expect(snap.series.reduce((sum, m) => sum + m.recalls, 0)).toBe(1);
    // The headline numbers still cover the whole run.
    expect(snap.recall.count).toBe(2);
  });

  it('percentile handles the edges', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
  });
});
