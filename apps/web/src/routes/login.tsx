import { createFileRoute, redirect } from "@tanstack/react-router";
import { signIn, authClient } from "../lib/auth-client";

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
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-6">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Shipwright</h1>
        <p className="text-sm text-gray-500">Sign in to continue</p>
      </div>
      <div className="flex flex-col gap-3 w-full max-w-xs">
        <button
          type="button"
          onClick={() => signIn.social({ provider: "github", callbackURL })}
          className="flex items-center justify-center gap-2 rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium shadow-sm hover:bg-gray-50 transition-colors"
        >
          Continue with GitHub
        </button>
        <button
          type="button"
          onClick={() => signIn.social({ provider: "google", callbackURL })}
          className="flex items-center justify-center gap-2 rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium shadow-sm hover:bg-gray-50 transition-colors"
        >
          Continue with Google
        </button>
      </div>
    </div>
  );
}
