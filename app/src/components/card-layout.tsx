import type { ReactNode } from 'react';
import { Children } from 'react';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type CardLayoutProps = {
  /** The body. */
  content?: ReactNode;
  /** A string, a heading, whatever names the card. Absent, no header row is drawn. */
  title?: ReactNode;
  /** One line on what the card holds, or what changing it costs. */
  description?: ReactNode;
  /** Sits before the title, sized to the text. An icon, a status dot, an avatar. */
  icon?: ReactNode;
  /** The header's far end: an add button, a menu, a switch. */
  action?: ReactNode;
  /** Shown instead of `content` when there is nothing in it — an empty list, no results. */
  empty?: ReactNode;
  /**
   * Whether the body is still being fetched. On, a skeleton stands in for it and `empty` is not
   * consulted — data that has not arrived is not data that came back empty, and a card that says
   * "no members yet" for half a second before showing four of them is worse than one that waits.
   *
   * A caller wanting its own placeholder passes it as `content` and leaves this off.
   */
  loading?: boolean;
  /** The footer's start. A timestamp, a note, a destructive action held away from the rest. */
  footer?: ReactNode;
  /** The footer's end. The buttons. Given alone, the footer is simply right-aligned. */
  footerActions?: ReactNode;
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
};

/**
 * A card with its slots already placed.
 *
 * The shape is the one every card in these apps arrives at on its own — an icon and a title, a
 * line of description under it, an action at the far end of the header, a body, and a footer
 * that holds the buttons — and writing it out each time is how they drift: some put the action
 * beside the title and some under it, some give the description a `text-sm` and some a `text-xs`,
 * and a card with nothing to show says so in a different voice on every screen.
 *
 * Every slot is a node, `content` included, so a card is one element at the call site and the
 * question "where does this go?" has one answer per prop. `empty` and `loading` are the two that
 * are not slots the caller places: they are what the body says when the data came back empty, and
 * while it has not come back at all. A list rendered from a `map` reaches the first state on its
 * own the moment its array is empty.
 */
export function CardLayout({
  content,
  title,
  description,
  icon,
  action,
  empty,
  loading = false,
  footer,
  footerActions,
  className,
  headerClassName,
  contentClassName,
  footerClassName,
}: CardLayoutProps) {
  // `Children.count` rather than a truth test: `{items.map(…)}` on an empty array is an empty
  // array, not null, and it is the shape a card is nearly always handed.
  const isEmpty = Children.count(content) === 0;
  const body = loading ? <CardLayoutSkeleton /> : isEmpty && empty ? empty : content;

  const hasHeader = Boolean(title || description || action);
  const hasFooter = Boolean(footer || footerActions);

  return (
    <Card data-slot="card-layout" className={className}>
      {hasHeader ? (
        <CardHeader className={headerClassName}>
          {title ? (
            <CardTitle className="flex min-w-0 items-center gap-2">
              {icon ? (
                // Sized here rather than by the caller, so an icon passed as `<Plus />` and one
                // passed as `<Plus className="size-4" />` land at the same size.
                <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>
              ) : null}
              {/* The padding is what stops `truncate` clipping the title: `CardTitle` is
                  `leading-none`, so the line box is exactly 1em and `overflow: hidden` cuts the
                  ascenders and descenders off it. The negative margin gives the space back, so
                  the header keeps the height shadcn drew it at. */}
              <span className="-my-1 min-w-0 truncate py-1">{title}</span>
            </CardTitle>
          ) : null}
          {description ? <CardDescription>{description}</CardDescription> : null}
          {/* CardAction places itself in the header grid's second column; it needs no wrapper. */}
          {action ? <CardAction>{action}</CardAction> : null}
        </CardHeader>
      ) : null}

      {/* The header keeps its real title while loading: only the part that is waiting waits. */}
      {body ? <CardContent className={cn('min-w-0', contentClassName)}>{body}</CardContent> : null}

      {hasFooter ? (
        <CardFooter
          className={cn(footer && footerActions && 'justify-between', !footer && 'justify-end', footerClassName)}
        >
          {footer}
          {footerActions ? <div className="flex items-center gap-2">{footerActions}</div> : null}
        </CardFooter>
      ) : null}
    </Card>
  );
}

/**
 * Three bars at the widths a paragraph or a short list settles at, so the card holds roughly the
 * height its content will and the page does not jump when the data lands.
 */
function CardLayoutSkeleton() {
  return (
    <div data-slot="card-layout-skeleton" className="space-y-2" aria-hidden>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}
