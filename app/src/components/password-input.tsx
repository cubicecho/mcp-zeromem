import { Eye, EyeOff } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type PasswordInputProps = Omit<ComponentProps<typeof Input>, 'type'> & {
  /** The reveal button's name while the value is hidden. */
  showLabel?: string;
  /** And while it is showing. Both are announced; the icon alone says nothing. */
  hideLabel?: string;
  /** Off, this is a plain `<Input type="password">` with no button. */
  revealable?: boolean;
  /** The wrapper's class. `className` still goes to the input, as it does on any input. */
  wrapperClassName?: string;
};

/**
 * A password box with an eye on it.
 *
 * Nine call sites across six projects write `<Input type="password">`, and not one of them can be
 * un-masked. Five of those are token gates — a pasted bearer token, a server's start-up secret —
 * where the only failure mode is a character that went in wrong and the only diagnosis is
 * "Unlock" not working. The other four are a change-password form, which asks for the same secret
 * twice precisely because it cannot be read back.
 *
 * So the control is the toggle, and everything else is shadcn's `Input` unchanged. Three details
 * are the ones a hand-written eye gets wrong, every time:
 *
 * - **`type="button"`.** A `<button>` in a `<form>` submits by default, so a reveal written
 *   without it submits the login form on the way to reading the password.
 * - **The button is named, and the name changes.** An icon-only button with no `aria-label` is an
 *   axe failure and a screen reader saying "button"; one whose label stays "Show password" after
 *   it has shown it is worse, because it is confidently wrong.
 * - **The masking is the `type`, not a CSS trick.** `type="text"` while revealed is what stops
 *   the password manager from filling the field a second time and what keeps the value out of the
 *   browser's own "reveal" chrome on Edge, which would otherwise draw a second eye beside this
 *   one.
 *
 * Revealed state is deliberately local and deliberately not a prop. Nothing above this needs to
 * know, and a form that persisted it would be a form that remembers to show a password.
 *
 * ```tsx
 * <PasswordInput id="token" autoComplete="current-password" value={token} onChange={…} />
 * ```
 */
export function PasswordInput({
  showLabel = 'Show password',
  hideLabel = 'Hide password',
  revealable = true,
  wrapperClassName,
  className,
  disabled,
  ...props
}: PasswordInputProps) {
  const [shown, setShown] = useState(false);
  const visible = revealable && shown;

  return (
    <div data-slot="password-input" className={cn('relative w-full min-w-0', wrapperClassName)}>
      <Input
        {...props}
        type={visible ? 'text' : 'password'}
        disabled={disabled}
        // Room for the button, so a long token does not run under it.
        className={cn(revealable && 'pr-9', className)}
      />
      {revealable ? (
        <button
          data-slot="password-input-reveal"
          type="button"
          // Not `aria-pressed`: the name already carries the state, and a button announced as
          // "Hide password, pressed" says it twice and disagrees with itself once.
          aria-label={visible ? hideLabel : showLabel}
          disabled={disabled}
          onClick={() => setShown((was) => !was)}
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
        >
          {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
        </button>
      ) : null}
    </div>
  );
}
