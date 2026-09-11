import { type MouseEvent, type ReactNode, useMemo, useRef, useState } from 'react';
import { formatTick, niceTicks, seriesColor } from '@/lib/viz';
import { Legend } from './legend';
import { ChartTooltip, Swatch } from './tooltip';
import { useSize } from './use-size';

export interface LineSeries {
  key: string;
  label: string;
  /** 1-based palette slot; series are given slots in a fixed order by the caller. */
  slot: number;
  /** One value per x position; null leaves a gap. */
  values: Array<number | null>;
  /** Fill 10% under the line (single-series totals read well this way). */
  area?: boolean;
}

/**
 * Change over time: 2px lines on a hairline grid, a crosshair that snaps to
 * the nearest x and a tooltip listing every series there. Every series
 * shares the one y axis, so callers only combine measures with one unit.
 */
export function LineChart({
  x,
  series,
  height = 220,
  formatX,
  formatValue = formatTick,
  ariaLabel,
}: {
  /** Labels for each x position, in order. */
  x: string[];
  series: LineSeries[];
  height?: number;
  formatX?: (label: string, index: number) => string;
  formatValue?: (value: number) => string;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useSize(ref, { width: 640, height });
  const [hover, setHover] = useState<number | null>(null);

  const margin = { top: 8, right: 12, bottom: 24, left: 44 };
  const innerWidth = Math.max(1, width - margin.left - margin.right);
  const innerHeight = Math.max(1, height - margin.top - margin.bottom);

  const max = useMemo(() => Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0))), [series]);
  const ticks = niceTicks(max);
  const top = ticks.at(-1) ?? 1;
  const n = x.length;
  const xAt = (i: number) => margin.left + (n <= 1 ? innerWidth / 2 : (i / (n - 1)) * innerWidth);
  const yAt = (v: number) => margin.top + innerHeight - (top === 0 ? 0 : (v / top) * innerHeight);

  // Path strings are cheap to rebuild; memoising them would need every scale input as a dependency.
  const paths = series.map((s) => {
    let line = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      line += `${pen ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`;
      pen = true;
    });
    const first = s.values.findIndex((v) => v !== null);
    const last = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v !== null);
    const area =
      s.area && first >= 0
        ? `${line}L${xAt(last).toFixed(1)},${yAt(0).toFixed(1)}L${xAt(first).toFixed(1)},${yAt(0).toFixed(1)}Z`
        : null;
    return { line, area };
  });

  const onMove = (event: MouseEvent<SVGSVGElement>) => {
    if (n === 0) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left - margin.left;
    const i = n <= 1 ? 0 : Math.round((px / innerWidth) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  };

  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(innerWidth / 72))));
  const legend = series.map((s) => ({ key: s.key, label: s.label, color: seriesColor(s.slot) }));

  return (
    <div className="flex flex-col gap-2">
      <Legend items={legend} shape="line" />
      <div ref={ref} className="relative w-full" style={{ height }}>
        <svg
          role="img"
          aria-label={ariaLabel}
          width={width}
          height={height}
          className="absolute inset-0"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
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
          {x.map((label, i) =>
            i % labelEvery === 0 || i === n - 1 ? (
              <text
                key={label}
                x={xAt(i)}
                y={height - 8}
                textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
                fontSize={10}
                fill="var(--viz-muted)"
              >
                {formatX ? formatX(label, i) : label}
              </text>
            ) : null,
          )}
          {series.map((s, si) => (
            <g key={s.key}>
              {paths[si]?.area && <path d={paths[si].area} fill={seriesColor(s.slot)} fillOpacity={0.1} />}
              <path
                d={paths[si]?.line}
                fill="none"
                stroke={seriesColor(s.slot)}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          ))}
          {hover !== null && (
            <g>
              <line
                x1={xAt(hover)}
                x2={xAt(hover)}
                y1={margin.top}
                y2={margin.top + innerHeight}
                stroke="var(--viz-axis)"
                strokeWidth={1}
              />
              {series.map((s) => {
                const v = s.values[hover];
                return v === null || v === undefined ? null : (
                  <circle
                    key={s.key}
                    cx={xAt(hover)}
                    cy={yAt(v)}
                    r={4}
                    fill={seriesColor(s.slot)}
                    stroke="var(--viz-surface)"
                    strokeWidth={2}
                  />
                );
              })}
            </g>
          )}
        </svg>
        <ChartTooltip position={hover === null ? null : { x: xAt(hover), y: margin.top }} width={width}>
          <p className="mb-1 font-medium">{formatX ? formatX(x[hover ?? 0] ?? '', hover ?? 0) : x[hover ?? 0]}</p>
          {series.map((s) => {
            const v = s.values[hover ?? 0];
            return (
              <p key={s.key} className="flex items-center gap-1.5">
                <Swatch color={seriesColor(s.slot)} shape="line" />
                <span className="text-muted-foreground">{s.label}</span>
                <span className="ml-auto pl-3 tabular-nums">
                  {v === null || v === undefined ? '–' : formatValue(v)}
                </span>
              </p>
            );
          })}
        </ChartTooltip>
      </div>
    </div>
  );
}

/** A tiny single-series line with no axes, for a stat card. */
export function Sparkline({
  values,
  slot = 1,
  width = 96,
  height = 28,
  label,
}: {
  values: Array<number | null>;
  slot?: number;
  width?: number;
  height?: number;
  label: string;
}): ReactNode {
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  const n = values.length;
  const d = values
    .map((v, i) => {
      if (v === null) {
        return '';
      }
      const px = n <= 1 ? width / 2 : (i / (n - 1)) * width;
      const py = height - 2 - (v / max) * (height - 4);
      return `${i === 0 || values[i - 1] === null ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join('');
  return (
    <svg role="img" aria-label={label} width={width} height={height} className="block">
      <path d={d} fill="none" stroke={seriesColor(slot)} strokeWidth={2} strokeLinejoin="round" />
    </svg>
  );
}
