import type { ReactNode } from 'react';
import { useState } from 'react';
import { HeaderContentFooter } from '@/components/header-content-footer';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/** How wide the dialog wants to be, past the phone width every size shares. */
const SIZES = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-4xl',
  full: 'sm:max-w-[calc(100vw-4rem)]',
} as const;

type DialogLayoutProps = {
  /** The body. It is the only part that scrolls. */
  content: ReactNode;
  /**
   * Required, because a dialog without a title is one no screen reader can announce. A dialog
   * whose design has no room for a heading passes `hideTitle` and keeps this.
   */
  title: ReactNode;
  /** Read to the same people the title is. Absent, the dialog is described by its body. */
  description?: ReactNode;
  /** Keeps the title for assistive technology and takes it off the screen. */
  hideTitle?: boolean;
  /**
   * What opens it, wrapped in `DialogTrigger asChild` — pass a `<Button>`, not a bare string.
   * With a trigger and no `open`, the dialog owns its own state and the caller holds none.
   */
  trigger?: ReactNode;
  /** Controlled open state. Omit both this and `onOpenChange` to let the trigger drive it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  size?: keyof typeof SIZES;
  /** The footer's start. A destructive action, or a word on why the confirm is refusing. */
  footer?: ReactNode;
  /**
   * The footer's end. Cancel and confirm. Given alone, the footer is simply right-aligned.
   *
   * Pass a **function** to get the dialog's own close, guarded the same way Escape and the
   * overlay are. A Cancel wired to the caller's `setOpen(false)` goes around the shell entirely,
   * and `hasUnsavedChanges` then covers three of the four ways out — the fourth being the one
   * people click. Taking `close` from here is the same close the other three doors use, so
   * unsaved work asks on the way through it too.
   *
   * ```tsx
   * footerActions={(close) => (
   *   <>
   *     <Button variant="ghost" onClick={close}>Cancel</Button>
   *     <Button onClick={save}>Save</Button>
   *   </>
   * )}
   * ```
   *
   * Only this slot takes the function. `footer` is the other end — a destructive action, or a
   * word on why the confirm is refusing — and nothing there closes the dialog on the way out.
   */
  footerActions?: ReactNode | ((close: () => void) => ReactNode);
  /**
   * Whether Escape and a click on the overlay close it. Off refuses to leave; prefer
   * `hasUnsavedChanges`, which asks on the way out instead.
   */
  dismissible?: boolean;
  /**
   * There is work in the body that closing would throw away. Escape, a click on the overlay and
   * the close button then ask first, and the dialog stays open if the answer is no.
   *
   * Asked for, never computed — only the caller knows what its fields are. A form knows: pass
   * `form.state.isDirty`.
   */
  hasUnsavedChanges?: boolean;
  /** The question that asks. Defaulted, because this one really is the same everywhere. */
  discardTitle?: ReactNode;
  discardDescription?: ReactNode;
  /** The verb that throws the work away, and the one that goes back to it. */
  discardLabel?: ReactNode;
  keepLabel?: ReactNode;
  showCloseButton?: boolean;
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
};

/**
 * A dialog with its slots already placed, and a body that scrolls under a header that does not.
 *
 * The scroll is the reason this exists rather than a snippet. Every hand-written dialog in these
 * apps caps itself with `max-h-[85vh] overflow-y-auto` on the content, which scrolls the *whole*
 * dialog: on a long form the title leaves the screen first and the save button is somewhere past
 * the end of the fields.
 *
 * That shape — chrome that stays, a middle that moves, floors that let it — is
 * {@link HeaderContentFooter}, so the dialog composes it rather than owning a second copy. What
 * is left here is the part that is about dialogs: the primitive's own header and footer, the
 * title an assistive technology needs, and the two classes that turn `DialogContent` into a
 * column that can be divided.
 *
 * **`hasUnsavedChanges` is a prop and not a hook, and that is the whole point.** Seven dialogs in
 * kanban_server closed through a `useDiscardGuard`; six called it and the seventh wired
 * `onOpenChange` straight into its `onClose` and quietly lost what had been typed. A hook is a
 * thing a caller can forget. A shell is not, because a caller cannot see it.
 *
 * **Padding stays with the primitive.** `DialogContent` carries it (`p-6` in new-york, `p-4` in
 * others) and so do the footers that bleed to its edge with a negative margin. A shell that set
 * its own would be a shell that only fits one style, so this one overrides `display` and
 * `overflow` and nothing else.
 */
export function DialogLayout({
  content,
  title,
  description,
  hideTitle = false,
  trigger,
  open,
  onOpenChange,
  size = 'md',
  footer,
  footerActions,
  dismissible = true,
  hasUnsavedChanges = false,
  discardTitle = 'Discard your changes?',
  discardDescription = 'What you have typed here will not be saved.',
  discardLabel = 'Discard',
  keepLabel = 'Keep editing',
  showCloseButton = true,
  className,
  headerClassName,
  contentClassName,
  footerClassName,
}: DialogLayoutProps) {
  const stop = dismissible ? undefined : (event: Event) => event.preventDefault();

  // Radix is handed an `open` either way, so one `requestClose` covers Escape, the overlay and
  // the close button alike. Uncontrolled, the state simply lives here instead of in the
  // primitive; a caller who passes `open` still owns it, and still hears every change.
  const [selfOpen, setSelfOpen] = useState(false);
  const isOpen = open ?? selfOpen;

  const setOpenState = (next: boolean) => {
    if (open === undefined) setSelfOpen(next);
    onOpenChange?.(next);
  };

  const [askingToDiscard, setAskingToDiscard] = useState(false);

  const requestOpenChange = (next: boolean) => {
    if (!next && hasUnsavedChanges) {
      setAskingToDiscard(true);
      return;
    }
    setOpenState(next);
  };

  const closeFromFooter = () => requestOpenChange(false);

  const discard = () => {
    setAskingToDiscard(false);
    setOpenState(false);
  };

  // The same close Escape, the overlay and the close button go through, handed to the footer so
  // a Cancel there is guarded by the thing that guards them.
  const actions = typeof footerActions === 'function' ? footerActions(closeFromFooter) : footerActions;

  // Asked of what the footer actually rendered: a function that returns nothing should leave the
  // dialog with no footer, not with an empty one taking up a row.
  const hasFooter = Boolean(footer || actions);

  return (
    <>
      <Dialog open={isOpen} onOpenChange={requestOpenChange}>
        {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}

        <DialogContent
          showCloseButton={showCloseButton}
          onEscapeKeyDown={stop}
          onInteractOutside={stop}
          // Radix warns when nothing describes the content. Without a description that is the
          // intent, and an explicit `undefined` is how it is said — spread only in that case,
          // because the prop is applied after the primitive's own and would unlink a real one.
          {...(description ? {} : { 'aria-describedby': undefined })}
          // `flex` replaces the primitive's `grid` so the body can be handed the leftover height;
          // `overflow-hidden` takes the scroll off the dialog so the chassis can put it on the
          // body. The cap is the primitive's own, restated for the styles that ship without one.
          className={cn('flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden', SIZES[size], className)}
        >
          <HeaderContentFooter
            scroll
            className="min-h-0 flex-1 gap-4"
            header={
              <DialogHeader
                // The close button is positioned against the dialog, not the header, so a long
                // title runs under it without this.
                className={cn(showCloseButton && 'pr-6', headerClassName)}
              >
                <DialogTitle className={cn(hideTitle && 'sr-only')}>{title}</DialogTitle>
                {description ? <DialogDescription>{description}</DialogDescription> : null}
              </DialogHeader>
            }
            // Four pixels of room either side, given back as padding: a focus ring is drawn
            // outside the element that owns it, and a scroll container clips at its edge.
            contentClassName={cn('-mx-1 px-1', contentClassName)}
            content={content}
            footer={
              hasFooter ? (
                <DialogFooter className={cn(footer && footerActions && 'sm:justify-between', footerClassName)}>
                  {footer}
                  {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
                </DialogFooter>
              ) : null
            }
          />
        </DialogContent>
      </Dialog>

      {/*
      A sibling of the dialog rather than a child of it: two modals nested in the DOM fight over
      the focus trap, and the question has to be able to take focus from the form it is about.
    */}
      <AlertDialog open={askingToDiscard} onOpenChange={setAskingToDiscard}>
        <AlertDialogContent data-slot="dialog-layout-discard">
          <AlertDialogHeader>
            <AlertDialogTitle>{discardTitle}</AlertDialogTitle>
            <AlertDialogDescription>{discardDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{keepLabel}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={discard}>
              {discardLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
