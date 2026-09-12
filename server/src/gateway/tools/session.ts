import { SESSION_WINDOW_MAX_TURNS, type SessionWindow } from '@mcp-zeromem/shared';
import { z } from 'zod';
import type { ZeroMemEngine } from '../../engine/index.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';

/**
 * A window as plain text, one block per turn in order, for the same hosts that
 * paste recall into a prompt.
 *
 * Nothing here is clipped. This tool is what a clipped recall hit points at —
 * cutting its answer too would leave the model exactly where it started, with a
 * fragment and no way to reach the rest.
 */
export function formatWindowText(window: SessionWindow): string {
  const { turns, offset, total } = window;
  const first = turns.length === 0 ? 0 : offset + 1;
  const header =
    `session ${window.session_id}: turns ${first}–${offset + turns.length} of ${total}` +
    (window.truncated ? ' (more; page on with `offset`)' : '');
  const body = turns.map((turn) => {
    const date = new Date(turn.ts).toISOString().slice(0, 10);
    const anchor = turn.id === window.around_turn ? '→ ' : '';
    return `${anchor}[turn ${turn.id}] ${date} ${turn.speaker}: ${normalise(turn.text)}`;
  });
  return [header, ...body].join('\n');
}

/** Drop what a prompt cannot use, but keep the line breaks that carry the turn's shape. */
function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sessionTools(engine: ZeroMemEngine): ToolDefinition[] {
  return [
    defineTool({
      name: 'zeromem_read_session',
      title: 'Read a session',
      description: [
        'Read stored turns in the order they were said: a whole session, or a window centred on one turn.',
        'This is how you expand something recall returned. Pass `around_turn` with the turn id from a recall hit',
        'to read that turn in full together with what came before and after it — use it whenever a hit was',
        'marked `[clipped: …]`, or whenever a hit looks like part of a longer answer, instead of concluding',
        'that memory is incomplete and looking elsewhere.',
        'Pass `session_id` instead to read a session from the start, paging with `limit` and `offset`.',
        'This is a read in conversation order, not a search: use `zeromem_recall` to find what is relevant.',
        'The reply reports `total` and `truncated`, so you can tell a whole session from part of one.',
      ].join(' '),
      inputSchema: {
        session_id: z
          .string()
          .min(1)
          .optional()
          .describe('The session to read; taken from `around_turn` when that is given instead.'),
        around_turn: z
          .number()
          .int()
          .optional()
          .describe('Centre the window on this turn id, e.g. the id in a recall hit.'),
        before: z
          .number()
          .int()
          .min(0)
          .max(SESSION_WINDOW_MAX_TURNS)
          .optional()
          .describe('With `around_turn`: how many turns before it; default 5.'),
        after: z
          .number()
          .int()
          .min(0)
          .max(SESSION_WINDOW_MAX_TURNS)
          .optional()
          .describe('With `around_turn`: how many turns after it; default 5.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SESSION_WINDOW_MAX_TURNS)
          .optional()
          .describe(`With \`session_id\`: how many turns at most; default 50, capped at ${SESSION_WINDOW_MAX_TURNS}.`),
        offset: z.number().int().min(0).optional().describe('With `session_id`: skip this many turns from the start.'),
        format: z
          .enum(['json', 'text'])
          .optional()
          .describe('`json` (default) returns the window object; `text` one block per turn for pasting into a prompt.'),
      },
      kind: 'read',
      run: async (args) => {
        // `format` shapes the reply here; the engine never sees it.
        const { format, ...options } = args as {
          format?: 'json' | 'text';
          session_id?: string;
          around_turn?: number;
        } & Record<string, unknown>;
        if (options.session_id === undefined && options.around_turn === undefined) {
          // Thrown, so the model reads it as a tool error and can correct the call.
          throw new Error('give `session_id` to read a session, or `around_turn` to read around one turn');
        }
        const window = await engine.sessionWindow(options);
        return format === 'text' ? formatWindowText(window) : window;
      },
    }),
  ];
}
