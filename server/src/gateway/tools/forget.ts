import { z } from 'zod';
import type { ZeroMemEngine } from '../../engine/index.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';

export function forgetTools(engine: ZeroMemEngine): ToolDefinition[] {
  return [
    defineTool({
      name: 'zeromem_forget_session',
      title: 'Forget a session',
      description: [
        'Permanently delete every turn of one session from the memory store, and drop it from every index.',
        'This cannot be undone. Requires `confirm: true`; call zeromem_stats with include_sessions first',
        'to check the session id and how many turns it holds.',
        'Returns the number of turns removed; zero means no session had that id.',
      ].join(' '),
      inputSchema: {
        session_id: z.string().min(1).describe('The session to forget.'),
        confirm: z.literal(true).describe('Must be true; this is the acknowledgement that the deletion is permanent.'),
      },
      kind: 'write',
      destructive: true,
      run: async (args) => {
        const { session_id } = args as { session_id: string };
        const removed = await engine.deleteSession(session_id);
        return { session_id, removed };
      },
    }),
  ];
}
