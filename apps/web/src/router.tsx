import type { PropsWithChildren } from "react";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";

import { routeTree } from "@/routeTree.gen";

export function createRouter() {
  const router = createTanStackRouter({
    routeTree,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,

    InnerWrap: ({ children }: PropsWithChildren) => {
      return <>{children}</>;
      // INFO: Here goes all providers that might come up later in development
    },
  });

  return router;
}

type AppRouter = ReturnType<typeof createRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
