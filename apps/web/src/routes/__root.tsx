import { Outlet, createRootRoute, redirect } from "@tanstack/react-router";
import { authClient } from "../lib/auth-client";
import { ThemeProvider } from "../components/theme-provider";
import { ModeToggle } from "../components/mode-toggle";
import { UserMenu } from "../components/user-menu";
import { Toaster } from "../components/ui/sonner";

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
    <ThemeProvider>
      <div className="fixed top-3 right-3 z-50 flex items-center gap-1">
        <UserMenu />
        <ModeToggle />
      </div>
      <Outlet />
      <Toaster />
    </ThemeProvider>
  );
}
