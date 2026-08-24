import { ShipwrightApi } from "@/store/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";
import { CopyIcon, CheckIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

// apps/mcp is a separately deployed service, not served by apps/api's static
// SPA hosting (see Stack doc) -- needs its own URL, not just the API origin.
const MCP_URL = (import.meta.env.VITE_MCP_URL as string | undefined) ?? "http://localhost:3002";

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------
// One shared reactivity key: generating or revoking the token both need to
// invalidate the status query so the UI reflects the new state immediately.
const MCP_TOKEN_REACTIVITY_KEY = ["mcp-token"];

const tokenStatusAtom = ShipwrightApi.query("mcp-token", "getMcpTokenStatus", {
  reactivityKeys: MCP_TOKEN_REACTIVITY_KEY,
});

const generateTokenFamily = Atom.family((_nonce: number) =>
  ShipwrightApi.mutation("mcp-token", "generateMcpToken"),
);

const revokeTokenFamily = Atom.family((_nonce: number) =>
  ShipwrightApi.mutation("mcp-token", "revokeMcpToken"),
);

function mcpConfigJson(token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        shipwright: {
          type: "http",
          url: `${MCP_URL}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function SettingsPage() {
  const statusResult = useAtomValue(tokenStatusAtom);

  const [generateNonce, setGenerateNonce] = useState(() => Date.now());
  const [revokeNonce, setRevokeNonce] = useState(() => Date.now());
  const generateAtom = generateTokenFamily(generateNonce);
  const revokeAtom = revokeTokenFamily(revokeNonce);
  const generateResult = useAtomValue(generateAtom);
  const revokeResult = useAtomValue(revokeAtom);
  const generate = useAtomSet(generateAtom);
  const revoke = useAtomSet(revokeAtom);

  // The raw token only ever lives in this component's state, for the
  // duration this dialog is open -- never persisted, never re-fetchable.
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  const hasActiveToken = AsyncResult.isSuccess(statusResult) && statusResult.value.hasActiveToken;

  useEffect(() => {
    if (AsyncResult.isSuccess(generateResult)) {
      setRevealedToken(generateResult.value.token);
    }
  }, [generateResult]);

  useEffect(() => {
    if (AsyncResult.isSuccess(revokeResult)) {
      toast.success("MCP token revoked");
    }
  }, [revokeResult]);

  const handleGenerate = () => {
    setGenerateNonce(Date.now());
    generate({ reactivityKeys: MCP_TOKEN_REACTIVITY_KEY });
  };

  const handleRevoke = () => {
    setRevokeNonce(Date.now());
    revoke({ reactivityKeys: MCP_TOKEN_REACTIVITY_KEY });
  };

  return (
    <div className="flex min-h-svh flex-col items-center bg-background p-8">
      <div className="w-full max-w-xl space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="font-mono text-sm font-medium tracking-tight">Settings</h1>
          <Link to="/" className="text-xs text-muted-foreground hover:underline">
            ← Back
          </Link>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>MCP Access Token</CardTitle>
            <CardDescription>
              Lets coding agents (Claude Code, Cursor) read your sessions&apos; Brief and PRD, and
              search your source documents, via the Shipwright MCP server. Separate from your login
              session — revoking it does not sign you out, and generating one does not require
              signing back in.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {AsyncResult.isWaiting(statusResult) && !AsyncResult.isSuccess(statusResult) ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-3" />
                Checking token status…
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {hasActiveToken
                  ? "An active token exists. Generating a new one immediately replaces it — the old one stops working."
                  : "No active token. Generate one to connect a coding agent."}
              </p>
            )}
          </CardContent>
          <CardFooter className="gap-2">
            <Button onClick={handleGenerate} disabled={AsyncResult.isWaiting(generateResult)}>
              {AsyncResult.isWaiting(generateResult) ? (
                <>
                  <Spinner className="size-3.5" />
                  Generating…
                </>
              ) : hasActiveToken ? (
                "Regenerate token"
              ) : (
                "Generate token"
              )}
            </Button>

            {hasActiveToken && (
              <AlertDialog>
                <AlertDialogTrigger render={<Button variant="ghost">Revoke</Button>} />
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Revoke MCP token?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Any coding agent currently using this token will immediately lose access. This
                      does not affect your login session.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleRevoke}>Revoke</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </CardFooter>
        </Card>
      </div>

      <RevealedTokenDialog token={revealedToken} onClose={() => setRevealedToken(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reveal-once dialog — the only point in this token's lifetime it's visible
// ---------------------------------------------------------------------------

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    toast.success(`${label} copied`);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Button variant="outline" size="sm" onClick={handleCopy} className="gap-1.5">
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      {copied ? "Copied" : `Copy ${label}`}
    </Button>
  );
}

function RevealedTokenDialog({ token, onClose }: { token: string | null; onClose: () => void }) {
  return (
    <Dialog open={token !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Your MCP token</DialogTitle>
          <DialogDescription>
            Shown once — it is not stored anywhere retrievable after this. Copy it now, or the
            config block below, before closing this dialog.
          </DialogDescription>
        </DialogHeader>

        {token && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Raw token</span>
                <CopyButton value={token} label="token" />
              </div>
              <pre className="rounded border bg-muted p-2 text-xs break-all whitespace-pre-wrap">
                {token}
              </pre>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  MCP client config (paste into Claude Code / Cursor)
                </span>
                <CopyButton value={mcpConfigJson(token)} label="config" />
              </div>
              <pre className="max-h-64 overflow-y-auto rounded border bg-muted p-2 text-xs break-all whitespace-pre-wrap">
                {mcpConfigJson(token)}
              </pre>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
