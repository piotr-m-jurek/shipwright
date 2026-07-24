import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { signIn, useSession } from "../lib/auth-client";
import { useEffect } from "react";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const { data: session } = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    if (session) {
      navigate({ to: "/" });
    }
  }, [session, navigate]);

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-6">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Shipwright</h1>
        <p className="text-sm text-gray-500">Sign in to continue</p>
      </div>
      <div className="flex flex-col gap-3 w-full max-w-xs">
        <button
          type="button"
          onClick={() =>
            signIn.social({ provider: "github", callbackURL: "/" })
          }
          className="flex items-center justify-center gap-2 rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium shadow-sm hover:bg-gray-50 transition-colors"
        >
          Continue with GitHub
        </button>
        <button
          type="button"
          onClick={() =>
            signIn.social({ provider: "google", callbackURL: "/" })
          }
          className="flex items-center justify-center gap-2 rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium shadow-sm hover:bg-gray-50 transition-colors"
        >
          Continue with Google
        </button>
      </div>
    </div>
  );
}
