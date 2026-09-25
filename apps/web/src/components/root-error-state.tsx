import { Button } from "@fluncle/ui/components/button";
import * as Sentry from "@sentry/tanstackstart-react";
import { type ErrorComponentProps, Link } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";

const COPY = {
  body: "Something came apart on my end pulling this up. Nothing you did. Give it another go, or drop back to the archive and I'll pick you up from there.",

  browse: "Back to the archive",

  heading: "Rough re-entry.",

  retry: "Try again",
} as const;

export function RootErrorState({ error, reset }: ErrorComponentProps): ReactNode {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-lg items-center justify-center px-6">
      <title>Rough re-entry · Fluncle</title>
      <meta content="noindex, follow" name="robots" />

      <div className="flex w-full flex-col items-center gap-5 rounded-2xl border border-border bg-card/85 px-8 py-10 text-center backdrop-blur-xl">
        <h1 className="text-xl font-bold text-balance text-foreground">{COPY.heading}</h1>
        <p className="text-sm leading-relaxed text-pretty text-muted-foreground">{COPY.body}</p>

        <div className="flex flex-col items-center gap-3">
          <Button onClick={reset}>{COPY.retry}</Button>
          <Link
            className="text-sm font-semibold text-muted-foreground transition-colors hover:text-[var(--eclipse-glow)]"
            to="/findings"
          >
            {COPY.browse}
          </Link>
        </div>
      </div>
    </main>
  );
}
