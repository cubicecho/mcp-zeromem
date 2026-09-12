import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** The playbook is a doc first; the prompt serves it verbatim so the two cannot drift. */
export const PLAYBOOK_PATH = path.resolve(import.meta.dirname, '../../../docs/curator-playbook.md');

let playbook: string | null = null;

export function curatorPlaybook(): string {
  playbook ??= readFileSync(PLAYBOOK_PATH, 'utf8');
  return playbook;
}

/** `zeromem_curate`: the procedure for one curation run, for any MCP client to run on a schedule. */
export function registerCuratorPrompt(server: McpServer): void {
  server.registerPrompt(
    'zeromem_curate',
    {
      title: 'Curate the memory',
      description:
        'The procedure for one curation run with the zeromem_curate_* tools: find candidates since the last ' +
        'run, judge them conservatively, apply reversible edits and close the run.',
      argsSchema: {
        focus: z
          .string()
          .optional()
          .describe(
            'Kinds to work on this run, comma-separated: duplicates, noise, supersession, aliases, consolidation. ' +
              'All when omitted.',
          ),
      },
    },
    ({ focus }) => {
      const text = focus?.trim()
        ? `${curatorPlaybook()}\n\n## This run\n\nWork only on these kinds: ${focus.trim()}.`
        : curatorPlaybook();
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
    },
  );
}
