import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * How each heading level is drawn.
 *
 * The level is a prop rather than a hardcoded tag because this block is the same shape at three
 * depths and only the caller knows which one it is in: `<h1>` is right for the page it names and
 * wrong inside a card that already sits under one, and `<h2>` is the reverse. A shell that picks
 * for you is wrong on half the screens, and a shell that takes `title={<h1 className="…">…}` has
 * handed the size back to the caller — which is the drift, not the fix. The same page `<h1>` is
 * `text-lg`, `text-xl`, `text-2xl` and `text-3xl` in four of these projects, and two headers in
 * *one* project disagree with each other. This map is what ends that.
 *
 * - `row` is the floor under the title row. It holds the row to one height whether or not the
 *   page has an action and whether or not it has a description, so `content` beneath it starts
 *   at the same place on every page.
 * - `bar` is the height of one line of `title`, so a loading header is exactly as tall as the
 *   header it becomes.
 *
 * A literal map, per rule 3 — every class here is a class Tailwind can find in this file.
 */
const LEVELS = {
  1: { heading: 'h1', title: 'text-xl', icon: '[&_svg]:size-5', row: 'min-h-14', bar: 'h-7' },
  2: { heading: 'h2', title: 'text-lg', icon: '[&_svg]:size-5', row: 'min-h-12', bar: 'h-7' },
  3: { heading: 'h3', title: 'text-base', icon: '[&_svg]:size-4', row: 'min-h-10', bar: 'h-6' },
} as const;

type PageHeaderProps = {
  /**
   * The row under the title block: a search field, a filter row, a set of tabs — stacked, each
   * on its own line, in the order they are passed.
   *
   * One slot rather than `search`, `filters` and `tabs`. The prior art grew all three, plus a
   * `searchZone` and an `actionsZone` escape hatch beside two of them, and three of those five
   * words have one live call site between them. They buy nothing the order of the nodes does not
   * already say, and none of them poses a question for the shell to settle the way `loading` and
   * `empty` do on a card. A word added to this vocabulary is added to every component in the set.
   *
   * It is also what decides the rule under the header — see the component comment.
   */
  content?: ReactNode;
  /**
   * What the page is called. Required, because a header with no title is a toolbar, and a
   * toolbar is a row of nodes the caller can place without help. It is also the heading
   * assistive technology navigates the page by.
   *
   * A node, not a string: a title composed from a verb and an entity ("Edit Workspace") is composed
   * by the caller. The prior art derived that inside the component from `useLocation()`, which
   * is routing in a shell — rule 8 — and it renders "Edit undefined" when the guess is wrong.
   */
  title: ReactNode;
  /**
   * One line on what the page is for. It wraps; it is not clipped.
   *
   * `text-sm text-muted-foreground` is the one thing every hand-written header in these apps
   * already agrees on, so the only question left was truncation — and the headers that truncate
   * are the ones that lose the end of the sentence with no way to read it.
   */
  description?: ReactNode;
  /**
   * Sits before the title, sized from the level. Pass a bare `<Users />`, not a sized one.
   *
   * Also where a status dot goes. Four of these apps put a coloured dot, a live indicator or a
   * category swatch in front of a title, each at its own size and its own muted colour.
   */
  icon?: ReactNode;
  /**
   * The header's far end: the page's buttons, a status pill, a menu. A fragment of them is fine
   * — the shell rows and gaps them, so two pages never disagree about the space between New and
   * Import, and a caller never has to know whether this slot wraps its children (in one app it
   * does and in its sibling it does not, which is why their spacing differs by 4px).
   *
   * They sit here rather than beside the search field, so a page with no search puts them where
   * a page with one does.
   */
  action?: ReactNode;
  /**
   * The line above the title: a breadcrumb trail, or a back link, which is a one-step trail.
   *
   * A slot rather than the caller's own node above the header, because that node would not carry
   * the header's inset, and a trail starting 16px left of the title it belongs to is exactly the
   * drift this set exists to stop.
   *
   * Above the title, not beside it. Both placements are in use; above is the one that also holds
   * a trail, and a back button beside the title competes with `icon` for the same spot and takes
   * width from the page's name for a control that is not part of it. It is a node, not a route —
   * no shell routes.
   */
  breadcrumbs?: ReactNode;
  /**
   * Whether the title is still being fetched. On, a bar of the title's own height stands in for
   * it — and for the description, when one was passed — so the page beneath does not jump when
   * the name lands.
   *
   * The jump is real and it is invisible on a warm cache: one detail page in these apps replaces
   * its whole header with a single muted "Loading…" line, so a cold load swaps 16px of text for
   * a heading, a back button and two buttons, and everything below it moves.
   *
   * The same word `CardLayout` uses, and deliberately not the same target. A card keeps its real
   * title while loading, because a card's title is a fact about the screen and only its body is
   * waiting. A page header's title usually *is* what the request returned, so here the title is
   * the part that waits — and everything that does not depend on the fetch (the trail, the
   * buttons, the search field) is left alone and stays usable while it does.
   *
   * A caller wanting its own placeholder passes it as `title`, which is a node, and leaves this
   * off. What it should not do is hand-roll a bar per page: that is how two pages end up jumping
   * by different amounts.
   */
  loading?: boolean;
  /**
   * Which heading this is. `1` names a page; `2` names a section, a pane in a split, or a card
   * that already sits under a page title; `3` goes a level below that. See {@link LEVELS}.
   */
  level?: keyof typeof LEVELS;
  className?: string;
  titleClassName?: string;
  contentClassName?: string;
};

/**
 * The title block a page wears in a header slot.
 *
 * Every list page in these apps writes this out: a name, a line under it, the page's buttons at
 * the far end, and a search or filter row beneath. Written out each time, they disagree about
 * all of it — the same `<h1>` is four different sizes across four projects and two different
 * sizes inside one of them, it is `font-semibold` in three and `font-bold` in the fourth, the
 * description truncates on the detail pages and wraps everywhere else, and "what happens to a
 * long title next to three buttons" has four answers, one of which is "nothing".
 *
 * **The padding seam.** {@link HeaderContentFooter} deliberately leaves its header slot unpadded
 * and gives the body `px-4`, because the page header carries its own inset — this component is
 * the one that comment means. So the inset lives here, exactly once, and the two edges line up
 * beneath a `width="page"` chassis.
 *
 * The other model, where a `<main>` owns the inset and the header inherits it, is what the rest
 * of these apps do, and it is why one route in one of them is inset 12px while every other page
 * is 16px: the page shell merged a caller's `className` over its own padding and nobody saw.
 * Dropped into a chassis that already pads, this header passes `className="px-0"` and the seam
 * stays owned by exactly one of the two.
 *
 * The *cap* does not live here. The prior art applied `PAGE_COLUMN` in both places so a header
 * dropped somewhere else still read as a page header, but that makes a header inside a
 * `width="full"` chassis cap itself while the body under it does not — the header contradicting
 * the chassis it was handed. The chassis owns the column, the header owns the inset, and each
 * seam is decided in one file.
 *
 * **Narrow widths.** The title row wraps rather than stacking at a breakpoint: the title block
 * asks for 16rem, and when that plus the action will not fit on one line, the action drops to
 * its own. A breakpoint is the wrong instrument, because the variable is how wide the *action*
 * is, not how wide the window is — one header here has a search field and two buttons in its
 * action and was squeezing its title at 1100px, which no phone breakpoint would have caught,
 * and another is a pane inside a split, narrow on a wide screen.
 *
 * The title wraps; it does not truncate. A card title truncates because it is one of many on a
 * screen that gives it context — a page title *is* the context, and half of one names nothing.
 */
export function PageHeader({
  content,
  title,
  description,
  icon,
  action,
  breadcrumbs,
  loading = false,
  level = 1,
  className,
  titleClassName,
  contentClassName,
}: PageHeaderProps) {
  const { heading: Heading, title: titleSize, icon: iconSize, row: rowFloor, bar: barHeight } = LEVELS[level];

  // The rule these apps already follow without having named it: a page header draws a line under
  // itself exactly when nothing else separates it from the body. The list headers, which all
  // carry a search row, draw none. The edit headers, the detail pages and one app's whole page
  // shell — none of which has anything between the title and the first field — all grew one by
  // hand, in three different border colours. Deriving it here decides it once instead of per
  // screen, and a caller who disagrees says so in one class: `className="border-b-0"`.
  //
  // Level 1 only. A section heading inside a card sits above a body the card has already fenced,
  // and not one of the section headings in these apps draws a second line.
  const rule = level === 1 && !content ? 'border-b' : undefined;

  return (
    // `px-4` is the seam: the body of a `width="page"` chassis carries the same, and nothing else
    // in this tree adds to it, so the title sits above the body's first column.
    <div
      data-slot="page-header"
      aria-busy={loading || undefined}
      className={cn('flex min-w-0 flex-col gap-3 px-4 py-4', rule, className)}
    >
      {breadcrumbs ? (
        <div data-slot="page-header-breadcrumbs" className="min-w-0">
          {breadcrumbs}
        </div>
      ) : null}

      <div
        data-slot="page-header-title-row"
        className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2', rowFloor)}
      >
        {/* `basis-64` is the threshold, and the only number here that is a judgement rather than
            a measurement: the title keeps at least 16rem or the action wraps under it. `min-w-0`
            is what then lets the block shrink below its longest word. */}
        <div data-slot="page-header-titles" className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <Heading
            data-slot="page-header-title"
            className={cn('flex min-w-0 items-center gap-2 font-semibold tracking-tight', titleSize, titleClassName)}
          >
            {icon ? (
              // Sized here rather than by the caller, so an icon passed as `<Users />` and one
              // passed as `<Users className="size-6" />` land at the same size — and so the size
              // follows the level instead of being guessed once per page.
              <span className={cn('shrink-0 text-muted-foreground', iconSize)}>{icon}</span>
            ) : null}
            {loading ? (
              <>
                {/* The heading keeps a name while it waits. A heading whose only child is a
                    decorative bar is an empty heading, which axe reports and which leaves a
                    screen reader nothing to land on between the trail and the buttons. */}
                <span className="sr-only">Loading…</span>
                <Skeleton className={cn('w-48 max-w-full', barHeight)} aria-hidden />
              </>
            ) : (
              // `break-words` is what a title does when it runs out of room — an unbroken id or
              // url otherwise holds the block above its floor and pushes the action off the edge.
              <span className="min-w-0 break-words">{title}</span>
            )}
          </Heading>

          {description ? (
            loading ? (
              <Skeleton data-slot="page-header-description" className="h-5 w-72 max-w-full" aria-hidden />
            ) : (
              <p data-slot="page-header-description" className="text-muted-foreground text-sm">
                {description}
              </p>
            )
          ) : null}
        </div>

        {action ? (
          <div data-slot="page-header-action" className="flex shrink-0 flex-wrap items-center gap-2">
            {action}
          </div>
        ) : null}
      </div>

      {content ? (
        <div data-slot="page-header-content" className={cn('flex min-w-0 flex-col gap-2', contentClassName)}>
          {content}
        </div>
      ) : null}
    </div>
  );
}
