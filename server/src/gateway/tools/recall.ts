import type { Evidence } from '@mcp-zeromem/shared';
import { z } from 'zod';
import type { Config } from '../../config.ts';
import type { ZeroMemEngine } from '../../engine/index.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';

/** Longest turn text a `text` line carries, in code points, before it is cut with an ellipsis. */
const TEXT_LINE_LIMIT = 500;

/**
 * Evidence as one line per hit, for a host that pastes recall into a prompt
 * rather than handing the model JSON. Primary hits come first, then
 * supporting, each group in rank order; no evidence is the empty string so the
 * host can skip the block entirely.
 */
export function formatEvidenceText(evidence: readonly Evidence[]): string {
  const ordered = [
    ...evidence.filter((item) => item.role === 'primary'),
    ...evidence.filter((item) => item.role !== 'primary'),
  ];
  return ordered
    .map(({ role, turn }) => {
      const date = new Date(turn.ts).toISOString().slice(0, 10);
      return `[${role}] ${date} ${turn.speaker} (session ${turn.session_id}): ${clip(turn.text)}`;
    })
    .join('\n');
}

function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  // By code point, so the cut never leaves half a surrogate pair in the prompt.
  const chars = Array.from(collapsed);
  return chars.length > TEXT_LINE_LIMIT ? `${chars.slice(0, TEXT_LINE_LIMIT).join('')}…` : collapsed;
}

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
        'Use `format: "text"` for one line per hit (role, date, speaker, session, text) instead of JSON.',
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
        format: z
          .enum(['json', 'text'])
          .optional()
          .describe('`json` (default) returns the evidence object; `text` one line per hit for pasting into a prompt.'),
      },
      kind: 'read',
      run: async (args) => {
        // `format` shapes the reply here; the engine never sees it.
        const { query, format, ...options } = args as {
          query: string;
          format?: 'json' | 'text';
          exclude_session?: string;
        } & Record<string, unknown>;
        const exclude_session = options.exclude_session ?? config.sessionId ?? undefined;
        const result = await engine.query(query, { ...options, exclude_session });
        return format === 'text' ? formatEvidenceText(result.evidence) : result;
      },
    }),
  ];
}
