import { errorChainMessage } from '../errors.ts';
import type { ZeroMemEngine } from './index.ts';

export interface EmbedWorkerOptions {
  /** Turns per engine call; each call holds the engine mutex for one batch. */
  batch?: number;
  /** How long to wait after the embedder fails before trying again. */
  retryMs?: number;
  /** How often an idle worker looks for turns that arrived without a vector. */
  idleMs?: number;
  log?: (line: string) => void;
}

export interface EmbedWorkerStatus {
  running: boolean;
  /** Turns embedded by this worker since it started. */
  embedded: number;
  /** What the last failed batch said, until a batch succeeds. */
  last_error: string | null;
}

/**
 * Drains the embedding backlog in the background.
 *
 * Turns land in the store without a vector when the embedder was unreachable
 * at ingest, when a `zm` hook wrote them, or when the embedder was switched
 * and every vector dropped. Reads embed one batch each on `refresh()`, which
 * is enough to stay current but not to re-embed a corpus; this loop does the
 * rest, one batch at a time so a recall is never queued behind a corpus-wide
 * job. Only the HTTP server runs one: a stdio session lets the server do it,
 * and a headless host has `zm embedder drain`.
 *
 * A failing embedder (endpoint down, circuit breaker open) is not fatal: the
 * worker backs off for `retryMs` and tries again, and once the backlog is
 * empty it wakes every `idleMs` to look for new vectorless turns. `kick()`
 * wakes it at once after a switch.
 */
export class EmbedWorker {
  private readonly engine: ZeroMemEngine;
  private readonly batch: number;
  private readonly retryMs: number;
  private readonly idleMs: number;
  private readonly log: (line: string) => void;
  private stopped = true;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private embedded = 0;
  private lastError: string | null = null;
  private draining = false;
  private waiters: (() => void)[] = [];

  constructor(engine: ZeroMemEngine, options: EmbedWorkerOptions = {}) {
    this.engine = engine;
    this.batch = options.batch ?? 256;
    this.retryMs = options.retryMs ?? 30_000;
    this.idleMs = options.idleMs ?? 60_000;
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** Start the loop; a second call while running is a no-op. */
  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.loop = this.run();
  }

  /** Wake the loop now, e.g. right after the embedder was switched. */
  kick(): void {
    this.wake?.();
  }

  /** Stop after the batch in flight; resolves when the loop has exited. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.kick();
    await this.loop;
    this.loop = null;
  }

  status(): EmbedWorkerStatus {
    return { running: !this.stopped && this.draining, embedded: this.embedded, last_error: this.lastError };
  }

  /**
   * Resolves once the backlog is empty or the worker has stopped; for tests and
   * graceful shutdown. A failing embedder only delays it: the waiter sleeps
   * through the backoff with the loop and is released when a later pass empties
   * the backlog.
   *
   * The loop signals each time it finishes a pass; the waiter never polls. A
   * spin on `embeddingBacklog()` queues a read on the engine mutex between
   * every batch, so on a loaded machine the waiter can starve the very loop it
   * is waiting for.
   */
  async drained(): Promise<void> {
    while (!this.stopped) {
      // Register before reading the backlog: the batch in flight may finish
      // while that read is queued behind it on the engine mutex.
      const settled = new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
      if (!this.draining && (await this.engine.embeddingBacklog()) === 0) {
        return;
      }
      await settled;
    }
  }

  /** The loop has stopped working: release everyone waiting on it. */
  private settle(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const started = performance.now();
      const startedAt = this.embedded;
      let announced = false;
      let left = 0;
      try {
        let before = await this.engine.embeddingBacklog();
        while (!this.stopped && before > 0) {
          if (!announced) {
            this.log(`Embedding backlog: ${before} turns to embed`);
            announced = true;
          }
          this.draining = true;
          left = await this.engine.embedBacklog(this.batch);
          this.embedded += Math.max(0, before - left);
          before = left;
          this.lastError = null;
          // Let queued requests take the engine between batches.
          await new Promise((resolve) => setImmediate(resolve));
        }
        this.draining = false;
        if (announced) {
          const done = this.embedded - startedAt;
          const seconds = (performance.now() - started) / 1000;
          this.log(`Embedding backlog drained: ${done} turns in ${seconds.toFixed(1)}s`);
        }
        this.settle();
        await this.sleep(this.idleMs);
      } catch (err) {
        this.draining = false;
        const message = errorChainMessage(err);
        if (message !== this.lastError) {
          this.log(`Embedding backlog paused: ${message} (retrying in ${Math.round(this.retryMs / 1000)}s)`);
        }
        this.lastError = message;
        this.settle();
        await this.sleep(this.retryMs);
      }
    }
    this.settle();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        this.wake = null;
        resolve();
      };
      this.wake = finish;
      this.timer = setTimeout(finish, ms);
      // An idle worker must not keep the process alive.
      this.timer.unref();
    });
  }
}
