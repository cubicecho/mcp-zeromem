import { createRootRoute, Outlet } from '@tanstack/react-router';
import { AppLayout } from '@/components/layouts/app-layout';
import { TokenGate } from '@/components/layouts/token-gate';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <TooltipProvider>
      <TokenGate>
        <AppLayout>
          <Outlet />
        </AppLayout>
      </TokenGate>
      <Toaster />
    </TooltipProvider>
  );
}
