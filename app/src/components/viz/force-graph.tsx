import type { EntityKind, GraphSnapshot } from '@mcp-zeromem/shared';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { type MouseEvent, useEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import { formatCount, formatDateTime } from '@/lib/format';
import { entityKindColor, resolveColor } from '@/lib/viz';
import { ChartTooltip, Swatch } from './tooltip';
import { useSize } from './use-size';

interface Node extends SimulationNodeDatum {
  id: string;
  kind: EntityKind;
  turns: number;
  degree: number;
  first_ts: number;
  last_ts: number;
  r: number;
}

interface Link extends SimulationLinkDatum<Node> {
  turns: number;
}

interface View {
  scale: number;
  tx: number;
  ty: number;
}

const LABELLED_NODES = 24;

function radius(degree: number, maxDegree: number): number {
  return 4 + 12 * Math.sqrt(Math.max(0, degree) / Math.max(1, maxDegree));
}

/**
 * The entity graph on a canvas: a d3-force layout, node size by degree,
 * edge width by co-occurrence, colour by entity kind. Labels go on the
 * most connected nodes and whatever is hovered or selected, not on all of
 * them. Wheel zooms, drag pans, click selects.
 */
export function ForceGraph({
  snapshot,
  selected,
  onSelect,
  height = 520,
}: {
  snapshot: GraphSnapshot;
  selected: string | null;
  onSelect: (entity: string | null) => void;
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { width } = useSize(containerRef, { width: 800, height });
  const [hover, setHover] = useState<{ node: Node; x: number; y: number } | null>(null);
  const viewRef = useRef<View>({ scale: 1, tx: 0, ty: 0 });
  const simulationRef = useRef<Simulation<Node, Link> | null>(null);
  const nodesRef = useRef<Node[]>([]);
  const linksRef = useRef<Link[]>([]);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const hoverRef = useRef<Node | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const { nodes, links } = useMemo(() => {
    const maxDegree = Math.max(1, ...snapshot.nodes.map((n) => n.degree));
    const previous = new Map(nodesRef.current.map((n) => [n.id, n]));
    const nodes: Node[] = snapshot.nodes.map((n) => ({
      ...previous.get(n.entity),
      id: n.entity,
      kind: n.kind,
      turns: n.turns,
      degree: n.degree,
      first_ts: n.first_ts,
      last_ts: n.last_ts,
      r: radius(n.degree, maxDegree),
    }));
    const ids = new Set(nodes.map((n) => n.id));
    const links: Link[] = snapshot.edges
      .filter((e) => ids.has(e.a) && ids.has(e.b))
      .map((e) => ({ source: e.a, target: e.b, turns: e.turns }));
    return { nodes, links };
  }, [snapshot]);

  useEffect(() => {
    nodesRef.current = nodes;
    linksRef.current = links;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d') ?? null;
    const maxEdge = Math.max(1, ...links.map((l) => l.turns));

    const draw = () => {
      if (!canvas || !context) {
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      const view = viewRef.current;
      const colors = {
        edge: resolveColor('var(--viz-axis)'),
        surface: resolveColor('var(--viz-surface)'),
        ink: resolveColor('var(--viz-ink)'),
        muted: resolveColor('var(--viz-muted)'),
        name: resolveColor(entityKindColor('name')),
        date: resolveColor(entityKindColor('date')),
        quantity: resolveColor(entityKindColor('quantity')),
        path: resolveColor(entityKindColor('path')),
        symbol: resolveColor(entityKindColor('symbol')),
        env: resolveColor(entityKindColor('env')),
      };
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.translate(view.tx, view.ty);
      context.scale(view.scale, view.scale);

      const focus = hoverRef.current?.id ?? selectedRef.current;
      const neighbours = new Set<string>();
      if (focus) {
        for (const l of linksRef.current) {
          const s = l.source as Node;
          const t = l.target as Node;
          if (s.id === focus) {
            neighbours.add(t.id);
          } else if (t.id === focus) {
            neighbours.add(s.id);
          }
        }
      }

      context.lineCap = 'round';
      for (const l of linksRef.current) {
        const s = l.source as Node;
        const t = l.target as Node;
        if (s.x === undefined || s.y === undefined || t.x === undefined || t.y === undefined) {
          continue;
        }
        const touches = focus !== null && (s.id === focus || t.id === focus);
        context.strokeStyle = colors.edge;
        context.globalAlpha = focus === null ? 0.6 : touches ? 0.9 : 0.15;
        context.lineWidth = (1 + 3 * (l.turns / maxEdge)) / view.scale;
        context.beginPath();
        context.moveTo(s.x, s.y);
        context.lineTo(t.x, t.y);
        context.stroke();
      }

      const byDegree = [...nodesRef.current].sort((a, b) => b.degree - a.degree);
      const labelled = new Set(byDegree.slice(0, LABELLED_NODES).map((n) => n.id));
      for (const n of nodesRef.current) {
        if (n.x === undefined || n.y === undefined) {
          continue;
        }
        const dim = focus !== null && n.id !== focus && !neighbours.has(n.id);
        context.globalAlpha = dim ? 0.25 : 1;
        context.fillStyle = colors[n.kind];
        context.beginPath();
        context.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        context.fill();
        context.lineWidth = 2 / view.scale;
        context.strokeStyle = n.id === selectedRef.current ? colors.ink : colors.surface;
        context.stroke();
      }
      context.globalAlpha = 1;
      context.font = `${11 / view.scale}px system-ui, sans-serif`;
      context.textBaseline = 'middle';
      for (const n of nodesRef.current) {
        if (n.x === undefined || n.y === undefined) {
          continue;
        }
        const show = n.id === focus || neighbours.has(n.id) || (focus === null && labelled.has(n.id));
        if (!show) {
          continue;
        }
        context.fillStyle = colors.ink;
        context.fillText(n.id, n.x + n.r + 3 / view.scale, n.y);
      }
    };

    simulationRef.current?.stop();
    const simulation = forceSimulation<Node, Link>(nodes)
      .force(
        'link',
        forceLink<Node, Link>(links)
          .id((d) => d.id)
          .distance((l) => 30 + 40 / Math.sqrt(l.turns))
          .strength((l) => Math.min(1, 0.2 + l.turns / maxEdge)),
      )
      .force(
        'charge',
        forceManyBody<Node>().strength((d) => -30 - d.r * 6),
      )
      .force('center', forceCenter(width / 2, height / 2))
      .force(
        'collide',
        forceCollide<Node>((d) => d.r + 2),
      )
      .on('tick', draw);
    simulationRef.current = simulation;
    // Repaint on hover/selection changes without restarting the layout.
    const canvasElement = canvas;
    const repaint = () => draw();
    canvasElement?.addEventListener('repaint', repaint);
    return () => {
      simulation.stop();
      canvasElement?.removeEventListener('repaint', repaint);
    };
  }, [nodes, links, width, height]);

  const repaint = () => canvasRef.current?.dispatchEvent(new Event('repaint'));

  const toGraph = (event: MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const view = viewRef.current;
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    return { px, py, gx: (px - view.tx) / view.scale, gy: (py - view.ty) / view.scale };
  };

  const nodeAt = (gx: number, gy: number): Node | null => {
    let best: Node | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const n of nodesRef.current) {
      if (n.x === undefined || n.y === undefined) {
        continue;
      }
      const d = Math.hypot(n.x - gx, n.y - gy);
      const hit = Math.max(n.r + 2, 12 / viewRef.current.scale);
      if (d <= hit && d < bestDistance) {
        best = n;
        bestDistance = d;
      }
    }
    return best;
  };

  const onMouseMove = (event: MouseEvent<HTMLCanvasElement>) => {
    const { px, py, gx, gy } = toGraph(event);
    if (drag.current) {
      const dx = px - drag.current.x;
      const dy = py - drag.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) {
        drag.current.moved = true;
      }
      viewRef.current = { ...viewRef.current, tx: viewRef.current.tx + dx, ty: viewRef.current.ty + dy };
      drag.current = { x: px, y: py, moved: drag.current.moved };
      repaint();
      return;
    }
    const node = nodeAt(gx, gy);
    if (node !== hoverRef.current) {
      hoverRef.current = node;
      setHover(node ? { node, x: px, y: py } : null);
      repaint();
    } else if (node) {
      setHover({ node, x: px, y: py });
    }
  };

  const onMouseDown = (event: MouseEvent<HTMLCanvasElement>) => {
    const { px, py } = toGraph(event);
    drag.current = { x: px, y: py, moved: false };
  };

  const onMouseUp = (event: MouseEvent<HTMLCanvasElement>) => {
    const moved = drag.current?.moved ?? false;
    drag.current = null;
    if (moved) {
      return;
    }
    const { gx, gy } = toGraph(event);
    const node = nodeAt(gx, gy);
    onSelect(node ? (node.id === selected ? null : node.id) : null);
  };

  const onWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    const { px, py } = toGraph(event);
    const view = viewRef.current;
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    const scale = Math.min(8, Math.max(0.2, view.scale * factor));
    // Keep the point under the cursor fixed.
    viewRef.current = {
      scale,
      tx: px - ((px - view.tx) / view.scale) * scale,
      ty: py - ((py - view.ty) / view.scale) * scale,
    };
    repaint();
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: a selection change only needs a repaint
  useEffect(() => {
    repaint();
  }, [selected]);

  return (
    <div ref={containerRef} className="relative w-full overflow-hidden rounded-md border" style={{ height }}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Entity graph with ${formatCount(snapshot.nodes.length)} entities and ${formatCount(snapshot.edges.length)} edges`}
        className="absolute inset-0"
        style={{ cursor: hover ? 'pointer' : drag.current ? 'grabbing' : 'grab' }}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseLeave={() => {
          drag.current = null;
          hoverRef.current = null;
          setHover(null);
          repaint();
        }}
        onWheel={onWheel}
      />
      <ChartTooltip position={hover ? { x: hover.x, y: hover.y } : null} width={width}>
        {hover && (
          <>
            <p className="flex items-center gap-1.5 font-medium">
              <Swatch color={entityKindColor(hover.node.kind)} />
              {hover.node.id}
              <span className="font-normal text-muted-foreground">{hover.node.kind}</span>
            </p>
            <p className="text-muted-foreground">
              {formatCount(hover.node.turns)} turns · {formatCount(hover.node.degree)} connections
            </p>
            <p className="text-muted-foreground">
              {formatDateTime(hover.node.first_ts)} → {formatDateTime(hover.node.last_ts)}
            </p>
          </>
        )}
      </ChartTooltip>
    </div>
  );
}
