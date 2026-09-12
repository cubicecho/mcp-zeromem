import type { SessionWindow, StoredTurn } from '@mcp-zeromem/shared';
import { describe, expect, it } from 'vitest';
import { formatWindowText } from './session.ts';

// 2026-09-10T23:30:00Z: late enough that a local-time date would roll over east of UTC.
const TS = Date.UTC(2026, 8, 10, 23, 30);

function turn(id: number, speaker: string, text: string): StoredTurn {
  return { id, uuid: `u${id}`, session_id: 's1', speaker, text, ts: TS };
}

function window(turns: StoredTurn[], overrides: Partial<SessionWindow> = {}): SessionWindow {
  return { session_id: 's1', turns, total: turns.length, offset: 0, truncated: false, ...overrides };
}

describe('formatWindowText', () => {
  it('writes a header and one block per turn, in conversation order', () => {
    expect(formatWindowText(window([turn(1, 'user', 'first'), turn(2, 'assistant', 'second')]))).toBe(
      ['session s1: turns 1–2 of 2', '[turn 1] 2026-09-10 user: first', '[turn 2] 2026-09-10 assistant: second'].join(
        '\n',
      ),
    );
  });

  it('reports where a page sits and how to reach the rest', () => {
    const text = formatWindowText(window([turn(4, 'user', 'here')], { total: 30, offset: 3, truncated: true }));
    expect(text.split('\n')[0]).toBe('session s1: turns 4–4 of 30 (more; page on with `offset`)');
  });

  it('says so plainly when a window holds nothing', () => {
    expect(formatWindowText(window([], { total: 0 }))).toBe('session s1: turns 0–0 of 0');
  });

  it('marks the turn the window was centred on', () => {
    const text = formatWindowText(
      window([turn(1, 'user', 'before'), turn(2, 'assistant', 'the one')], { around_turn: 2 }),
    );
    expect(text.split('\n').slice(1)).toEqual([
      '[turn 1] 2026-09-10 user: before',
      '→ [turn 2] 2026-09-10 assistant: the one',
    ]);
  });

  it('never clips, however long the turn — this is what a clipped hit points at', () => {
    const long = 'x'.repeat(50_000);
    const text = formatWindowText(window([turn(1, 'assistant', long)]));
    expect(text).toContain(long);
    expect(text).not.toContain('clipped');
  });

  it('keeps the line breaks that carry the answer and drops the noise around them', () => {
    const text = formatWindowText(window([turn(1, 'assistant', '  drain the queue  \r\n\r\n\r\n\r\nroll on   \t\n ')]));
    expect(text.split('\n').slice(1)).toEqual(['[turn 1] 2026-09-10 assistant: drain the queue', '', 'roll on']);
  });
});
