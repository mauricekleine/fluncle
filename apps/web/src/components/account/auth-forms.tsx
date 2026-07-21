// The signed-OUT and just-arrived surfaces of the account area: the sign-in / create
// forms, the forgot-password panel, and the claim-username dialog a fresh Google
// arrival meets. Lifted out of the account monolith unchanged — every flow mutates
// then refreshes (the route repoints `refresh` to a react-query invalidation, so the
// same call still re-reads the session).

import { useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@fluncle/ui/components/dialog";
import { Input } from "@fluncle/ui/components/input";
import { Tabs, TabsList, TabsTrigger } from "@fluncle/ui/components/tabs";
import { siGoogle } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { authClient } from "@/lib/auth-client";
import { siteUrl } from "@/lib/fluncle-links";
import { type AccountUser, Field } from "./shared";

export function AuthForms({
  googleEnabled,
  message,
  refresh,
  setMessage,
}: {
  googleEnabled: boolean;
  message: string;
  refresh: () => Promise<void>;
  setMessage: (message: string) => void;
}) {
  const [view, setView] = useState<"auth" | "reset">("auth");
  // "Join the crew" is the door most arrivals came through — default to joining.
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    setBusy(true);

    try {
      const result =
        mode === "signup"
          ? await authClient.signUp.email({
              // Where the email-verification link lands the user once they click it
              // (Better Auth signs them in first via autoSignInAfterVerification).
              callbackURL: "/account",
              email,
              name: username,
              password,
              username,
            })
          : // The recall-friendly identifier: a returning user remembers their
            // email more reliably than a handle picked in passing — accept either.
            username.includes("@")
            ? await authClient.signIn.email({ email: username, password })
            : await authClient.signIn.username({ password, username });

      if (result.error) {
        setMessage(result.error.message ?? "Could not sign in.");
        return;
      }

      await refresh();
      // Signing in needs no toast — the account appearing is the confirmation. A
      // sign-up keeps one useful line: where the verification link went.
      setMessage(
        mode === "signup"
          ? "I sent a link to verify your email. You're already signed in, so there's no rush."
          : "",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : mode === "signup"
            ? "Could not create the account."
            : "Could not sign in.",
      );
    } finally {
      setBusy(false);
    }
  }

  // "Continue with Google" — a full-page OAuth redirect to Google, back to /account.
  // On success the browser navigates away (no busy reset needed); on a synchronous
  // failure to start the flow, surface it and re-enable the form.
  async function continueWithGoogle() {
    setMessage("");
    setBusy(true);

    try {
      await authClient.signIn.social({ callbackURL: "/account", provider: "google" });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not continue with Google.");
      setBusy(false);
    }
  }

  if (view === "reset") {
    return (
      <ForgotPasswordForm
        onBack={() => {
          setView("auth");
          setMessage("");
        }}
      />
    );
  }

  return (
    <form className="account-stack" onSubmit={(event) => void submit(event)}>
      <Tabs
        value={mode}
        onValueChange={(value) => {
          setMode(value as "signin" | "signup");
          setMessage("");
        }}
      >
        <TabsList className="w-full">
          <TabsTrigger value="signin">Sign in</TabsTrigger>
          <TabsTrigger value="signup">Create account</TabsTrigger>
        </TabsList>
      </Tabs>
      {googleEnabled ? (
        <>
          <Button
            className="w-full"
            disabled={busy}
            onClick={() => void continueWithGoogle()}
            type="button"
            variant="outline"
          >
            <BrandIcon className="size-4" icon={siGoogle} />
            Continue with Google
          </Button>
          <p className="account-muted text-center text-xs">or use your email</p>
        </>
      ) : null}
      {mode === "signup" ? (
        <Field label="Email">
          <Input
            autoComplete="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
      ) : null}
      <Field
        hint={
          mode === "signup"
            ? "3–24 characters: lowercase letters, numbers, underscores. Your handle across Fluncle."
            : undefined
        }
        label={mode === "signin" ? "Email or username" : "Username"}
      >
        <Input
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </Field>
      <Field label="Password">
        <Input
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      {mode === "signin" ? (
        <button
          className="self-start text-sm text-muted-foreground hover:text-accent-foreground"
          onClick={() => {
            setView("reset");
            setMessage("");
          }}
          type="button"
        >
          Forgot password?
        </button>
      ) : null}
      <Button disabled={busy} type="submit">
        {busy
          ? mode === "signup"
            ? "Creating account…"
            : "Signing in…"
          : mode === "signup"
            ? "Create private account"
            : "Sign in"}
      </Button>
      {message ? (
        <p aria-live="polite" className="account-muted">
          {message}
        </p>
      ) : null}
    </form>
  );
}

// The "Forgot password?" panel: collect the account email and ask Better Auth to
// send a reset link (its `/request-password-reset` endpoint, delivered by the
// server's `sendResetPassword` → Resend). The confirmation is deliberately identical
// whether or not the email is on an account — email-enumeration-safe — so the send
// error (if any) is swallowed and the same line always shows.
function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);

    try {
      await authClient.requestPasswordReset({
        email,
        redirectTo: `${siteUrl}/reset-password`,
      });
    } catch {
      // Swallow — the confirmation below is the same either way (enumeration-safe).
    } finally {
      setBusy(false);
      setSent(true);
    }
  }

  return (
    <form className="account-stack" onSubmit={(event) => void submit(event)}>
      <div>
        <h2>Reset your password</h2>
        <p className="account-muted">
          Enter your account email and I&rsquo;ll send a link to set a new password.
        </p>
      </div>
      <Field label="Email">
        <Input
          autoComplete="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      <Button disabled={busy} type="submit">
        {busy ? "Sending…" : "Send reset link"}
      </Button>
      {sent ? (
        <p aria-live="polite" className="account-muted">
          If that account exists, a reset link is on its way.
        </p>
      ) : null}
      <button
        className="self-start text-sm text-muted-foreground hover:text-accent-foreground"
        onClick={onBack}
        type="button"
      >
        Back to sign in
      </button>
    </form>
  );
}

// The dismissal marker for the claim-username dialog: per-tab-session, so "Not now"
// holds for the visit but the door knocks again next time — a missing handle keeps
// saves and submissions nameless, which is worth one quiet re-ask.
// Durable per ACCOUNT (localStorage, keyed by user id): "Not now" means not now for
// this account on this browser — the door doesn't knock again every session. The
// username prompt keeps a durable home in Settings → Profile either way.
const CLAIM_DISMISSED_KEY = "fluncle-claim-username-dismissed";

function claimDismissedKey(userId: string): string {
  return `${CLAIM_DISMISSED_KEY}:${userId}`;
}

/** The email's local part, folded into a valid handle suggestion ("hey@…" → "hey"). */
function suggestUsername(email: string): string {
  return (email.split("@")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
}

/**
 * The claim-username moment. A fresh Google arrival lands signed in but nameless —
 * instead of hiding a hint in Settings, the page opens one small dialog with the
 * handle prefilled from their email. Claiming is one tap; "Not now" dismisses it
 * for the session and Settings keeps the field either way.
 */
export function ClaimUsernameDialog({
  csrfToken,
  refresh,
  user,
}: {
  csrfToken: string;
  refresh: () => Promise<void>;
  user: AccountUser;
}) {
  const [open, setOpen] = useState(
    () =>
      !user.username &&
      typeof window !== "undefined" &&
      window.localStorage.getItem(claimDismissedKey(user.id)) !== "1",
  );
  const [value, setValue] = useState(() => suggestUsername(user.email));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function dismiss() {
    window.localStorage.setItem(claimDismissedKey(user.id), "1");
    setOpen(false);
  }

  async function claim(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      const response = await fetch("/api/v1/me/profile", {
        body: JSON.stringify({ name: user.name || value, username: value }),
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
        method: "PATCH",
      });

      if (!response.ok) {
        setError(((await response.json()) as { message: string }).message);

        return;
      }

      setOpen(false);
      await refresh();
    } catch {
      setError("Could not save right now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  if (user.username) {
    return null;
  }

  return (
    <Dialog onOpenChange={(next: boolean) => (next ? setOpen(true) : dismiss())} open={open}>
      <DialogContent>
        <form onSubmit={(event) => void claim(event)}>
          <DialogHeader>
            <DialogTitle>Claim your username</DialogTitle>
            <DialogDescription>
              Your handle across Fluncle: it names your saves and submissions. You can change it
              later in Settings.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Field label="Username">
              <Input autoFocus onChange={(event) => setValue(event.target.value)} value={value} />
            </Field>
            {error ? (
              <p aria-live="polite" className="account-muted mt-2">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button disabled={busy} onClick={dismiss} type="button" variant="ghost">
              Not now
            </Button>
            <Button disabled={busy || value.trim().length < 3} type="submit">
              {busy ? "Claiming…" : "Claim username"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
