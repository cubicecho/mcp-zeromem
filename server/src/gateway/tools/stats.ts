import { z } from 'zod';
import type { ZeroMemEngine } from '../../engine/index.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';

export function statsTools(engine: ZeroMemEngine): ToolDefinition[] {
  return [
    defineTool({
      name: 'zeromem_stats',
      title: 'Memory store statistics',
      description: [
        'Report the size and health of the memory store: turns, sessions, entities, graph edges,',
        'timeline windows and episodes, embeddings, and which embedder is in use.',
        '`embedder_is_fallback: true` means the dense model could not load and recall is lexical + entity + hash only.',
        'Use it to check that memory is available and populated before relying on recall,',
        'or to confirm that a remember call actually landed.',
        'Set include_sessions to also list the sessions with their turn counts and activity span.',
        '`scopes` lists the scopes in the store with their turn and session counts, which is how to find the',
        'label to pass as `scope` to recall; it is absent while nothing is scoped.',
      ].join(' '),
      inputSchema: {
        include_sessions: z
          .boolean()
          .optional()
          .describe('Also return the sessions (id, turns, first_ts, last_ts), most recent first; default false.'),
        limit: z.number().int().min(1).max(500).optional().describe('How many sessions to include; default 50.'),
        scope: z
          .string()
          .trim()
          .max(200)
          .optional()
          .describe('With include_sessions: only the sessions in this scope.'),
      },
      kind: 'read',
      run: async (args) => {
        const { include_sessions, limit, scope } = args as {
          include_sessions?: boolean;
          limit?: number;
          scope?: string;
        };
        const stats = await engine.stats();
        if (!include_sessions) {
          return stats;
        }
        const sessions = await engine.listSessions({ limit: limit ?? 50, scope });
        return { ...stats, sessions_list: sessions };
      },
    }),
  ];
}
