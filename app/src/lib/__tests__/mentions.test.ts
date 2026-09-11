import { describe, expect, it } from 'vitest';
import { splitMentions } from '../mentions';

describe('splitMentions', () => {
  it('splits on byte offsets, handling multi-byte text', () => {
    const text = 'Zoë met Maya on 2024-05-01.';
    // "Zoë" is 4 bytes; "Maya" starts at byte 9.
    const spans = splitMentions(text, [
      { key: 'maya', kind: 'name', surface: 'Maya', start: 9, end: 13 },
      { key: '2024-05-01', kind: 'date', surface: '2024-05-01', start: 17, end: 27 },
      { key: 'zoë', kind: 'name', surface: 'Zoë', start: 0, end: 4 },
    ]);
    expect(spans.map((s) => s.text)).toEqual(['Zoë', ' met ', 'Maya', ' on ', '2024-05-01', '.']);
    expect(spans[0]?.mention?.kind).toBe('name');
    expect(spans[4]?.mention?.kind).toBe('date');
  });

  it('skips overlapping and out-of-range mentions', () => {
    const spans = splitMentions('abc', [
      { key: 'a', kind: 'name', surface: 'ab', start: 0, end: 2 },
      { key: 'b', kind: 'name', surface: 'bc', start: 1, end: 3 },
      { key: 'c', kind: 'name', surface: 'x', start: 10, end: 12 },
    ]);
    expect(spans.map((s) => s.text)).toEqual(['ab', 'c']);
  });

  it('returns the whole text when there are no mentions', () => {
    expect(splitMentions('plain', [])).toEqual([{ text: 'plain', mention: null }]);
  });
});
