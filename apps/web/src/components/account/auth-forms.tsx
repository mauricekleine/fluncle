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
              callbackURL: "/account",
              email,
              name: username,
              password,
              username,
            })
          : username.includes("@")
            ? await authClient.signIn.email({ email: username, password })
            : await authClient.signIn.username({ password, username });

      if (result.error) {
        setMessage(result.error.message ?? "Could not sign in.");
        return;
      }

      await refresh();

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

const CLAIM_DISMISSED_KEY = "fluncle-claim-username-dismissed";

function claimDismissedKey(userId: string): string {
  return `${CLAIM_DISMISSED_KEY}:${userId}`;
}

function suggestUsername(email: string): string {
  return (email.split("@")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
}

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
              {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the only field in a dialog opened to claim a username; focus belongs here the moment it opens. */}
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
