import { createFileRoute, redirect } from "@tanstack/react-router";
import { signIn, authClient } from "../lib/auth-client";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    const { data: session } = await authClient.getSession();
    if (session) {
      throw redirect({ to: "/" });
    }
  },
  component: LoginPage,
});

const callbackURL = "http://localhost:5173";

function LoginPage() {
  function handleLoginGithub() {
    signIn.social({ provider: "github", callbackURL });
  }
  function handleLoginGoogle() {
    signIn.social({ provider: "google", callbackURL });
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-6">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Shipwright</h1>
        <p className="text-sm text-gray-500">Sign in to continue</p>
      </div>
      <ButtonGroup orientation="vertical" className="w-full max-w-xs">
        <Button variant="outline" onClick={handleLoginGithub}>
          Continue with GitHub
        </Button>
        <Button variant="outline" onClick={handleLoginGoogle}>
          Continue with Google
        </Button>
      </ButtonGroup>
    </div>
  );
}
