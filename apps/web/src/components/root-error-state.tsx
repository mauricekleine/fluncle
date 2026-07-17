// The site-wide error boundary — the root route's `errorComponent`, sibling of
// NotFoundBlackHole (its `notFoundComponent`). A 404 is a coordinate that
// resolves to nothing; this is a coordinate Fluncle reached for that came apart
// on the way down — re-entry gone rough (DESIGN.md: Re-entry Red is "the heat of
// coming back down", the system's one error hue). Quiet and canon-styled: a
// centered column on a Legible-Sky pane over the cosmos, one lit action (The One
// Sun), one ghost escape, and no raw error detail on a public surface.
//
// TanStack Router does NOT auto-report errors caught by a custom error boundary
// (only unhandled global errors reach Sentry's browser handlers), so this reports
// the caught error itself — captureException in an effect, per Sentry's TanStack
// Start guidance. It no-ops in dev (the browser SDK only initializes in a
// production build — see client.tsx).

import { Button } from "@fluncle/ui/components/button";
import * as Sentry from "@sentry/tanstackstart-react";
import { type ErrorComponentProps, Link } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";

const COPY = {
  // Active, first-person, dry, no exclamation, no em dash in prose (VOICE.md); owns
  // the fault ("my end"), turns to the crew, and points at a way forward. Leads with
  // the specific verb, not the generic "something went wrong" shape.
  body: "Something came apart on my end pulling this up. Nothing you did. Give it another go, or drop back to the archive and I'll pick you up from there.",
  // The quiet second escape (a ghost link home, no gold — it never competes with
  // the sun). Home is the archive of findings.
  browse: "Back to the archive",
  // The heading carries the accessible meaning; kept quiet (Title register, never
  // the Oxanium masthead — the cover art stays the hero).
  heading: "Rough re-entry.",
  // The Chrome Rule: the control names its action in plain words. The One Sun —
  // the single lit action on the page.
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

      {/* The copy sits on a pane, never the raw cosmos backdrop: a Sleeve-Black
          glass dimmed enough to hold WCAG AA even where the eclipse burns behind it
          (The Legible Sky Rule), one pane on the cosmos with the content flat on it
          (One Pane), a Dust Line hairline and no shadow (Through-the-Glass). */}
      <div className="flex w-full flex-col items-center gap-5 rounded-2xl border border-border bg-card/85 px-8 py-10 text-center backdrop-blur-xl">
        <h1 className="text-xl font-bold text-balance text-foreground">{COPY.heading}</h1>
        <p className="text-sm leading-relaxed text-pretty text-muted-foreground">{COPY.body}</p>

        <div className="flex flex-col items-center gap-3">
          <Button onClick={reset}>{COPY.retry}</Button>
          <Link
            className="text-sm font-semibold text-muted-foreground transition-colors hover:text-[var(--eclipse-glow)]"
            to="/"
          >
            {COPY.browse}
          </Link>
        </div>
      </div>
    </main>
  );
}
