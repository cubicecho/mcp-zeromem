import { describe, expect, it } from 'vitest';
import { excerpt, formatTick, niceTicks, SlotMap, sequentialColor, seriesColor } from '../viz';

describe('SlotMap', () => {
  it('assigns slots in first-seen order and folds the tail into other', () => {
    const map = new SlotMap(['a', 'b', 'a', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    expect(map.slot('a')).toBe(1);
    expect(map.slot('h')).toBe(8);
    expect(map.slot('i')).toBe(0);
    expect(map.color('i')).toBe('var(--viz-other)');
    expect(map.color('c')).toBe(seriesColor(3));
    expect(map.legend()).toHaveLength(8);
    expect(map.overflow).toBe(2);
    expect(map.slot('unknown')).toBe(0);
  });
});

describe('scales', () => {
  it('picks clean ticks', () => {
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6]);
    expect(niceTicks(1234)).toEqual([0, 500, 1000]);
    expect(niceTicks(1)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it('formats ticks and excerpts', () => {
    expect(formatTick(1500)).toBe('1.5k');
    expect(formatTick(2_000_000)).toBe('2M');
    expect(formatTick(42)).toBe('42');
    expect(excerpt('a  b\nc', 10)).toBe('a b c');
    expect(excerpt('x'.repeat(20), 10)).toHaveLength(10);
    expect(sequentialColor(0)).toBe('var(--viz-seq-1)');
    expect(sequentialColor(1)).toBe('var(--viz-seq-7)');
  });
});
