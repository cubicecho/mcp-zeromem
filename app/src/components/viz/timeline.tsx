import type { HierarchySegment, HierarchySession } from '@mcp-zeromem/shared';
import { type MouseEvent, useRef, useState } from 'react';
import { formatCount, formatDateTime } from '@/lib/format';
import { ChartTooltip, Swatch } from './tooltip';
import { useSize } from './use-size';

export interface TimeRange {
  since: number;
  until: number;
}

const LANE = 26;
const GAP = 4;
const LABEL_WIDTH = 150;
const AXIS_HEIGHT = 24;
const MARGIN_RIGHT = 12;

export const WINDOW_COLOR = 'var(--viz-seq-2)';
export const EPISODE_COLOR = 'var(--viz-seq-5)';

interface Hovered {
  session: HierarchySession;
  level: 'window' | 'episode' | 'session';
  segment: HierarchySegment | null;
  x: number;
  y: number;
}

/** Tick times across a span, about six of them, on clean boundaries. */
function timeTicks(since: number, until: number): number[] {
  const span = Math.max(1, until - since);
  const steps = [
    60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000, 86_400_000, 604_800_000, 2_592_000_000, 31_536_000_000,
  ];
  const step = steps.find((s) => span / s <= 8) ?? steps[steps.length - 1] ?? 86_400_000;
  const ticks: number[] = [];
  for (let t = Math.ceil(since / step) * step; t <= until; t += step) {
    ticks.push(t);
  }
  return ticks;
}

function formatTick(t: number, span: number): string {
  const date = new Date(t);
  if (span <= 2 * 86_400_000) {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

/**
 * Sessions as lanes on one time axis; inside each, the windows the engine
 * cut it into as light bands and the episodes within them as darker
 * segments. One hue, deeper for the finer level. Drag across the plot to
 * brush a range; click a lane to pick a session.
 */
export function Timeline({
  sessions,
  range,
  brush,
  onBrush,
  selected,
  onSelect,
}: {
  sessions: HierarchySession[];
  /** The visible span. */
  range: TimeRange;
  brush: TimeRange | null;
  onBrush: (range: TimeRange | null) => void;
  selected: string | null;
  onSelect: (sessionId: string | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useSize(ref, { width: 800, height: 100 });
  const [hover, setHover] = useState<Hovered | null>(null);
  const drag = useRef<{ x0: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState<TimeRange | null>(null);

  const plotWidth = Math.max(1, width - LABEL_WIDTH - MARGIN_RIGHT);
  const height = AXIS_HEIGHT + sessions.length * (LANE + GAP);
  const span = Math.max(1, range.until - range.since);
  const xAt = (t: number) => LABEL_WIDTH + ((t - range.since) / span) * plotWidth;
  const tAt = (px: number) => range.since + ((px - LABEL_WIDTH) / plotWidth) * span;
  const clampX = (px: number) => Math.min(LABEL_WIDTH + plotWidth, Math.max(LABEL_WIDTH, px));

  const localX = (event: MouseEvent<SVGSVGElement>) => event.clientX - event.currentTarget.getBoundingClientRect().left;
  const localY = (event: MouseEvent<SVGSVGElement>) => event.clientY - event.currentTarget.getBoundingClientRect().top;

  const onMouseDown = (event: MouseEvent<SVGSVGElement>) => {
    const x = localX(event);
    if (x < LABEL_WIDTH) {
      return;
    }
    drag.current = { x0: clampX(x), moved: false };
  };

  const onMouseMove = (event: MouseEvent<SVGSVGElement>) => {
    if (drag.current) {
      const x = clampX(localX(event));
      if (Math.abs(x - drag.current.x0) > 3) {
        drag.current.moved = true;
        const a = tAt(Math.min(x, drag.current.x0));
        const b = tAt(Math.max(x, drag.current.x0));
        setDragging({ since: a, until: b });
      }
    }
  };

  const onMouseUp = (event: MouseEvent<SVGSVGElement>) => {
    const state = drag.current;
    drag.current = null;
    if (!state) {
      return;
    }
    if (state.moved && dragging) {
      onBrush(dragging);
      setDragging(null);
      return;
    }
    setDragging(null);
    const lane = Math.floor((localY(event) - AXIS_HEIGHT) / (LANE + GAP));
    const session = sessions[lane];
    if (session) {
      onSelect(session.session_id === selected ? null : session.session_id);
    } else {
      onBrush(null);
    }
  };

  const ticks = timeTicks(range.since, range.until);
  const active = dragging ?? brush;

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      <svg
        role="img"
        aria-label={`Timeline of ${formatCount(sessions.length)} sessions`}
        width={width}
        height={height}
        className="absolute inset-0 select-none"
        style={{ cursor: dragging ? 'col-resize' : 'crosshair' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => {
          drag.current = null;
          setDragging(null);
          setHover(null);
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={xAt(t)} x2={xAt(t)} y1={AXIS_HEIGHT - 4} y2={height} stroke="var(--viz-grid)" strokeWidth={1} />
            <text x={xAt(t)} y={AXIS_HEIGHT - 8} textAnchor="middle" fontSize={10} fill="var(--viz-muted)">
              {formatTick(t, span)}
            </text>
          </g>
        ))}
        {sessions.map((session, lane) => {
          const y = AXIS_HEIGHT + lane * (LANE + GAP);
          const isSelected = session.session_id === selected;
          return (
            <g key={session.session_id}>
              {isSelected && (
                <rect x={0} y={y - 2} width={width} height={LANE + 4} fill="var(--viz-muted)" fillOpacity={0.1} />
              )}
              <text
                x={LABEL_WIDTH - 8}
                y={y + LANE / 2 + 3}
                textAnchor="end"
                fontSize={11}
                fontFamily="ui-monospace, monospace"
                fill={isSelected ? 'var(--viz-ink)' : 'var(--viz-ink-2)'}
              >
                {session.session_id.length > 18 ? `${session.session_id.slice(0, 17)}…` : session.session_id}
              </text>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: hover-only tooltip target; the table view is the accessible twin */}
              <rect
                x={xAt(session.first_ts)}
                y={y + LANE / 2 - 1}
                width={Math.max(2, xAt(session.last_ts) - xAt(session.first_ts))}
                height={2}
                fill="var(--viz-axis)"
                onMouseEnter={(event) =>
                  setHover({ session, level: 'session', segment: null, x: event.clientX, y: event.clientY })
                }
                onMouseLeave={() => setHover(null)}
              />
              {session.windows.map((w) => (
                // biome-ignore lint/a11y/noStaticElementInteractions: hover-only tooltip target; the table view is the accessible twin
                <rect
                  key={`w-${w.first_turn_id}`}
                  x={xAt(w.start_ts)}
                  y={y + 2}
                  width={Math.max(3, xAt(w.end_ts) - xAt(w.start_ts))}
                  height={LANE - 4}
                  rx={2}
                  fill={WINDOW_COLOR}
                  stroke="var(--viz-surface)"
                  strokeWidth={2}
                  onMouseEnter={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setHover({ session, level: 'window', segment: w, x: rect.left, y: rect.top });
                  }}
                  onMouseLeave={() => setHover(null)}
                />
              ))}
              {session.episodes.map((e) => (
                // biome-ignore lint/a11y/noStaticElementInteractions: hover-only tooltip target; the table view is the accessible twin
                <rect
                  key={`e-${e.first_turn_id}`}
                  x={xAt(e.start_ts)}
                  y={y + 7}
                  width={Math.max(3, xAt(e.end_ts) - xAt(e.start_ts))}
                  height={LANE - 14}
                  rx={2}
                  fill={EPISODE_COLOR}
                  stroke="var(--viz-surface)"
                  strokeWidth={2}
                  onMouseEnter={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setHover({ session, level: 'episode', segment: e, x: rect.left, y: rect.top });
                  }}
                  onMouseLeave={() => setHover(null)}
                />
              ))}
            </g>
          );
        })}
        {active && (
          <rect
            x={xAt(active.since)}
            y={AXIS_HEIGHT - 4}
            width={Math.max(1, xAt(active.until) - xAt(active.since))}
            height={height - AXIS_HEIGHT + 4}
            fill="var(--viz-series-1)"
            fillOpacity={0.12}
            stroke="var(--viz-series-1)"
            strokeWidth={1}
            pointerEvents="none"
          />
        )}
      </svg>
      <ChartTooltip
        position={
          hover && ref.current
            ? {
                x: hover.x - ref.current.getBoundingClientRect().left,
                y: hover.y - ref.current.getBoundingClientRect().top,
              }
            : null
        }
        width={width}
      >
        {hover && (
          <>
            <p className="flex items-center gap-1.5 font-medium">
              <Swatch
                color={
                  hover.level === 'episode'
                    ? EPISODE_COLOR
                    : hover.level === 'window'
                      ? WINDOW_COLOR
                      : 'var(--viz-axis)'
                }
              />
              {hover.level} · <span className="font-mono">{hover.session.session_id}</span>
            </p>
            {hover.segment ? (
              <>
                <p className="text-muted-foreground">
                  {formatDateTime(hover.segment.start_ts)} → {formatDateTime(hover.segment.end_ts)}
                </p>
                <p className="text-muted-foreground">
                  {formatCount(hover.segment.turns)} turns · #{hover.segment.first_turn_id}–#
                  {hover.segment.last_turn_id}
                </p>
                {hover.segment.entities.length > 0 && (
                  <p className="text-muted-foreground">{hover.segment.entities.slice(0, 6).join(', ')}</p>
                )}
              </>
            ) : (
              <p className="text-muted-foreground">
                {formatCount(hover.session.turns)} turns · {formatCount(hover.session.windows.length)} windows ·{' '}
                {formatCount(hover.session.episodes.length)} episodes
              </p>
            )}
          </>
        )}
      </ChartTooltip>
    </div>
  );
}
