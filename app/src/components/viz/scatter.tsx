import type { Point2D, QueryPoint } from '@mcp-zeromem/shared';
import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { formatDateTime } from '@/lib/format';
import { excerpt, resolveColor, type SlotMap } from '@/lib/viz';
import { ChartTooltip, Swatch } from './tooltip';
import { useSize } from './use-size';

const MARKER = 4;
const PAD = 16;

/**
 * Turn vectors on the projection plane, drawn to a canvas so ten thousand
 * points stay cheap. Colour is the session (through the caller's slot
 * map); the query, when there is one, is a ringed diamond with its
 * nearest turns ringed too. Hover finds the nearest point.
 */
export function Scatter({
  points,
  query,
  colors,
  height = 480,
  onPick,
}: {
  points: Point2D[];
  query: QueryPoint | null;
  colors: SlotMap;
  height?: number;
  onPick?: (point: Point2D) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { width } = useSize(containerRef, { width: 800, height });
  const [hover, setHover] = useState<{ point: Point2D; x: number; y: number } | null>(null);

  const scale = useMemo(() => {
    const xs = points.map((p) => p.x).concat(query ? [query.x] : []);
    const ys = points.map((p) => p.y).concat(query ? [query.y] : []);
    const minX = Math.min(0, ...xs);
    const maxX = Math.max(0, ...xs);
    const minY = Math.min(0, ...ys);
    const maxY = Math.max(0, ...ys);
    const spanX = Math.max(1e-9, maxX - minX);
    const spanY = Math.max(1e-9, maxY - minY);
    const span = Math.max(spanX, spanY);
    const inner = Math.max(1, Math.min(width, height) - 2 * PAD);
    const offsetX = PAD + (width - 2 * PAD - inner) / 2;
    const offsetY = PAD + (height - 2 * PAD - inner) / 2;
    return {
      x: (v: number) => offsetX + ((v - minX + (span - spanX) / 2) / span) * inner,
      y: (v: number) => offsetY + inner - ((v - minY + (span - spanY) / 2) / span) * inner,
    };
  }, [points, query, width, height]);

  const neighbours = useMemo(() => new Set(query?.neighbours ?? []), [query]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const surface = resolveColor('var(--viz-surface)');
    const ink = resolveColor('var(--viz-ink)');
    const resolved = new Map<string, string>();
    const colorOf = (session: string) => {
      const reference = colors.color(session);
      let value = resolved.get(reference);
      if (!value) {
        value = resolveColor(reference);
        resolved.set(reference, value);
      }
      return value;
    };
    const dim = query !== null;
    for (const p of points) {
      const near = neighbours.has(p.turn_id);
      context.globalAlpha = dim && !near ? 0.35 : 0.9;
      context.fillStyle = colorOf(p.session_id);
      context.beginPath();
      context.arc(scale.x(p.x), scale.y(p.y), near ? MARKER + 1 : MARKER, 0, Math.PI * 2);
      context.fill();
      if (near || hover?.point.turn_id === p.turn_id) {
        context.globalAlpha = 1;
        context.lineWidth = 2;
        context.strokeStyle = near ? ink : surface;
        context.stroke();
      }
    }
    context.globalAlpha = 1;
    if (query) {
      const qx = scale.x(query.x);
      const qy = scale.y(query.y);
      context.fillStyle = ink;
      context.strokeStyle = surface;
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(qx, qy - 8);
      context.lineTo(qx + 8, qy);
      context.lineTo(qx, qy + 8);
      context.lineTo(qx - 8, qy);
      context.closePath();
      context.fill();
      context.stroke();
    }
  }, [points, query, colors, scale, width, height, neighbours, hover]);

  const nearest = (event: MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    let best: Point2D | null = null;
    let bestDistance = 12;
    for (const p of points) {
      const d = Math.hypot(scale.x(p.x) - px, scale.y(p.y) - py);
      if (d < bestDistance) {
        best = p;
        bestDistance = d;
      }
    }
    return { best, px, py };
  };

  return (
    <div ref={containerRef} className="relative w-full overflow-hidden rounded-md border" style={{ height }}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Embedding map of ${points.length} turns`}
        className="absolute inset-0"
        style={{ cursor: hover ? 'pointer' : 'default' }}
        onMouseMove={(event) => {
          const { best, px, py } = nearest(event);
          setHover(best ? { point: best, x: px, y: py } : null);
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(event) => {
          const { best } = nearest(event);
          if (best) {
            onPick?.(best);
          }
        }}
      />
      {query && (
        <div className="pointer-events-none absolute right-2 top-2 rounded-md border bg-popover/90 px-2 py-1 text-xs">
          <span aria-hidden className="mr-1 inline-block size-2 rotate-45 bg-foreground align-middle" /> query ·{' '}
          {neighbours.size} nearest ringed
        </div>
      )}
      <ChartTooltip position={hover ? { x: hover.x, y: hover.y } : null} width={width}>
        {hover && (
          <>
            <p className="flex items-center gap-1.5 font-medium">
              <Swatch color={colors.color(hover.point.session_id)} />
              <span className="truncate font-mono">{hover.point.session_id}</span>
            </p>
            <p className="text-muted-foreground">
              {hover.point.speaker} · {formatDateTime(hover.point.ts)} · #{hover.point.turn_id}
              {neighbours.has(hover.point.turn_id) ? ' · neighbour' : ''}
            </p>
            <p>{excerpt(hover.point.text)}</p>
          </>
        )}
      </ChartTooltip>
    </div>
  );
}
