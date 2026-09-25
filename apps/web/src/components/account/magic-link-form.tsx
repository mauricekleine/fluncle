import { useEffect, useRef, useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { Input } from "@fluncle/ui/components/input";
import { authClient } from "@/lib/auth-client";
import { Field } from "./shared";

export const MAGIC_LINK_MINUTES = 15;

export function magicLinkErrorMessage(status: number | undefined): string {
  if (status === 429) {
    return "That's a lot of links for one hour. Try again a bit later.";
  }

  if (status === 400) {
    return "That email doesn't look right. Check it and try again.";
  }

  return "I couldn't send the link just now. Try again in a moment.";
}

export function MagicLinkForm({
  callbackURL,
  disabled,
  hint,
  metadata,
  onSent,
  sentNote,
}: {
  callbackURL: string;
  disabled?: boolean;
  hint?: string;
  metadata?: Record<string, unknown>;
  onSent?: (email: string) => void;
  sentNote?: string;
}) {
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sentTo, setSentTo] = useState<string | undefined>(undefined);
  const [lastEmail, setLastEmail] = useState<string | undefined>(undefined);
  const sentRef = useRef<HTMLParagraphElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const returning = useRef(false);

  useEffect(() => setHydrated(true), []);

  useEffect(() => {
    if (sentTo) {
      sentRef.current?.focus();
    } else if (returning.current) {
      returning.current = false;
      formRef.current?.querySelector("input")?.focus();
    }
  }, [sentTo]);

  async function send(address: string) {
    setError("");
    setBusy(true);

    try {
      const result = await authClient.signIn.magicLink({
        callbackURL,
        email: address,
        errorCallbackURL: callbackURL,
        ...(metadata ? { metadata } : {}),
      });

      if (result.error) {
        setError(magicLinkErrorMessage(result.error.status));

        return;
      }

      setLastEmail(address);
      setSentTo(address);
      onSent?.(address);
    } catch {
      setError(magicLinkErrorMessage(undefined));
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <div className="account-stack" data-testid="magic-link-sent">
        <p className="magic-link-sent" ref={sentRef} tabIndex={-1}>
          Check your inbox. I sent a link to <strong>{sentTo}</strong>. It signs you in and works
          for the next {MAGIC_LINK_MINUTES} minutes.
          {sentNote ? ` ${sentNote}` : null}
        </p>
        {error ? (
          <p className="account-muted" role="alert">
            {error}
          </p>
        ) : null}
        <div className="magic-link-actions">
          <Button
            disabled={busy}
            onClick={() => void send(sentTo)}
            size="sm"
            type="button"
            variant="outline"
          >
            {busy ? "Sending…" : "Send the link again"}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              returning.current = true;
              setSentTo(undefined);
              setError("");
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            Use a different email
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="account-stack"
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        const address = new FormData(event.currentTarget).get("email");

        void send(typeof address === "string" ? address.trim() : "");
      }}
    >
      <Field hint={hint} label="Email">
        <Input
          autoComplete="email"
          defaultValue={lastEmail}
          inputMode="email"
          name="email"
          required
          type="email"
        />
      </Field>
      <Button disabled={busy || disabled || !hydrated} type="submit">
        {busy ? "Sending…" : "Email me a link"}
      </Button>
      {error ? (
        <p className="account-muted" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
