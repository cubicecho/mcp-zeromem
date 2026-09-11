import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type EvalHistory, type EvalRun, evalRunSchema } from '@mcp-zeromem/shared';
import { Router } from 'express';

/** `EVAL_HISTORY` overrides; the default is the committed file at the repo root. */
export function defaultEvalHistoryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.EVAL_HISTORY?.trim();
  if (override) {
    return override;
  }
  return path.resolve(import.meta.dirname, '../../../../../docs/eval/history.jsonl');
}

/**
 * Parse the JSONL history. A malformed line is skipped, not fatal: the file
 * is appended by a script over many commits and one bad line must not blank
 * the whole dashboard.
 */
export function parseEvalHistory(text: string): EvalRun[] {
  const runs: EvalRun[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    try {
      const parsed = evalRunSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) {
        runs.push(parsed.data);
      }
    } catch {
      // not JSON; skip
    }
  }
  return runs;
}

/** `GET /api/viz/eval` — the harness numbers per commit, from the committed history file. */
export function createEvalRouter(historyPath: string = defaultEvalHistoryPath()): Router {
  const router = Router();
  router.get('/', async (_req, res, next) => {
    try {
      let text = '';
      try {
        text = await readFile(historyPath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
      const body: EvalHistory = { source: historyPath, runs: parseEvalHistory(text) };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });
  return router;
}
