import * as React from "react";
import { Outlet, createRootRoute, redirect } from "@tanstack/react-router";
import { authClient } from "../lib/auth-client";

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    const PUBLIC_PATHS = ["/login"];
    const isPublic = PUBLIC_PATHS.some((p) => location.pathname.startsWith(p));
    if (isPublic) return;

    const { data: session } = await authClient.getSession();
    if (!session) {
      throw redirect({ to: "/login" });
    }
  },
  component: RootComponent,
});

function RootComponent() {
  return (
    <React.Fragment>
      <Outlet />
    </React.Fragment>
  );
}
