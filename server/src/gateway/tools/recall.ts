import { z } from 'zod';
import type { Config } from '../../config.ts';
import type { ZeroMemEngine } from '../../engine/index.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';

export function recallTools(engine: ZeroMemEngine, config: Config): ToolDefinition[] {
  return [
    defineTool({
      name: 'zeromem_recall',
      title: 'Recall from memory',
      description: [
        'Retrieve the past conversation turns that bear on a question, best first, with no LLM in the loop.',
        'Recall fuses a lexical (BM25), an entity-graph and a dense-vector view and, for questions about',
        'time ("last week", "yesterday"), a recency view; each evidence item carries a score, a confidence',
        'relative to the best hit, and a role: `primary` (answers it) or `supporting` (context).',
        'Ask in natural language and name the people, projects or things involved — entities are what the graph keys on.',
        'Use `detail: "full"` to see which views were used and which entities each hit matched — this is',
        'the explanation, and asking again would re-run retrieval against a corpus that may have moved.',
        'Pass `exclude_session` with the current session id so recall does not echo the conversation in progress.',
      ].join(' '),
      inputSchema: {
        query: z.string().trim().min(1).describe('What to recall, in natural language.'),
        top_k: z.number().int().min(1).max(50).optional().describe('How many evidence items at most; default 5.'),
        exclude_session: z
          .string()
          .min(1)
          .optional()
          .describe('Leave out this session, typically the one asking; defaults to ZEROMEM_SESSION_ID when set.'),
        session: z.string().min(1).optional().describe('Only recall from this one session.'),
        since: z.number().int().optional().describe('Only turns at or after this Unix timestamp in milliseconds.'),
        until: z.number().int().optional().describe('Only turns at or before this Unix timestamp in milliseconds.'),
        detail: z
          .enum(['compact', 'full'])
          .optional()
          .describe('`compact` (default) returns the evidence; `full` adds the route taken and per-hit sources.'),
      },
      kind: 'read',
      run: (args) => {
        const { query, ...options } = args as { query: string; exclude_session?: string } & Record<string, unknown>;
        const exclude_session = options.exclude_session ?? config.sessionId ?? undefined;
        return engine.query(query, { ...options, exclude_session });
      },
    }),
  ];
}
