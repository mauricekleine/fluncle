import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import { authClient } from "@/lib/auth-client";
import { siteUrl } from "@/lib/fluncle-links";

// The password-reset surface. Better Auth's reset email links to its
// `/api/auth/reset-password/:token` endpoint, which validates the token then
// redirects here with the token (or `?error=INVALID_TOKEN`) in the query. A quiet
// form takes the new password and posts it back via `authClient.resetPassword`.

type ResetSearch = {
  error?: string;
  token?: string;
};

type Phase = "done" | "error" | "idle" | "working";

// TanStack's canonical option order (validateSearch feeds the next step's
// inference), which isn't alphabetical — so sort-keys is off here. See AGENTS.md.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): ResetSearch => ({
    error: typeof search.error === "string" ? search.error : undefined,
    token: typeof search.token === "string" ? search.token : undefined,
  }),
  head: () => ({
    links: [{ href: `${siteUrl}/reset-password`, rel: "canonical" }],
    meta: [
      { title: "Reset your password" },
      {
        content: "Set a new password on your private Fluncle account.",
        name: "description",
      },
      // A one-time-token form — never index it.
      { content: "noindex, nofollow", name: "robots" },
    ],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { error: linkError, token } = Route.useSearch();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");

  const invalidLink = !token || linkError === "INVALID_TOKEN";

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    if (!token) {
      return;
    }

    if (password.length < 10) {
      setMessage("Pick a password of at least 10 characters.");
      return;
    }

    if (password !== confirm) {
      setMessage("Those two passwords do not match.");
      return;
    }

    setPhase("working");
    setMessage("");

    try {
      const result = await authClient.resetPassword({ newPassword: password, token });

      if (result.error) {
        setPhase("error");
        setMessage(result.error.message ?? "That reset link has expired. Ask for a new one.");
        return;
      }

      setPhase("done");
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "Could not reset your password.");
    }
  }

  return (
    <main className="min-h-screen overflow-x-hidden p-4 text-foreground sm:p-6 lg:p-8">
      <article className="home-plate account-plate mx-auto my-6 w-full max-w-xl sm:my-8">
        <header className="home-masthead">
          <div>
            <h1 className="home-nameplate">Reset your password</h1>
            <p className="home-tagline">Set a new password for your account.</p>
          </div>
          <Link
            className="text-sm font-semibold text-muted-foreground hover:text-accent-foreground"
            to="/account"
          >
            Back to your account
          </Link>
        </header>

        {invalidLink ? (
          <div className="account-stack">
            <p className="account-muted">
              This reset link is invalid or has expired. Ask for a new one from your account.
            </p>
            <Button nativeButton={false} render={<Link to="/account" />}>
              Back to your account
            </Button>
          </div>
        ) : phase === "done" ? (
          <div className="account-stack">
            <p>Your password is set. You can sign in with it now.</p>
            <Button nativeButton={false} render={<Link to="/account" />}>
              Go to sign in
            </Button>
          </div>
        ) : (
          <form className="account-stack" onSubmit={(event) => void submit(event)}>
            <div className="account-field">
              <Label htmlFor="new-password">New password</Label>
              <Input
                autoComplete="new-password"
                id="new-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <div className="account-field">
              <Label htmlFor="confirm-password">Confirm password</Label>
              <Input
                autoComplete="new-password"
                id="confirm-password"
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </div>
            {message ? <p className="text-sm text-destructive">{message}</p> : null}
            <Button disabled={phase === "working"} type="submit">
              {phase === "working" ? "Setting password…" : "Set new password"}
            </Button>
          </form>
        )}
      </article>
    </main>
  );
}
