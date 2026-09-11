import { describe, expect, it } from 'vitest';
import { parseJsonl } from './jsonl.ts';

describe('parseJsonl', () => {
  it('keeps the good lines and names the bad ones', () => {
    const text = [
      '{"session_id":"s","speaker":"user","text":"one","ts":1}',
      '',
      'not json',
      '{"session_id":"s","speaker":"user"}',
      '{"session_id":"s","speaker":"assistant","text":"two"}',
    ].join('\n');
    const parsed = parseJsonl(text);
    expect(parsed.turns.map((t) => t.text)).toEqual(['one', 'two']);
    expect(parsed.rejected.map((r) => r.line)).toEqual([3, 4]);
    expect(parsed.rejected[0]?.reason).toMatch(/not JSON/);
    expect(parsed.rejected[1]?.reason).toMatch(/text/);
  });
});
