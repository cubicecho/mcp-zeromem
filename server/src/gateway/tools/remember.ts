import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from '../../config.ts';
import type { ZeroMemEngine } from '../../engine/index.ts';
import { parseJsonl } from '../../engine/jsonl.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';

const turnShape = z.object({
  speaker: z.string().min(1).describe('Who said it: `user`, `assistant`, or a name.'),
  text: z.string().min(1).describe('What was said.'),
  ts: z.number().int().optional().describe('When, as a Unix timestamp in milliseconds; defaults to now.'),
  uuid: z
    .string()
    .min(1)
    .optional()
    .describe('A stable id for the turn; remembering the same uuid twice counts as a duplicate, not a new turn.'),
});

export function rememberTools(engine: ZeroMemEngine, config: Config): ToolDefinition[] {
  return [
    defineTool({
      name: 'zeromem_remember',
      title: 'Remember turns',
      description: [
        'Store one or more conversation turns under a session so later recall can find them.',
        'Each turn is indexed on write — entities, timeline and embedding — and there is nothing to flush.',
        'Idempotent: a turn with a uuid already stored (or identical content and timestamp) is reported as a',
        'duplicate and not stored twice, so re-sending a batch after a timeout is safe.',
        'Returns how many turns were indexed, how many were duplicates, and how many were rejected (empty text).',
      ].join(' '),
      inputSchema: {
        session_id: z.string().min(1).describe('The conversation these turns belong to.'),
        turns: z.array(turnShape).min(1).max(1000).describe('The turns, oldest first.'),
      },
      kind: 'write',
      run: (args) => {
        const { session_id, turns } = args as { session_id: string; turns: z.infer<typeof turnShape>[] };
        return engine.ingestMany(turns.map((turn) => ({ session_id, ...turn })));
      },
    }),
    defineTool({
      name: 'zeromem_ingest',
      title: 'Bulk ingest JSONL',
      description: [
        'Load many turns at once from JSONL: one JSON object per line with `session_id`, `speaker`, `text`,',
        'and optionally `ts` (Unix milliseconds) and `uuid`.',
        'Pass the text as `jsonl`, or the path of a file inside the data directory as `path`.',
        'Malformed lines are skipped and listed by line number; the rest are indexed, with duplicates counted.',
      ].join(' '),
      inputSchema: {
        jsonl: z.string().min(1).optional().describe('The JSONL text itself.'),
        path: z
          .string()
          .min(1)
          .optional()
          .describe(`A file path under the data directory (${config.dataDir}) to read JSONL from.`),
      },
      kind: 'write',
      run: async (args) => {
        const { jsonl, path: filePath } = args as { jsonl?: string; path?: string };
        if ((jsonl === undefined) === (filePath === undefined)) {
          throw new Error('pass exactly one of `jsonl` or `path`');
        }
        const text = jsonl ?? (await readFile(resolveUnder(config.dataDir, filePath ?? ''), 'utf8'));
        const parsed = parseJsonl(text);
        const report = parsed.turns.length > 0 ? await engine.ingestMany(parsed.turns) : emptyReport();
        return {
          ...report,
          rejected: report.rejected + parsed.rejected.length,
          rejected_lines: parsed.rejected.slice(0, 20),
        };
      },
    }),
  ];
}

function emptyReport() {
  return { indexed: 0, duplicates: 0, rejected: 0 };
}

/**
 * The only files this process reads on request are the operator's own, under
 * the data directory: a tool that reads any path the model names is a tool
 * that reads /etc/passwd when the model is confused.
 */
export function resolveUnder(root: string, requested: string): string {
  const resolved = path.resolve(root, requested);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`path must be inside the data directory (${root}): ${requested}`);
  }
  return resolved;
}
