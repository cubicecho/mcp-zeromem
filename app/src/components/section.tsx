import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type SectionProps = {
  /** The body: the fields, the rows, whatever the heading is over. */
  content?: ReactNode;
  /** The overline. A short noun phrase — "Pomodoro", "Danger zone", "Notifications". */
  title?: ReactNode;
  /** One line under the title, in sentence case, on what the group is for. */
  description?: ReactNode;
  /** The heading row's far end: an add button, a count, a switch that disables the group. */
  action?: ReactNode;
  /** A hairline under the heading. Off by default; on, the group reads as one block. */
  divider?: boolean;
  className?: string;
  titleClassName?: string;
  contentClassName?: string;
};

/**
 * A heading over a group of fields or rows.
 *
 * The smallest thing in this registry, and it is here because it is the one three projects wrote
 * separately and got *almost* the same: `text-xs font-semibold uppercase` and a muted foreground
 * in all three, then `tracking-wider` in one and `tracking-wide` in another, and a `border-b pb-1`
 * in the third. Nobody copied anybody — they each typed the same five tokens from memory, which
 * is why the sixth is different. That is the failure mode a shared token has no answer for, since
 * the value being retyped *is* a class list.
 *
 * It draws no surface. Philotes wraps its sections in a `Card` and the other two do not, so the
 * card stays a decision at the call site — this is a label and a gap, and `CardLayout` is the one
 * that owns a border and a padding box. It is also not `PageHeader`: that is the single `h1` at
 * the top of a route, and there are many of these per screen.
 *
 * No state, no data, no `children` — the body is `content`, like every other shell here.
 */
export function Section({
  content,
  title,
  description,
  action,
  divider = false,
  className,
  titleClassName,
  contentClassName,
}: SectionProps) {
  const hasHeading = Boolean(title || description || action);

  return (
    <section data-slot="section" className={cn('min-w-0 space-y-3', className)}>
      {hasHeading ? (
        <div data-slot="section-heading" className={cn('flex min-w-0 items-center gap-2', divider && 'border-b pb-1')}>
          <div className="min-w-0 flex-1">
            {title ? (
              // `h2` rather than a styled `div`: these are the sections of a page, and a screen
              // reader's heading list is how a form of thirty fields is navigated at all. The
              // level is fixed on purpose — `PageHeader` owns the `h1`, so this is always the
              // one below it, and a `level` prop would be an invitation to get that wrong.
              <h2
                data-slot="section-title"
                className={cn(
                  'truncate font-semibold text-muted-foreground text-xs uppercase tracking-wider',
                  titleClassName,
                )}
              >
                {title}
              </h2>
            ) : null}
            {description ? (
              <p data-slot="section-description" className="mt-1 text-muted-foreground text-sm">
                {description}
              </p>
            ) : null}
          </div>
          {action ? (
            <div data-slot="section-action" className="shrink-0">
              {action}
            </div>
          ) : null}
        </div>
      ) : null}

      {content ? (
        <div data-slot="section-content" className={cn('min-w-0 space-y-4', contentClassName)}>
          {content}
        </div>
      ) : null}
    </section>
  );
}
