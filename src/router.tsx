import { createRootRoute, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import App from "./App";

function RootLayout() {
  return (
    <App>
      <Outlet />
    </App>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/scan" });
  },
});

const scanRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/scan",
  component: () => null,
});

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/history",
  component: () => null,
});

const ledgerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ledger",
  component: () => null,
});

const findRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/finds/$itemId",
  validateSearch: (search: Record<string, unknown>) => ({
    from: search.from === "scan" ? ("scan" as const) : search.from === "ledger" ? ("ledger" as const) : ("history" as const),
  }),
  component: () => null,
});

const findActivityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/finds/$itemId/activity",
  validateSearch: (search: Record<string, unknown>) => ({
    from: search.from === "scan" ? ("scan" as const) : search.from === "ledger" ? ("ledger" as const) : ("history" as const),
  }),
  component: () => null,
});

const routeTree = rootRoute.addChildren([indexRoute, scanRoute, historyRoute, ledgerRoute, findRoute, findActivityRoute]);

export const router = createRouter({ routeTree, scrollRestoration: true });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
