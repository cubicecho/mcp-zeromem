import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * How much of the split one pane claims. The other takes the rest.
 *
 * Fixed rungs (`sm`/`md`/`lg`) are for an inspector — a thing whose useful width is set by its
 * contents, not by the window. Proportional rungs are for a second working surface that should
 * grow with the screen. `auto` is the icon strip: as wide as what is in it.
 *
 * The scale is named rungs rather than a free number because the widths it replaces were spelled
 * every way to hand — `60%`, `320px`, `2fr`, `22rem`, `3fr/2fr`, `1fr/4fr`, `minmax(16rem,20rem)`,
 * `min-content`, `w-56`, `w-72 lg:w-80`, `w-14 lg:w-56` — with no way to read which differences
 * were decisions and which were the nearest number at the time. A width that falls between two
 * rungs is a call site choosing the nearer one, not a case for a ninth rung.
 */
export type SplitWidth = 'auto' | 'sm' | 'md' | 'lg' | 'fifth' | 'two-fifths' | 'half' | 'two-thirds';

/**
 * `[the sized pane, the pane that takes the rest]` track sizes.
 *
 * Every track is `minmax(0,…)` rather than the `auto` a grid track floors itself at, because
 * `auto` floors it at its content: one wide table in one pane widens its own track and
 * shoves the other off the screen. This is the track-level half of rule 4 — `min-w-0` on the
 * cells is the item-level half, and both are needed, since a floored track still holds an
 * unfloored item that can overflow it.
 */
const TRACKS: Record<SplitWidth, [string, string]> = {
  auto: ['min-content', 'minmax(0,1fr)'],
  sm: ['minmax(0,20rem)', 'minmax(0,1fr)'],
  md: ['minmax(16rem,22rem)', 'minmax(0,1fr)'],
  lg: ['minmax(18rem,28rem)', 'minmax(0,1fr)'],
  fifth: ['minmax(0,1fr)', 'minmax(0,4fr)'],
  'two-fifths': ['minmax(0,2fr)', 'minmax(0,3fr)'],
  half: ['minmax(0,1fr)', 'minmax(0,1fr)'],
  'two-thirds': ['minmax(0,2fr)', 'minmax(0,1fr)'],
};

/**
 * The width below which the second pane stacks under the first instead of sitting beside it.
 *
 * Four literal classes rather than a composed one, per rule 3: Tailwind's scanner reads source
 * text, so `` `${bp}:grid-cols-…` `` names a class that is never generated. The *template* is the
 * part that is genuinely dynamic, so it rides a custom property, which CSS resolves at run time
 * and the scanner never has to see.
 */
const STACK_BELOW = {
  never: 'grid-cols-[var(--cube-split-cols)]',
  md: 'md:grid-cols-[var(--cube-split-cols)]',
  lg: 'lg:grid-cols-[var(--cube-split-cols)]',
  xl: 'xl:grid-cols-[var(--cube-split-cols)]',
} as const;

/**
 * The rule turns where the panes do: a hairline column between two panes side by side, a hairline
 * row between the same two stacked. Keyed by the same breakpoint as {@link STACK_BELOW} so the two
 * can never disagree about where the layout flips.
 */
const DIVIDER_AT: Record<keyof typeof STACK_BELOW, string> = {
  never: 'h-auto w-px',
  md: 'h-px w-full md:h-auto md:w-px',
  lg: 'h-px w-full lg:h-auto lg:w-px',
  xl: 'h-px w-full xl:h-auto xl:w-px',
};

/** What sits between the panes. A rule is drawn flush; space is drawn with nothing in it. */
const DIVIDERS = { space: 'gap-4', line: 'gap-0', none: 'gap-0' } as const;

/**
 * Which pane carries the width, and how much it claims. The other takes the rest.
 *
 * Two props rather than one, because a split has no main pane to measure from: naming the width
 * on the pane it applies to is the only spelling that stays true when the panes are equals. The
 * union is what stops both being set — the pair would then have to disagree about the leftover,
 * and one of them would have to silently lose.
 *
 * Neither set is an even split, which is the honest default for two surfaces with no ranking.
 */
type SplitWidths = { firstWidth?: SplitWidth; secondWidth?: never } | { firstWidth?: never; secondWidth?: SplitWidth };

type SplitLayoutProps = {
  /** The leading pane. Alone, it is the whole width, so a caller never special-cases un-split. */
  first: ReactNode;
  /**
   * The trailing pane.
   *
   * Absent, the layout is one full-width column and neither a second cell nor a divider is
   * drawn. That absence is also how a pane collapses — see the component note — which is why
   * there is no `collapsed` prop and no state held here.
   */
  second?: ReactNode;
  /**
   * Below this width the two stack rather than sit side by side. `never` keeps them side by side
   * at every width — an icon strip, a kiosk, a pane already inside a media query the caller owns.
   *
   * Stacking, not hiding, is the narrow-width answer: a phone has no room for two panes, but it
   * has room for one after the other. A screen where the second pane is genuinely meaningless on
   * a phone wants a separate route for it, not a pane that is present and off-screen.
   */
  stackBelow?: keyof typeof STACK_BELOW;
  /**
   * What separates the panes.
   *
   * - `space` — a gap. Two surfaces on a page, which is what most content splits are.
   * - `line` — flush, with a hairline rule between them. The app shell: a navigation column
   *   against a working surface. Every hand-written one draws this as a `border-r` on one pane,
   *   which is right until the layout stacks and the border becomes a line down one side of the
   *   screen instead of a line between the two panes.
   * - `none` — flush, nothing drawn. The panes carry their own edges.
   *
   * One prop rather than a `gap` and a `bordered`, because they are the same decision: a rule
   * with a gap on both sides is a line floating in the middle of nothing.
   */
  divider?: keyof typeof DIVIDERS;
  className?: string;
  firstClassName?: string;
  secondClassName?: string;
} & SplitWidths;

/**
 * Two surfaces side by side, as equals.
 *
 * The slots are numbered rather than named for a role or a side, because neither survives what
 * this component already does. A role pair (`content`/`sidebar`) is a lie about a genuinely even
 * split, and a side pair (`left`/`right`) is a lie below `stackBelow`, where the panes are above
 * and below, and again under RTL. `first` and `second` are true in every one of those: first in
 * reading order, wherever reading is going.
 *
 * {@link SidebarLayout} is this component with the roles put back, for the common case where one
 * pane is the screen and the other is beside it.
 *
 * The floors are the reason this is a component rather than a class string. A grid cell's
 * `min-width` is `auto`, so one wide child — a table, a long unbroken string — grows its track
 * and pushes the other pane off the screen instead of scrolling inside its own. `min-h-0` /
 * `min-w-0` on both cells is what makes a nested scroll container work at all, and it is the same
 * failure `HeaderContentFooter` guards in the other axis: there a wide child pushes the
 * chrome out of the column, here it pushes the neighbouring pane out of the row. Half the panes
 * this replaces are missing one or both.
 *
 * **It is not resizable, and that is a decision rather than a gap.** A draggable divider needs a
 * pointer handler and a stored width, and a stored width is state, which rule 8 keeps out of a
 * shell. The two ways to keep it out both fail on their own terms: expressing the drag in CSS
 * (`resize: horizontal`) gives a handle only a mouse can reach, and lifting the width out to
 * `firstWidth`/`onFirstWidthChange` still leaves the drag itself — behaviour — in here, to be
 * re-derived worse than `react-resizable-panels`, which shadcn already ships as `resizable`.
 * Rule 3 says do not wrap what shadcn ships; this is its other half, do not rebuild it either. A
 * screen that genuinely needs a draggable split is a screen for that primitive. None of the
 * eleven call sites this replaces has one.
 *
 * Because nothing drags, the divider is a rule and not a control: `aria-hidden`, no role, no tab
 * stop. A focus stop that does nothing when you press an arrow key is worse than no focus stop —
 * axe is satisfied and the keyboard user is standing in a dead end. The contrast is
 * `HeaderContentFooter`'s scrolling body, which takes a tab stop precisely because it
 * *does* something once you are there. Scrolling stays there too: a pane that needs to scroll is
 * a `StickyHeaderContentFooter` passed as `first` or `second`, so this shell adds no scroll
 * container of its own and no keyboard trap to go with it.
 *
 * **A collapsed pane is an absent one.** Every second pane eventually wants to close, and the
 * whole of that is `second={open ? nav : undefined}` — the caller already holds the toggle, and
 * the un-split layout is the full-width column that was needed anyway for the inspector with
 * nothing selected. A `collapsed` prop would buy a second way to say it and a piece of state to
 * keep in step with the first.
 *
 * **No `loading`.** `CardLayout` has one because a card has a single body and a precedence to
 * own (`loading` outranks `empty`). A split has neither: it has two panes that arrive at
 * different times, and one boolean across both has to either skeleton a pane that was never
 * waiting or pick one, which is a second prop. The prior art shows the failure directly — the
 * layout this is drawn from had a `loading` that replaced the entire chassis with a bare
 * skeleton, so chrome already on the screen blinked out and came back. Each pane's content owns
 * its own loading state, and a pane that is a `CardLayout` already has the word for it.
 *
 * **Horizontal only.** Stacking below `stackBelow` is the vertical arrangement, and a split that
 * is vertical at every width is two zones in a column with floors between them — which is
 * `HeaderContentFooter`, already. A vertical orientation here would be rule 7's exact bug:
 * a second implementation of a shape another shell owns.
 */
export function SplitLayout({
  first,
  second,
  firstWidth,
  secondWidth,
  stackBelow = 'lg',
  divider = 'space',
  className,
  firstClassName,
  secondClassName,
}: SplitLayoutProps) {
  const firstCell = (
    <div data-slot="split-layout-first" className={cn('min-h-0 min-w-0', firstClassName)}>
      {first}
    </div>
  );

  // Rule 5 — an absent slot draws nothing. Not an empty cell, and not a track whose gap is still
  // spent: with one pane there is one column and it has the whole width.
  if (!second) {
    return (
      <div data-slot="split-layout" className={cn('grid min-h-0 min-w-0 grid-cols-1', className)}>
        {firstCell}
      </div>
    );
  }

  // TRACKS reads `[the sized pane, the pane that takes the rest]`, so sizing the second pane is
  // the same row read backwards. Neither given, `half` is two even tracks.
  const [sized, rest] = TRACKS[secondWidth ?? firstWidth ?? 'half'];
  const tracks = secondWidth ? [rest, sized] : [sized, rest];
  // The rule gets a track of its own rather than a border on a cell, so that when the panes stack
  // it becomes a row between them instead of a line down one side of the screen.
  const columns = divider === 'line' ? [tracks[0], '1px', tracks[1]] : tracks;

  return (
    <div
      data-slot="split-layout"
      className={cn('grid min-h-0 min-w-0 grid-cols-1', DIVIDERS[divider], STACK_BELOW[stackBelow], className)}
      style={{ '--cube-split-cols': columns.join(' ') } as CSSProperties}
    >
      {firstCell}
      {divider === 'line' ? (
        <div
          data-slot="split-layout-divider"
          aria-hidden
          className={cn('self-stretch bg-border', DIVIDER_AT[stackBelow])}
        />
      ) : null}
      <div data-slot="split-layout-second" className={cn('min-h-0 min-w-0', secondClassName)}>
        {second}
      </div>
    </div>
  );
}

type SidebarLayoutProps = {
  /**
   * The main surface — the one the screen is about. Alone, it is the whole width, so a caller
   * never has to special-case the un-split state.
   */
  content: ReactNode;
  /**
   * The second surface: a navigation column, an inspector, a note list, an order panel.
   *
   * Absent, the pane is one full-width column and neither a sidebar cell nor a divider is drawn.
   */
  sidebar?: ReactNode;
  /** Which side the sidebar sits on. Stacked, it keeps this reading order rather than jumping. */
  sidebarPosition?: 'start' | 'end';
  /** {@link SplitWidth}. Naming the width is what stops eight call sites each inventing one. */
  sidebarWidth?: SplitWidth;
  stackBelow?: keyof typeof STACK_BELOW;
  divider?: keyof typeof DIVIDERS;
  className?: string;
  contentClassName?: string;
  sidebarClassName?: string;
};

/**
 * {@link SplitLayout} with the roles put back: a main surface, and a sidebar beside it.
 *
 * This is the common case and it is worth its own name — most splits are not even. `content` is
 * the main surface in every shell in this set (rule 2), and it keeps that meaning here, so the
 * pair reads the way it does everywhere else and the width is named for the pane a caller
 * actually thinks about: the sidebar.
 *
 * A preset rather than a second implementation, exactly as `StickyHeaderContentFooter` presets
 * `HeaderContentFooter`. When the two panes are genuinely comparable — a diff, two lists side by
 * side, a form beside its preview — reach for `SplitLayout` directly and its numbered slots,
 * rather than calling one of two equals the "sidebar".
 */
export function SidebarLayout({
  content,
  sidebar,
  sidebarPosition = 'end',
  sidebarWidth = 'sm',
  stackBelow = 'lg',
  divider = 'space',
  className,
  contentClassName,
  sidebarClassName,
}: SidebarLayoutProps) {
  // No sidebar is one pane, and `first` is the one that is there — passing an absent `first` with
  // a present `second` would be a hole in the middle of the grid.
  if (!sidebar) {
    return <SplitLayout first={content} firstClassName={contentClassName} className={className} />;
  }

  const atStart = sidebarPosition === 'start';

  return (
    <SplitLayout
      first={atStart ? sidebar : content}
      second={atStart ? content : sidebar}
      firstClassName={atStart ? sidebarClassName : contentClassName}
      secondClassName={atStart ? contentClassName : sidebarClassName}
      {...(atStart ? { firstWidth: sidebarWidth } : { secondWidth: sidebarWidth })}
      stackBelow={stackBelow}
      divider={divider}
      className={className}
    />
  );
}
