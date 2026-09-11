/**
 * In-memory operational counters for the health view. Nothing here is
 * persisted: the numbers describe this process since it started, which is
 * the question an operator asks of a health page ("is recall slow *now*?").
 * Durations are kept per minute for the last hour, so the page can draw a
 * series, plus a bounded reservoir over the whole run for the headline
 * percentiles.
 */

export const SERIES_MINUTES = 60;
const RESERVOIR = 2000;

export interface MinuteBucket {
  /** Epoch ms at the start of the minute. */
  minute: number;
  recalls: number;
  ingested: number;
  errors: number;
  /** Recall durations in this minute, ms. */
  durations: number[];
}

export interface HealthSnapshot {
  started_at: number;
  uptime_seconds: number;
  /** How long opening the store and warming it up took, ms. */
  open_ms: number;
  recall: { count: number; errors: number; p50_ms: number | null; p95_ms: number | null; max_ms: number | null };
  ingest: { calls: number; turns: number };
  /** One entry per minute for the last hour, oldest first, empty minutes included. */
  series: Array<{
    minute: number;
    recalls: number;
    ingested: number;
    errors: number;
    p50_ms: number | null;
    p95_ms: number | null;
  }>;
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export class Metrics {
  readonly startedAt: number;
  private openMs = 0;
  private readonly buckets = new Map<number, MinuteBucket>();
  private readonly reservoir: number[] = [];
  private recallCount = 0;
  private recallErrors = 0;
  private maxMs: number | null = null;
  private ingestCalls = 0;
  private ingestTurns = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.startedAt = now();
  }

  /** Record how long the store took to open and warm up. */
  recordOpen(ms: number): void {
    this.openMs = ms;
  }

  /** Time an async recall and record its duration, or its failure. */
  async timeRecall<T>(run: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      const value = await run();
      this.recordRecall(performance.now() - start);
      return value;
    } catch (err) {
      this.recallErrors += 1;
      this.bucket().errors += 1;
      throw err;
    }
  }

  recordRecall(ms: number): void {
    this.recallCount += 1;
    this.maxMs = this.maxMs === null ? ms : Math.max(this.maxMs, ms);
    const bucket = this.bucket();
    bucket.recalls += 1;
    bucket.durations.push(ms);
    // A bounded reservoir; once full, overwrite at random so the headline
    // percentiles describe the whole run rather than only its start.
    if (this.reservoir.length < RESERVOIR) {
      this.reservoir.push(ms);
    } else {
      this.reservoir[Math.floor(Math.random() * RESERVOIR)] = ms;
    }
  }

  recordIngest(turns: number): void {
    this.ingestCalls += 1;
    this.ingestTurns += turns;
    this.bucket().ingested += turns;
  }

  snapshot(): HealthSnapshot {
    const now = this.now();
    const currentMinute = Math.floor(now / 60_000) * 60_000;
    this.prune(currentMinute);
    const sorted = [...this.reservoir].sort((a, b) => a - b);
    const series: HealthSnapshot['series'] = [];
    for (let i = SERIES_MINUTES - 1; i >= 0; i -= 1) {
      const minute = currentMinute - i * 60_000;
      const bucket = this.buckets.get(minute);
      const durations = bucket ? [...bucket.durations].sort((a, b) => a - b) : [];
      series.push({
        minute,
        recalls: bucket?.recalls ?? 0,
        ingested: bucket?.ingested ?? 0,
        errors: bucket?.errors ?? 0,
        p50_ms: percentile(durations, 50),
        p95_ms: percentile(durations, 95),
      });
    }
    return {
      started_at: this.startedAt,
      uptime_seconds: Math.max(0, Math.floor((now - this.startedAt) / 1000)),
      open_ms: this.openMs,
      recall: {
        count: this.recallCount,
        errors: this.recallErrors,
        p50_ms: percentile(sorted, 50),
        p95_ms: percentile(sorted, 95),
        max_ms: this.maxMs,
      },
      ingest: { calls: this.ingestCalls, turns: this.ingestTurns },
      series,
    };
  }

  private bucket(): MinuteBucket {
    const minute = Math.floor(this.now() / 60_000) * 60_000;
    let bucket = this.buckets.get(minute);
    if (!bucket) {
      bucket = { minute, recalls: 0, ingested: 0, errors: 0, durations: [] };
      this.buckets.set(minute, bucket);
      this.prune(minute);
    }
    return bucket;
  }

  private prune(currentMinute: number): void {
    const oldest = currentMinute - (SERIES_MINUTES - 1) * 60_000;
    for (const key of this.buckets.keys()) {
      if (key < oldest) {
        this.buckets.delete(key);
      }
    }
  }
}
