/**
 * Colour by the job it does. Categorical slots are assigned in a fixed order
 * to entities that are the subject of a chart, never cycled: the ninth
 * series folds into "other". Values here are CSS custom properties from
 * `index.css`, so the same call works in SVG (`fill`) and, resolved through
 * `resolveColor`, on a canvas.
 */

export const SERIES_SLOTS = 8;

export function seriesColor(slot: number): string {
  return `var(--viz-series-${Math.min(SERIES_SLOTS, Math.max(1, slot))})`;
}

export const OTHER_COLOR = 'var(--viz-other)';

/** Entity kinds have a fixed slot each, so a name is the same hue on every page. */
export const ENTITY_KIND_SLOT = { name: 1, date: 2, quantity: 3, path: 4, symbol: 5, env: 6 } as const;

export function entityKindColor(kind: keyof typeof ENTITY_KIND_SLOT): string {
  return seriesColor(ENTITY_KIND_SLOT[kind]);
}

/**
 * A stable mapping from a list of keys (sessions, say) to slots, in the
 * order given; keys past the eighth share the "other" colour. Filtering the
 * list later must not repaint the survivors, so build this once from the
 * full list and look keys up, rather than rebuilding from the filtered one.
 */
export class SlotMap {
  private readonly slots = new Map<string, number>();

  constructor(keys: Iterable<string>) {
    for (const key of keys) {
      if (!this.slots.has(key)) {
        this.slots.set(key, this.slots.size + 1);
      }
    }
  }

  /** 1-based slot, or 0 for "other". */
  slot(key: string): number {
    const slot = this.slots.get(key) ?? 0;
    return slot > SERIES_SLOTS ? 0 : slot;
  }

  color(key: string): string {
    const slot = this.slot(key);
    return slot === 0 ? OTHER_COLOR : seriesColor(slot);
  }

  /** The keys that own a slot, in slot order; the rest are "other". */
  legend(): Array<{ key: string; color: string }> {
    return [...this.slots.entries()]
      .filter(([, slot]) => slot <= SERIES_SLOTS)
      .map(([key, slot]) => ({ key, color: seriesColor(slot) }));
  }

  get overflow(): number {
    return Math.max(0, this.slots.size - SERIES_SLOTS);
  }
}

/** One step of the sequential (single-hue) ramp for a value in [0, 1]. */
export function sequentialColor(t: number): string {
  const step = 1 + Math.round(Math.min(1, Math.max(0, t)) * 6);
  return `var(--viz-seq-${step})`;
}

/**
 * Resolve a `var(--x)` reference to the computed colour for canvas drawing;
 * canvas has no cascade. Cached per element and theme; call again after a
 * theme change (the token values differ per mode).
 */
export function resolveColor(reference: string, element: Element = document.documentElement): string {
  const match = /^var\((--[\w-]+)\)$/.exec(reference.trim());
  if (!match?.[1]) {
    return reference;
  }
  const value = getComputedStyle(element).getPropertyValue(match[1]).trim();
  return value || reference;
}

/** Clean tick values (1, 2, 5 × 10ⁿ) for an axis from 0 to `max`, about `count` of them. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) {
    return [0];
  }
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = (residual < 1.5 ? 1 : residual < 3 ? 2 : residual < 7 ? 5 : 10) * magnitude;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks;
}

/** Shorten a number for an axis: 1.2k, 3.4M. */
export function formatTick(n: number): string {
  if (Math.abs(n) >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (Math.abs(n) >= 1000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return new Intl.NumberFormat().format(n);
}

/** A short excerpt of a turn for a hover card. */
export function excerpt(text: string, chars = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat;
}
