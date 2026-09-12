import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockEmbeddingsServer, tempEngine } from '../test-support.ts';
import { EmbedWorker } from './embed-worker.ts';
import { ZeroMemEngine } from './index.ts';

let rig: ReturnType<typeof tempEngine>;

beforeEach(() => {
  rig = tempEngine();
});

afterEach(() => {
  rig.cleanup();
});

describe('EmbedWorker', () => {
  it('embeds turns another process stored without vectors', async () => {
    // A hook process opened with `none` writes turns but cannot embed them.
    const hook = ZeroMemEngine.open(rig.home, { embedder: 'none' });
    await hook.ingestMany(
      Array.from({ length: 7 }, (_, i) => ({ session_id: 'h', speaker: 'user', text: `hook turn ${i}`, ts: i + 1 })),
    );
    expect(await rig.engine.embeddingBacklog()).toBe(7);

    const lines: string[] = [];
    const worker = new EmbedWorker(rig.engine, { batch: 3, log: (line) => lines.push(line) });
    worker.start();
    worker.start();
    await worker.drained();
    await worker.stop();

    expect(await rig.engine.embeddingBacklog()).toBe(0);
    expect((await rig.engine.stats()).embeddings).toBe(7);
    expect(worker.status()).toMatchObject({ running: false, embedded: 7, last_error: null });
    expect(lines[0]).toMatch(/7 turns to embed/);
    expect(lines.at(-1)).toMatch(/drained: 7 turns/);
  });

  it('stops at once when the loop has not reached its first sleep', async () => {
    // The kick from stop() lands while the loop is still on its first backlog
    // read, so there is no sleep to wake. The sleep it starts a moment later
    // must not hold the worker — and stop()'s caller — for the idle interval.
    const worker = new EmbedWorker(rig.engine, { batch: 2, log: () => {} });
    const started = performance.now();
    worker.start();
    await worker.stop();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(worker.status()).toMatchObject({ running: false, embedded: 0 });
  });

  it('backs off when the endpoint fails and resumes when it recovers', async () => {
    const endpoint = await mockEmbeddingsServer();
    try {
      await rig.engine.setEmbedder({
        kind: 'openai',
        url: endpoint.url,
        model: 'mock-embed',
        query_prefix: '',
        document_prefix: '',
        timeout_ms: 5000,
        max_chars: 8000,
      });
      const hook = ZeroMemEngine.open(rig.home, { embedder: 'none' });
      await hook.ingestMany(
        Array.from({ length: 4 }, (_, i) => ({ session_id: 'h', speaker: 'user', text: `hook turn ${i}`, ts: i + 1 })),
      );
      // Two failures in a row: the embedder's single retry does not cover them.
      endpoint.failNext(2);
      const worker = new EmbedWorker(rig.engine, { batch: 2, retryMs: 20, log: () => {} });
      worker.start();
      await worker.drained();
      await worker.stop();
      expect(worker.status().last_error).toBeNull();
      expect(await rig.engine.embeddingBacklog()).toBe(0);
      expect((await rig.engine.stats()).embeddings).toBe(4);
    } finally {
      await endpoint.close();
    }
  });
});
