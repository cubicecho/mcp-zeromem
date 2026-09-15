import { useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { CardLayout } from '@/components/card-layout';
import { FormField } from '@/components/form-field';
import { PasswordInput } from '@/components/password-input';
import { Button } from '@/components/ui/button';
import { setToken, useNeedsAuth } from '@/lib/auth';

/**
 * Renders its children normally; when any API call has come back 401 it swaps
 * in a token-entry screen. Submitting stores the token in localStorage and
 * refetches everything.
 */
export function TokenGate({ children }: { children: ReactNode }) {
  const needsAuth = useNeedsAuth();
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');

  if (!needsAuth) {
    return children;
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const token = value.trim();
    if (!token) {
      return;
    }
    setToken(token);
    setValue('');
    queryClient.invalidateQueries();
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <CardLayout
        className="w-full max-w-sm"
        icon={<KeyRoundIcon />}
        title="Authentication required"
        description={
          <>
            Enter the server token (from <code>MCP_ZEROMEM_TOKEN</code>).
          </>
        }
        content={
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <FormField
              label="Token"
              control={
                <PasswordInput
                  showLabel="Show token"
                  hideLabel="Hide token"
                  autoFocus
                  autoComplete="current-password"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder="Bearer token"
                />
              }
            />
            <Button type="submit" disabled={!value.trim()}>
              Unlock
            </Button>
          </form>
        }
      />
    </div>
  );
}
