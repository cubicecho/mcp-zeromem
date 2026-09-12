import { type Evidence, MAX_CONTEXT, type StoredTurn } from '@mcp-zeromem/shared';
import { z } from 'zod';
import type { Config } from '../../config.ts';
import type { ZeroMemEngine } from '../../engine/index.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';

/** Longest turn text a `text` block carries, in code points, when the caller and the config are both silent. */
const DEFAULT_TEXT_LIMIT = 2000;

/**
 * Evidence as one block per hit, for a host that pastes recall into a prompt
 * rather than handing the model JSON. Primary hits come first, then supporting,
 * each group in rank order; no evidence is the empty string so the host can
 * skip the block entirely.
 *
 * A block keeps the turn's own line breaks — a numbered list that arrives as a
 * paragraph reads as a truncated answer — and, under `context`, carries the
 * neighbouring turns of its session around it.
 */
export function formatEvidenceText(evidence: readonly Evidence[], limit = DEFAULT_TEXT_LIMIT): string {
  const ordered = [
    ...evidence.filter((item) => item.role === 'primary'),
    ...evidence.filter((item) => item.role !== 'primary'),
  ];
  return ordered.map((item) => formatBlock(item, limit)).join('\n\n');
}

function formatBlock(item: Evidence, limit: number): string {
  const { role, turn } = item;
  const date = new Date(turn.ts).toISOString().slice(0, 10);
  const header = `[${role}] ${date} ${turn.speaker} (session ${turn.session_id}, turn ${turn.id})`;
  return [
    ...(item.before ?? []).map((neighbour) => neighbourLine('before', neighbour, limit)),
    `${header}: ${body(turn, limit)}`,
    ...(item.after ?? []).map((neighbour) => neighbourLine('after', neighbour, limit)),
  ].join('\n');
}

/** A neighbour is in the hit's own session, so it repeats only what varies: who, which turn. */
function neighbourLine(side: 'before' | 'after', turn: StoredTurn, limit: number): string {
  return `[${side}] ${turn.speaker} (turn ${turn.id}): ${body(turn, limit)}`;
}

function body(turn: StoredTurn, limit: number): string {
  return clip(normalise(turn.text), limit, turn.id);
}

/**
 * Keep the shape of the turn while dropping only what a prompt cannot use:
 * carriage returns, trailing spaces and runs of blank lines. Collapsing all
 * whitespace instead would turn a list into a paragraph.
 */
function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Cut only when the text really is longer than `limit`, and then say so in
 * terms the model can act on: what was kept, what there is, and the exact call
 * that returns the rest. A bare `…` is indistinguishable from a turn that ended
 * that way, which is what sends an agent looking somewhere else for an answer
 * the store already holds.
 */
function clip(text: string, limit: number, turnId: number): string {
  // By code point, so the cut never leaves half a surrogate pair in the prompt.
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  const kept = chars.slice(0, limit).join('');
  return `${kept}\n… [clipped: ${limit} of ${chars.length} characters — zeromem_read_session {around_turn: ${turnId}}]`;
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
        'Use `format: "text"` for one block per hit (role, date, speaker, session, turn id, text) instead of JSON.',
        'Use `context: 1` to attach the turns either side of each hit within its session — the question a hit',
        'answers, or the rest of a list it begins. Neighbours are context, never results: the ranking is unchanged.',
        'If a hit ends in `[clipped: … — zeromem_read_session {around_turn: N}]` it was cut to fit; call',
        '`zeromem_read_session` with that turn id to read the whole thing rather than treating memory as incomplete.',
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
        context: z
          .number()
          .int()
          .min(0)
          .max(MAX_CONTEXT)
          .optional()
          .describe(
            'Attach this many same-session turns either side of each hit, as `before`/`after`; default 0. Costs tokens: prefer `context: 1` with a smaller `top_k`.',
          ),
        format: z
          .enum(['json', 'text'])
          .optional()
          .describe(
            '`json` (default) returns the evidence object; `text` one block per hit for pasting into a prompt.',
          ),
        max_chars: z
          .number()
          .int()
          .min(100)
          .max(20000)
          .optional()
          .describe('Longest turn text a `text` block carries before it is cut and marked; default 2000.'),
      },
      kind: 'read',
      run: async (args) => {
        // `format` and `max_chars` shape the reply here; the engine never sees them.
        const { query, format, max_chars, ...options } = args as {
          query: string;
          format?: 'json' | 'text';
          max_chars?: number;
          exclude_session?: string;
        } & Record<string, unknown>;
        const exclude_session = options.exclude_session ?? config.sessionId ?? undefined;
        const result = await engine.query(query, { ...options, exclude_session });
        return format === 'text' ? formatEvidenceText(result.evidence, max_chars ?? config.recallTextLimit) : result;
      },
    }),
  ];
}
