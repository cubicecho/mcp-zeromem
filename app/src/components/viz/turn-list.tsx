import type { Mention, TurnWithEntities } from '@mcp-zeromem/shared';
import { formatDateTime } from '@/lib/format';
import { splitMentions } from '@/lib/mentions';
import { entityKindColor } from '@/lib/viz';

/**
 * A turn's text with its entity mentions marked: a coloured underline per
 * kind (the same fixed slots the graph uses), a stronger one for the entity
 * the page is following. Clicking a mention hands its key back.
 */
export function TurnText({
  text,
  entities,
  highlight,
  onEntityClick,
}: {
  text: string;
  entities: Mention[];
  highlight?: string;
  onEntityClick?: (key: string) => void;
}) {
  const spans = splitMentions(text, entities);
  return (
    <p className="whitespace-pre-wrap text-sm">
      {spans.map((span, index) =>
        span.mention ? (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional
            key={index}
            type="button"
            title={`${span.mention.kind}: ${span.mention.key}`}
            data-entity={span.mention.key}
            className={
              span.mention.key === highlight
                ? 'rounded-sm bg-accent px-0.5 font-medium underline decoration-2 underline-offset-2'
                : 'rounded-sm px-0.5 underline decoration-2 underline-offset-2 hover:bg-accent'
            }
            style={{ textDecorationColor: entityKindColor(span.mention.kind) }}
            onClick={() => onEntityClick?.(span.mention?.key ?? '')}
          >
            {span.text}
          </button>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional
          <span key={index}>{span.text}</span>
        ),
      )}
    </p>
  );
}

export function TurnList({
  turns,
  highlight,
  onEntityClick,
  selected,
}: {
  turns: TurnWithEntities[];
  highlight?: string;
  onEntityClick?: (key: string) => void;
  /** Turn ids to frame, for a brushed range or a recall's evidence. */
  selected?: ReadonlySet<number>;
}) {
  if (turns.length === 0) {
    return <p className="text-sm text-muted-foreground">No turns.</p>;
  }
  return (
    <ol className="flex flex-col gap-3">
      {turns.map((turn) => (
        <li
          key={turn.uuid}
          id={`turn-${turn.id}`}
          className={selected?.has(turn.id) ? 'rounded-md border-l-2 border-primary pl-3' : 'pl-3.5'}
        >
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{turn.speaker}</span> · {formatDateTime(turn.ts)} ·{' '}
            <span className="font-mono">#{turn.id}</span>
          </p>
          <TurnText text={turn.text} entities={turn.entities} highlight={highlight} onEntityClick={onEntityClick} />
        </li>
      ))}
    </ol>
  );
}
