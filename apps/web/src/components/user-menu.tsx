import { signOut, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Link, useNavigate } from "@tanstack/react-router";

/**
 * Settings + Sign out — rendered once, globally, in the root layout's fixed
 * top-right panel (next to ModeToggle), not per-page. Self-hides when there
 * is no session (e.g. on /login), so it's safe to mount unconditionally.
 */
function UserMenu() {
  const { data: session } = useSession();
  const navigate = useNavigate();

  async function handleSignout() {
    await signOut();
    await navigate({ to: "/login" });
  }

  if (!session) {
    return null;
  }

  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="sm" render={<Link to="/settings">Settings</Link>} />
      <Button variant="ghost" size="sm" onClick={handleSignout}>
        Sign out
      </Button>
    </div>
  );
}

export { UserMenu };
