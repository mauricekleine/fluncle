import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { siteUrl } from "@/lib/fluncle-links";

// The device-authorization verification surface (RFC 8628). The CLI sends the
// user here (it prints the URL and opens the browser at `/device?user_code=…`).
// A signed-in user confirms the code their terminal is showing, then approves —
// minting a USER session token the CLI polls for. This token is for the user's
// own Galaxy sync; it is never the admin grant.

type Me = {
  ok: true;
  user: null | {
    createdAt: string;
    displayUsername?: string;
    id: string;
    username?: string;
  };
};

type DeviceSearch = {
  user_code?: string;
};

type Phase = "approved" | "denied" | "error" | "idle" | "working";

export const Route = createFileRoute("/device")({
  component: DevicePage,
  head: () => ({
    links: [{ href: `${siteUrl}/device`, rel: "canonical" }],
    meta: [
      { title: "Link a device" },
      {
        content: "Approve a Fluncle CLI sign-in and sync your Galaxy progress from the terminal.",
        name: "description",
      },
      // A confirmation screen tied to a one-time code — never index it.
      { content: "noindex, nofollow", name: "robots" },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): DeviceSearch => ({
    user_code: typeof search.user_code === "string" ? search.user_code : undefined,
  }),
});

function DevicePage() {
  const { user_code: initialCode } = Route.useSearch();
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [code, setCode] = useState(initialCode ?? "");
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void fetch("/api/me")
      .then((res) => res.json() as Promise<Me>)
      .then(setMe)
      .catch(() => setMe({ ok: true, user: null }));
  }, []);

  const signedIn = !!me?.user;
  const name = me?.user?.displayUsername ?? me?.user?.username ?? "cosmonaut";

  async function decide(decision: "approve" | "deny") {
    const userCode = code.trim().toUpperCase();

    if (!userCode) {
      setMessage("Pop in the code your terminal is showing.");
      return;
    }

    setPhase("working");
    setMessage("");

    try {
      // Claim the code first: `GET /device` binds it to this signed-in session so
      // approve/deny is authorized to act on it (RFC 8628's user-interaction step).
      const claim = await authClient.$fetch<{ status?: string }>("/device", {
        query: { user_code: userCode },
      });

      if (claim.error) {
        setPhase("error");
        // `$fetch` surfaces the device-flow error code on the error object; fall
        // back to its message when the code isn't typed through.
        const claimError = claim.error as { error?: string; message?: string };
        setMessage(deviceErrorCopy(claimError.error, claimError.message));
        return;
      }

      const result =
        decision === "approve"
          ? await authClient.device.approve({ userCode })
          : await authClient.device.deny({ userCode });

      if (result.error) {
        setPhase("error");
        setMessage(deviceErrorCopy(result.error.error, result.error.error_description));
        return;
      }

      setPhase(decision === "approve" ? "approved" : "denied");
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "Something jammed. Try the code again.");
    }
  }

  return (
    <main className="min-h-screen overflow-x-hidden p-4 text-foreground sm:p-6 lg:p-8">
      <article className="home-plate account-plate mx-auto my-6 w-full max-w-xl sm:my-8">
        <header className="home-masthead">
          <div>
            <h1 className="home-nameplate">Link a device</h1>
            <p className="home-tagline">Let the terminal aboard your account.</p>
          </div>
          <Link
            className="text-sm font-semibold text-muted-foreground hover:text-accent-foreground"
            to="/"
          >
            Back to findings
          </Link>
        </header>

        {me === undefined ? (
          <p className="account-muted">Checking the manifest…</p>
        ) : !signedIn ? (
          <div className="account-stack">
            <p className="account-muted">
              Sign in first, then come back and approve the code your terminal is showing.
            </p>
            <Button nativeButton={false} render={<Link to="/account" />}>
              Sign in to your account
            </Button>
          </div>
        ) : phase === "approved" ? (
          <div className="account-stack">
            <p>
              Done. Your terminal is aboard, {name}. Head back to it — <code>fluncle</code> has the
              rest.
            </p>
          </div>
        ) : phase === "denied" ? (
          <div className="account-stack">
            <p>Turned that one away. Nothing was linked.</p>
          </div>
        ) : (
          <form
            className="account-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void decide("approve");
            }}
          >
            <p className="account-muted">
              Signed in as {name}. Confirm the code your terminal printed, then wave it aboard.
            </p>
            <div className="account-field">
              <Label htmlFor="user-code">Code from your terminal</Label>
              <Input
                autoComplete="one-time-code"
                autoCapitalize="characters"
                id="user-code"
                placeholder="ABCD-1234"
                spellCheck={false}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
            {message ? <p className="text-sm text-destructive">{message}</p> : null}
            <div className="flex flex-wrap gap-3">
              <Button disabled={phase === "working"} type="submit">
                {phase === "working" ? "Linking…" : "Approve this device"}
              </Button>
              <Button
                disabled={phase === "working"}
                onClick={() => void decide("deny")}
                type="button"
                variant="ghost"
              >
                Not me — deny
              </Button>
            </div>
          </form>
        )}
      </article>
    </main>
  );
}

// Map the device-flow approve/deny error codes to Fluncle-voiced copy. The plugin
// returns codes like `expired_token`, `invalid_request`, and `unauthorized` (a
// wrong/stale user code, or no session) in the `error` field.
function deviceErrorCopy(code: string | undefined, fallback: string | undefined): string {
  const normalized = code?.toLowerCase() ?? "";

  if (normalized.includes("expired")) {
    return "That code timed out. Run `fluncle login` again for a fresh one.";
  }

  if (normalized === "unauthorized") {
    return "Sign in first, then approve the code your terminal is showing.";
  }

  if (normalized.includes("invalid") || normalized.includes("not_found")) {
    return "No match for that code. Check the terminal and try again.";
  }

  return fallback ?? "Something jammed. Try the code again.";
}
