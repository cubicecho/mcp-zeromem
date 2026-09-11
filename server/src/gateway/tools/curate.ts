import { CURATOR_LIMITS, type CurationAction, candidateKindSchema, curationActionSchema } from '@mcp-zeromem/shared';
import { z } from 'zod';
import type { ZeroMemEngine } from '../../engine/index.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';

/** Who the action log records when the caller does not say. */
const DEFAULT_ACTOR = 'mcp-curator';

/**
 * The curator's tools: find candidates, read context, apply reversible edits
 * and undo them. Served only to the curator scope (or to everyone when the
 * Settings page says so); the `zeromem_curate` prompt holds the procedure.
 */
export function curateTools(engine: ZeroMemEngine): ToolDefinition[] {
  return [
    defineTool({
      name: 'zeromem_curate_runs',
      title: 'Curation runs',
      description: [
        'Start a curation run here. Returns past runs (newest first) with their counts per op, the cursor',
        'the finders start after, and the limits zeromem_curate_apply enforces (actions per call, per run,',
        'and the minimum turn age). The zeromem_curate prompt holds the full procedure.',
      ].join(' '),
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe('Runs to list; default 10.') },
      kind: 'read',
      run: async (args) => {
        const { limit } = args as { limit?: number };
        const [runs, config] = await Promise.all([engine.curationRuns({ limit: limit ?? 10 }), engine.curatorConfig()]);
        return {
          ...runs,
          limits: { max_per_call: config.max_per_call, max_per_run: config.max_per_run, min_age_ms: config.min_age_ms },
        };
      },
    }),
    defineTool({
      name: 'zeromem_curate_candidates',
      title: 'Curation candidates',
      description: [
        'One page of candidates of one kind, found without a model: duplicates (the same statement twice),',
        'noise (chatter, pasted output), supersession (a newer value for the same subject), aliases (two names',
        'for one entity) and consolidation (a long old episode with no note). Each has a score, the turns',
        'involved (text clipped), a reason and a suggested action. A candidate is a lead, not a verdict.',
        'When `more` is true, continue with since_turn_id = scanned_through (or offset for aliases and',
        'consolidation).',
      ].join(' '),
      inputSchema: {
        kind: candidateKindSchema,
        since_turn_id: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Look only at turns after this id; defaults to the run cursor.'),
        limit: z.number().int().min(1).max(100).optional().describe('Candidates per page; default 20.'),
        offset: z.number().int().min(0).optional().describe('For aliases and consolidation: skip this many.'),
      },
      kind: 'read',
      run: async (args) => {
        const { kind, since_turn_id, limit, offset } = args as {
          kind: z.infer<typeof candidateKindSchema>;
          since_turn_id?: number;
          limit?: number;
          offset?: number;
        };
        return engine.curateCandidates(kind, { since_turn_id, limit, offset });
      },
    }),
    defineTool({
      name: 'zeromem_curate_read',
      title: 'Read turns for curation',
      description: [
        'Full turns with their entity spans and curation flags (hidden, superseded_by, supersedes,',
        'covered_by, sources), by turn ids, a whole session, or every turn mentioning an entity.',
        'Hidden turns are included. Give exactly one of turn_ids, session_id or entity.',
      ].join(' '),
      inputSchema: {
        turn_ids: z.array(z.number().int().min(0)).min(1).max(500).optional(),
        session_id: z.string().min(1).optional(),
        entity: z.string().min(1).optional().describe('An entity name as written, e.g. "Maya Okafor".'),
        limit: z.number().int().min(1).max(500).optional().describe('Turns at most; default 50.'),
      },
      kind: 'read',
      run: async (args) => {
        const { turn_ids, session_id, entity, limit } = args as {
          turn_ids?: number[];
          session_id?: string;
          entity?: string;
          limit?: number;
        };
        const given = [turn_ids, session_id, entity].filter((v) => v !== undefined).length;
        if (given !== 1) {
          throw new Error('Give exactly one of turn_ids, session_id or entity.');
        }
        return engine.curationTurns({ turn_ids, session_id, entity }, limit);
      },
    }),
    defineTool({
      name: 'zeromem_curate_apply',
      title: 'Apply curation actions',
      description: [
        'Apply reversible edits in one transaction: hide/unhide turns, supersede older turns by a newer one,',
        'alias/unalias an entity name, block/unblock a false entity, write a note standing for source turns,',
        'and run_end to close the run and advance the cursor. Nothing is deleted and every action can be',
        'undone. Each action needs a reason (except run_end) and is checked on its own: a rejected one is',
        'reported with its error and does not stop the rest. Turns younger than the minimum age are refused.',
        'Use dry_run first.',
      ].join(' '),
      inputSchema: {
        run_id: z
          .string()
          .min(1)
          .max(100)
          .describe('One id for every call of this run, e.g. "curate-2026-09-11T0300Z".'),
        actions: z.array(curationActionSchema).min(1).max(CURATOR_LIMITS.maxPerCall),
        dry_run: z.boolean().optional().describe('Check every action and report; change nothing.'),
        actor: z.string().min(1).max(100).optional().describe('Who is curating, for the log; default mcp-curator.'),
      },
      kind: 'write',
      run: async (args) => {
        const { run_id, actions, dry_run, actor } = args as {
          run_id: string;
          actions: CurationAction[];
          dry_run?: boolean;
          actor?: string;
        };
        return engine.curateApply(run_id, actor ?? DEFAULT_ACTOR, actions, dry_run ?? false);
      },
    }),
    defineTool({
      name: 'zeromem_curate_undo',
      title: 'Undo curation',
      description: 'Undo one curation action (action_id) or every live action of a run (run_id), newest first.',
      inputSchema: {
        action_id: z.number().int().positive().optional(),
        run_id: z.string().min(1).optional(),
      },
      kind: 'write',
      run: async (args) => {
        const { action_id, run_id } = args as { action_id?: number; run_id?: string };
        if ((action_id === undefined) === (run_id === undefined)) {
          throw new Error('Give exactly one of action_id or run_id.');
        }
        return engine.curateUndo({ action_id, run_id }, DEFAULT_ACTOR);
      },
    }),
  ];
}
