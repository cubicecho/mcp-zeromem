import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ZodRawShape, z } from 'zod';

/** Each prompt is a doc first; the prompt serves it verbatim so the two cannot drift. */
const DOCS_DIR = path.resolve(import.meta.dirname, '../../../docs');

const docs = new Map<string, string>();

function doc(file: string): string {
  const cached = docs.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const text = readFileSync(path.join(DOCS_DIR, file), 'utf8');
  docs.set(file, text);
  return text;
}

/**
 * What a client gets when the write tools are gated away: the reading and the
 * judging are still worth doing, and the actions it would have applied are what
 * a person needs in order to apply them.
 */
const READ_ONLY = [
  '## This server is read-only',
  '',
  'The write tools (`zeromem_curate_apply`, `zeromem_curate_undo`) are not served here, so nothing you',
  'decide can be applied and there is no run to close. Read and judge as the procedure says, then reply',
  'with the actions you would have applied — each as the object `zeromem_curate_apply` takes, with its',
  'reason — for a person to apply.',
].join('\n');

interface CuratorPrompt {
  name: string;
  title: string;
  description: string;
  /** The file under `docs/` this prompt serves. */
  doc: string;
  argsSchema: ZodRawShape;
  /** What this call, rather than the procedure, is about; appended as a section. */
  thisRun: (args: Record<string, string | undefined>) => string | null;
}

function section(...lines: string[]): string {
  return ['## This run', '', ...lines].join('\n');
}

/**
 * One procedure per prompt, so a curator that has a job already — a session
 * that just ended, an entity someone disputed, an episode worth a note — reads
 * that job's rules and not the whole sweep. `zeromem_curate` remains the full
 * run, and every focused prompt hands the sweep's cursor back untouched.
 */
const PROMPTS: CuratorPrompt[] = [
  {
    name: 'zeromem_curate',
    title: 'Curate the memory',
    description:
      'The procedure for one curation run with the zeromem_curate_* tools: find candidates since the last ' +
      'run, judge them conservatively, apply reversible edits and close the run.',
    doc: 'curator-playbook.md',
    argsSchema: {
      focus: z
        .string()
        .optional()
        .describe(
          'Kinds to work on this run, comma-separated: duplicates, noise, supersession, aliases, consolidation. ' +
            'All when omitted.',
        ),
    },
    thisRun: ({ focus }) => (focus?.trim() ? section(`Work only on these kinds: ${focus.trim()}.`) : null),
  },
  {
    name: 'zeromem_curate_session',
    title: 'Curate one session',
    description:
      'The procedure for curating a single conversation once it has ended: read the session whole, hide its ' +
      'noise and repeats, supersede what it settled later, note it if it is long, and leave the sweep cursor ' +
      'where it was.',
    doc: 'curator-session.md',
    argsSchema: {
      session_id: z.string().describe('The session to curate, e.g. the conversation that just ended.'),
    },
    thisRun: ({ session_id }) => {
      const id = session_id?.trim();
      return id ? section(`Curate session \`${id}\`, and no other. Nothing outside it is yours this run.`) : null;
    },
  },
  {
    name: 'zeromem_curate_notes',
    title: 'Write curator notes',
    description:
      'The procedure for consolidating long old episodes into notes: find them, read them whole, write a ' +
      'paragraph that says only what the sources say, and check it after applying.',
    doc: 'curator-notes.md',
    argsSchema: {
      session_id: z
        .string()
        .optional()
        .describe('Consolidate this session only. Every candidate episode when omitted.'),
    },
    thisRun: ({ session_id }) => {
      const id = session_id?.trim();
      return id
        ? section(`Work on session \`${id}\` only: take its turns as the episode and skip the candidate sweep.`)
        : null;
    },
  },
  {
    name: 'zeromem_curate_entities',
    title: 'Curate the entity index',
    description:
      'The procedure for entity hygiene: fold a name into the entity it belongs to (alias) and strike out a ' +
      'name that is not one (block), judging each pair by the turns that mention both.',
    doc: 'curator-entities.md',
    argsSchema: {
      entity: z.string().optional().describe('One entity name to settle, e.g. "Maya". The whole index when omitted.'),
    },
    thisRun: ({ entity }) => {
      const name = entity?.trim();
      return name ? section(`Settle \`${name}\` and the names that appear beside it; skip the candidate sweep.`) : null;
    },
  },
];

export interface PromptOptions {
  /** The write tools are gated away, so a run cannot be applied or closed. */
  readOnly?: boolean;
}

/** The curator's prompts: the full sweep and one procedure per focused job. */
export function registerCuratorPrompts(server: McpServer, options: PromptOptions = {}): void {
  for (const prompt of PROMPTS) {
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema: prompt.argsSchema },
      (args: Record<string, string | undefined>) => {
        const text = [doc(prompt.doc), prompt.thisRun(args ?? {}), options.readOnly ? READ_ONLY : null]
          .filter((part): part is string => part !== null)
          .join('\n\n');
        return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
      },
    );
  }
}
