import type { ComponentProps, ReactNode, Ref } from 'react';

import { type HeaderContentFooter, StickyHeaderContentFooter } from '@/components/header-content-footer';
import { PageHeader } from '@/components/page-header';

type PageHeaderProps = ComponentProps<typeof PageHeader>;

type PageLayoutProps = {
  /** The page. The only slot that scrolls. */
  content: ReactNode;
  /** What the page is called. Required for the same reason it is on {@link PageHeader}. */
  title: ReactNode;
  /** One line on what the page is for. */
  description?: ReactNode;
  /** Sits before the title, sized from `level`. Pass a bare `<Users />`. */
  icon?: ReactNode;
  /** The header's far end: the page's buttons, a status pill, a menu. */
  action?: ReactNode;
  /** The line above the title: a breadcrumb trail, or a back link. */
  breadcrumbs?: ReactNode;
  /**
   * The row under the title: a search field, a filter row, tabs. It is `PageHeader`'s `content`
   * slot, named for the part it belongs to because this component's own `content` is the page.
   *
   * Passing it also removes the rule under the header — see `PageHeader`, which derives that.
   */
  headerContent?: ReactNode;
  /** Whether the *title* is still being fetched. The body is the caller's to place. */
  loading?: boolean;
  /** Which heading the title is. `1` unless this page is nested inside another's chrome. */
  level?: PageHeaderProps['level'];
  /** Pinned under the body: paging, totals, a save bar. Absent, no row is drawn. */
  footer?: ReactNode;
  /**
   * The column the header and body share. `page` for a list or a board, `prose` for settings, a
   * detail page or a form, `full` for a pane that is already inside someone else's column.
   */
  width?: ComponentProps<typeof HeaderContentFooter>['width'];
  /** The scrolling body, for a caller that has to reach it — restoring a scroll position. */
  contentRef?: Ref<HTMLDivElement>;
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
};

/**
 * A whole page: its title block pinned above a body that scrolls under it.
 *
 * This is `StickyHeaderContentFooter` with a `PageHeader` in its header slot, and it exists
 * because that is the sentence two apps here wrote out for themselves rather than the component
 * they reached for. `kanban_server/web/components/app-shell.tsx:282` and
 * `task_server/web/components/app-shell.tsx:46` are the same forty lines twice — the same
 * `title`, `description`, `actions`, the same `min-h-0 flex-1 overflow-y-auto`, the same
 * centred column — and having written it twice they disagree on the only prop that varies:
 * `wide` means `max-w-5xl` in one and `max-w-none` in the other, over a `max-w-3xl` default that
 * neither of them named. Across these projects there are 51 capped page columns in 10 widths.
 *
 * So the contribution is not the composition, which is four lines. It is that `width` is a word
 * — `page`, `prose`, `full` — instead of a number the next page picks again.
 *
 * **What it does not do.** It does not own the sidebar, the theme toggle or the route: those
 * belong to an app shell, and shadcn ships `sidebar` for the drawing. It does not scroll the
 * header away with the rows — that is the whole point of the chassis under it. And it takes no
 * `children`; the page is `content`, like every other slot in this set.
 */
export function PageLayout({
  content,
  title,
  description,
  icon,
  action,
  breadcrumbs,
  headerContent,
  loading = false,
  level = 1,
  footer,
  width = 'page',
  contentRef,
  className,
  headerClassName,
  contentClassName,
  footerClassName,
}: PageLayoutProps) {
  return (
    <StickyHeaderContentFooter
      width={width}
      contentRef={contentRef}
      className={className}
      contentClassName={contentClassName}
      footerClassName={footerClassName}
      header={
        <PageHeader
          title={title}
          description={description}
          icon={icon}
          action={action}
          breadcrumbs={breadcrumbs}
          content={headerContent}
          loading={loading}
          level={level}
          className={headerClassName}
        />
      }
      content={content}
      footer={footer}
    />
  );
}
