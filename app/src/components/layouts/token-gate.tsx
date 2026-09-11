import { useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRoundIcon className="size-4" /> Authentication required
          </CardTitle>
          <CardDescription>
            Enter the server token (from <code>MCP_ZEROMEM_TOKEN</code>).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="token">Token</Label>
              <Input
                id="token"
                type="password"
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Bearer token"
              />
            </div>
            <Button type="submit" disabled={!value.trim()}>
              Unlock
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
