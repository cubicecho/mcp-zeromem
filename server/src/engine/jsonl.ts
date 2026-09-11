import { type TurnInput, turnInputSchema } from '@mcp-zeromem/shared';

export interface ParsedJsonl {
  turns: TurnInput[];
  /** Lines that were not a turn: `line` is 1-based. */
  rejected: Array<{ line: number; reason: string }>;
}

/**
 * One turn per line, blank lines ignored. A bad line is reported by number
 * and skipped rather than failing the batch: a transcript export with one
 * malformed record in ten thousand should still land the other 9,999, and the
 * caller sees exactly which one did not.
 */
export function parseJsonl(text: string): ParsedJsonl {
  const turns: TurnInput[] = [];
  const rejected: ParsedJsonl['rejected'] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (err) {
      rejected.push({ line: i + 1, reason: `not JSON: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const parsed = turnInputSchema.safeParse(value);
    if (!parsed.success) {
      rejected.push({
        line: i + 1,
        reason: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
      });
      continue;
    }
    turns.push(parsed.data);
  }
  return { turns, rejected };
}
