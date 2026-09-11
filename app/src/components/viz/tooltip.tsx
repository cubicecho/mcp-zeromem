import type { ReactNode } from 'react';

export interface TooltipPosition {
  /** Pixel offsets inside the chart's positioned container. */
  x: number;
  y: number;
}

/**
 * The hover card every chart shares: a small surface pinned near the pointer,
 * flipped to the left when it would run off the right edge. Text in it wears
 * text tokens; identity comes from a swatch, never from coloured text.
 */
export function ChartTooltip({
  position,
  width,
  children,
}: {
  position: TooltipPosition | null;
  width: number;
  children: ReactNode;
}) {
  if (!position) {
    return null;
  }
  const flip = position.x > width * 0.6;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 max-w-64 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
      style={{
        left: flip ? undefined : position.x + 12,
        right: flip ? width - position.x + 12 : undefined,
        top: Math.max(0, position.y - 12),
      }}
    >
      {children}
    </div>
  );
}

export function Swatch({ color, shape = 'square' }: { color: string; shape?: 'square' | 'line' }) {
  return (
    <span
      aria-hidden
      className={
        shape === 'line' ? 'inline-block h-0.5 w-3 align-middle' : 'inline-block size-2.5 rounded-[2px] align-middle'
      }
      style={{ background: color }}
    />
  );
}
