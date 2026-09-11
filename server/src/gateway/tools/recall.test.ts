import type { Evidence } from '@mcp-zeromem/shared';
import { describe, expect, it } from 'vitest';
import { formatEvidenceText } from './recall.ts';

// 2026-09-10T23:30:00Z: late enough that a local-time date would roll over east of UTC.
const TS = Date.UTC(2026, 8, 10, 23, 30);

function hit(role: Evidence['role'], text: string, overrides: Partial<Evidence['turn']> = {}): Evidence {
  return {
    turn: { id: 1, uuid: 'u', session_id: 's1', speaker: 'user', text, ts: TS, ...overrides },
    score: 1,
    confidence: 1,
    role,
  };
}

describe('formatEvidenceText', () => {
  it('is empty for no evidence', () => {
    expect(formatEvidenceText([])).toBe('');
  });

  it('writes one line per hit with the UTC date, speaker and session', () => {
    expect(formatEvidenceText([hit('primary', 'Maya owns billing.')])).toBe(
      '[primary] 2026-09-10 user (session s1): Maya owns billing.',
    );
  });

  it('puts primary hits first and keeps rank order within each role', () => {
    const lines = formatEvidenceText([
      hit('supporting', 'one'),
      hit('primary', 'two'),
      hit('supporting', 'three'),
      hit('primary', 'four'),
    ]).split('\n');
    expect(lines.map((line) => line.split(': ')[1])).toEqual(['two', 'four', 'one', 'three']);
    expect(lines.map((line) => line.split(' ')[0])).toEqual(['[primary]', '[primary]', '[supporting]', '[supporting]']);
  });

  it('collapses whitespace so a hit stays on one line', () => {
    expect(formatEvidenceText([hit('primary', '  first\n\n  second\tthird  ')])).toMatch(/: first second third$/);
  });

  it('cuts long text at 500 characters with an ellipsis', () => {
    const line = formatEvidenceText([hit('primary', 'x'.repeat(600))]);
    const text = line.slice(line.indexOf(': ') + 2);
    expect(text).toBe(`${'x'.repeat(500)}…`);
    expect(formatEvidenceText([hit('primary', 'y'.repeat(500))])).toMatch(/: y{500}$/);
  });
});
