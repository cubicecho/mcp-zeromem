import type { ComponentProps, ReactNode } from 'react';
import { useState } from 'react';

import { ActionButton } from '@/components/action-button';
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

type ConfirmButtonProps = Omit<ComponentProps<typeof ActionButton>, 'onClick'> & {
  /** The question, as a heading. "Delete this workspace?" */
  title: ReactNode;
  /**
   * What is lost if they say yes. Required, and it is the reason the component is worth
   * installing — see the note below.
   */
  description: ReactNode;
  /** The verb on the button that does it. */
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  onConfirm: () => void;
};

/**
 * A button that asks first.
 *
 * There are 22 hand-written `<AlertDialogContent>` blocks across these projects and four of them
 * are already this component, extracted independently — `kanban_server/.../confirm-button.tsx`,
 * `eunomia/.../confirm-delete.tsx`, a private project's `confirm.tsx`, and `philotes`, which wrote
 * it inline twice. The other twelve are loose in route files. They disagree about the button
 * order, about whether the confirm is `variant="destructive"` or a `cn(buttonVariants(…))`
 * (`AlertDialogAction` takes `variant` now, so the second spelling is only ever a leftover), and
 * about what Cancel is called.
 *
 * **`description` is required, and that is the opinion this component is carrying.** It is meant
 * to say what is lost, not to ask again. "This action cannot be undone" is what the dialog
 * already implies and it is what nine of these call sites say; "the lane takes its cards with
 * it" is the thing the person did not know and could not have guessed from the row they clicked.
 * A confirm whose description is the word "permanently" has cost a click and taught nothing. The
 * prop is required because the useful sentence is the one that gets skipped when it is optional.
 *
 * **Why the open state rather than `AlertDialogTrigger asChild`.** The trigger is an
 * {@link ActionButton}, which is already a `TooltipTrigger asChild`, and two `Slot`s over one
 * button fight over the ref and the handlers. Holding `open` here is four lines and it keeps the
 * button's tooltip, its name and its `aria-disabled` intact.
 *
 * Destructive only, deliberately. `confirmLabel` reaches Discard, Revoke, Remove and Reset — a
 * confirm that is *not* destructive is a question, and a question is `DialogLayout`.
 */
export function ConfirmButton({
  title,
  description,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onConfirm,
  disabled,
  ...props
}: ConfirmButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <ActionButton {...props} disabled={disabled} onClick={() => setOpen(true)} />
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent data-slot="confirm-button-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onConfirm}>
              {confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
