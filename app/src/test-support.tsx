import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

/**
 * Render a page component under a fresh QueryClient and a one-route memory
 * router, so `Link` and `useNavigate` have a context to resolve against.
 * Links to other pages still render (the router does not need to know the
 * target to build an href).
 */
export function renderPage(ui: ReactNode, path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  // The router resolves its first match asynchronously, so callers use the
  // `find*` queries for the first assertion.
  return { ...render(<RouterProvider router={router} />), client, router };
}
