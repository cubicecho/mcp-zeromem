import { useMemo, useRef, useState } from 'react';
import { formatTick, niceTicks, seriesColor } from '@/lib/viz';
import { Legend } from './legend';
import { ChartTooltip, Swatch } from './tooltip';
import { useSize } from './use-size';

export interface ColumnSeries {
  key: string;
  label: string;
  slot: number;
  values: number[];
}

/**
 * Magnitude per category: grouped columns at most 24px wide with a 4px
 * rounded data end, a 2px surface gap between neighbours, and a per-mark
 * tooltip whose hit target spans the whole category column.
 */
export function ColumnChart({
  categories,
  series,
  height = 220,
  formatValue = formatTick,
  ariaLabel,
}: {
  categories: string[];
  series: ColumnSeries[];
  height?: number;
  formatValue?: (value: number) => string;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useSize(ref, { width: 640, height });
  const [hover, setHover] = useState<number | null>(null);

  const margin = { top: 8, right: 12, bottom: 24, left: 44 };
  const innerWidth = Math.max(1, width - margin.left - margin.right);
  const innerHeight = Math.max(1, height - margin.top - margin.bottom);
  const max = useMemo(() => Math.max(0, ...series.flatMap((s) => s.values)), [series]);
  const ticks = niceTicks(max);
  const top = ticks.at(-1) ?? 1;
  const n = categories.length;
  const slotWidth = innerWidth / Math.max(1, n);
  const barWidth = Math.min(24, Math.max(2, (slotWidth * 0.7) / Math.max(1, series.length) - 2));
  const groupWidth = series.length * (barWidth + 2) - 2;
  const yAt = (v: number) => margin.top + innerHeight - (top === 0 ? 0 : (v / top) * innerHeight);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(innerWidth / 72))));
  const legend = series.map((s) => ({ key: s.key, label: s.label, color: seriesColor(s.slot) }));

  return (
    <div className="flex flex-col gap-2">
      <Legend items={legend} />
      <div ref={ref} className="relative w-full" style={{ height }}>
        <svg role="img" aria-label={ariaLabel} width={width} height={height} className="absolute inset-0">
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={margin.left}
                x2={width - margin.right}
                y1={yAt(t)}
                y2={yAt(t)}
                stroke={t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'}
                strokeWidth={1}
              />
              <text x={margin.left - 8} y={yAt(t) + 3} textAnchor="end" fontSize={10} fill="var(--viz-muted)">
                {formatValue(t)}
              </text>
            </g>
          ))}
          {categories.map((category, i) => {
            const cx = margin.left + slotWidth * i + slotWidth / 2;
            return (
              <g key={category}>
                {i % labelEvery === 0 || i === n - 1 ? (
                  <text x={cx} y={height - 8} textAnchor="middle" fontSize={10} fill="var(--viz-muted)">
                    {category}
                  </text>
                ) : null}
                {series.map((s, si) => {
                  const v = s.values[i] ?? 0;
                  const x = cx - groupWidth / 2 + si * (barWidth + 2);
                  const y = yAt(v);
                  const h = Math.max(0, yAt(0) - y);
                  const r = Math.min(4, h, barWidth / 2);
                  const d =
                    h === 0
                      ? ''
                      : `M${x},${yAt(0)}V${y + r}a${r},${r} 0 0 1 ${r},-${r}h${barWidth - 2 * r}a${r},${r} 0 0 1 ${r},${r}V${yAt(0)}Z`;
                  return <path key={s.key} d={d} fill={seriesColor(s.slot)} />;
                })}
                {hover === i && (
                  <rect
                    x={margin.left + slotWidth * i}
                    y={margin.top}
                    width={slotWidth}
                    height={innerHeight}
                    fill="var(--viz-muted)"
                    fillOpacity={0.08}
                  />
                )}
                {/* biome-ignore lint/a11y/noStaticElementInteractions: hover-only tooltip target; the table view is the accessible twin */}
                <rect
                  x={margin.left + slotWidth * i}
                  y={margin.top}
                  width={slotWidth}
                  height={innerHeight}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              </g>
            );
          })}
        </svg>
        <ChartTooltip
          position={hover === null ? null : { x: margin.left + slotWidth * hover + slotWidth / 2, y: margin.top }}
          width={width}
        >
          <p className="mb-1 font-medium">{categories[hover ?? 0]}</p>
          {series.map((s) => (
            <p key={s.key} className="flex items-center gap-1.5">
              <Swatch color={seriesColor(s.slot)} />
              <span className="text-muted-foreground">{s.label}</span>
              <span className="ml-auto pl-3 tabular-nums">{formatValue(s.values[hover ?? 0] ?? 0)}</span>
            </p>
          ))}
        </ChartTooltip>
      </div>
    </div>
  );
}
