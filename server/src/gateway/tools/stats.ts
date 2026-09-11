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
      ].join(' '),
      inputSchema: {
        include_sessions: z
          .boolean()
          .optional()
          .describe('Also return the sessions (id, turns, first_ts, last_ts), most recent first; default false.'),
        limit: z.number().int().min(1).max(500).optional().describe('How many sessions to include; default 50.'),
      },
      kind: 'read',
      run: async (args) => {
        const { include_sessions, limit } = args as { include_sessions?: boolean; limit?: number };
        const stats = await engine.stats();
        if (!include_sessions) {
          return stats;
        }
        const sessions = await engine.listSessions({ limit: limit ?? 50 });
        return { ...stats, sessions_list: sessions };
      },
    }),
  ];
}
