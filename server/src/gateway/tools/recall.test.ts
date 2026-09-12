import type { Evidence, StoredTurn } from '@mcp-zeromem/shared';
import { describe, expect, it } from 'vitest';
import { formatEvidenceText } from './recall.ts';

// 2026-09-10T23:30:00Z: late enough that a local-time date would roll over east of UTC.
const TS = Date.UTC(2026, 8, 10, 23, 30);

function hit(role: Evidence['role'], text: string, overrides: Partial<Evidence> = {}): Evidence {
  return {
    turn: { id: 1, uuid: 'u', session_id: 's1', speaker: 'user', text, ts: TS },
    score: 1,
    confidence: 1,
    role,
    ...overrides,
  };
}

function neighbour(id: number, speaker: string, text: string): StoredTurn {
  return { id, uuid: `u${id}`, session_id: 's1', speaker, text, ts: TS };
}

/** The text of one hit, without the header that precedes it. */
function bodyOf(block: string): string {
  return block.slice(block.indexOf(': ') + 2);
}

describe('formatEvidenceText', () => {
  it('is empty for no evidence', () => {
    expect(formatEvidenceText([])).toBe('');
  });

  it('writes one block per hit with the UTC date, speaker, session and turn id', () => {
    expect(formatEvidenceText([hit('primary', 'Maya owns billing.')])).toBe(
      '[primary] 2026-09-10 user (session s1, turn 1): Maya owns billing.',
    );
  });

  it('puts primary hits first and keeps rank order within each role', () => {
    const blocks = formatEvidenceText([
      hit('supporting', 'one'),
      hit('primary', 'two'),
      hit('supporting', 'three'),
      hit('primary', 'four'),
    ]).split('\n\n');
    expect(blocks.map(bodyOf)).toEqual(['two', 'four', 'one', 'three']);
    expect(blocks.map((block) => block.split(' ')[0])).toEqual([
      '[primary]',
      '[primary]',
      '[supporting]',
      '[supporting]',
    ]);
  });

  it('keeps the line breaks that carry the answer, so a list stays a list', () => {
    const answer = 'Here is the order:\n1. drain the queue\n2. roll the workers';
    expect(bodyOf(formatEvidenceText([hit('primary', answer)]))).toBe(answer);
  });

  it('drops carriage returns, trailing spaces and runs of blank lines', () => {
    const body = bodyOf(formatEvidenceText([hit('primary', '  first  \r\n\r\n\r\n\r\nsecond   \t\n  ')]));
    expect(body).toBe('first\n\nsecond');
  });

  it('does not mark text that fits, however close to the limit', () => {
    expect(bodyOf(formatEvidenceText([hit('primary', 'y'.repeat(500))], 500))).toBe('y'.repeat(500));
  });

  it('marks a real cut with what was kept and the call that returns the rest', () => {
    const body = bodyOf(formatEvidenceText([hit('primary', 'x'.repeat(600))], 500));
    expect(body).toBe(`${'x'.repeat(500)}\n… [clipped: 500 of 600 characters — zeromem_read_session {around_turn: 1}]`);
  });

  it('counts and cuts by code point, never splitting a surrogate pair', () => {
    const body = bodyOf(formatEvidenceText([hit('primary', '😀'.repeat(5))], 3));
    const kept = body.split('\n')[0] ?? '';
    expect([...kept]).toEqual(['😀', '😀', '😀']);
    expect(body).toContain('clipped: 3 of 5 characters');
  });

  it('renders attached neighbours around the hit, oldest first', () => {
    const text = formatEvidenceText([
      hit('primary', 'Here is the order:', {
        before: [neighbour(41, 'user', 'What are the deploy steps?')],
        after: [neighbour(43, 'assistant', 'Flip the flag last.')],
      }),
    ]);
    expect(text).toBe(
      [
        '[before] user (turn 41): What are the deploy steps?',
        '[primary] 2026-09-10 user (session s1, turn 1): Here is the order:',
        '[after] assistant (turn 43): Flip the flag last.',
      ].join('\n'),
    );
  });
});
