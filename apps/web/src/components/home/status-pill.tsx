import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// The home plate's footer heartbeat: a small ping-dot pill that CLIENT-FETCHES
// /api/status once on mount and reflects the live health of Fluncle's services,
// linking to the full /status dashboard. It is a quiet, best-effort signal — the
// fetch is fire-and-forget and a failure NEVER surfaces an error, it just rests in
// a neutral "checking systems" state. The dot + colours mirror the /status page's
// StatusIndicator (gold for ok, Eclipse Glow amber for degraded, Re-entry Red for
// down), and the ping animation is motion-safe so reduce-motion gets a calm dot.

// The /api/status JSON shape (the public, machine-readable sibling of /status).
// We only read each service's `status`; everything else on the payload is ignored.
export type StatusService = { status: "degraded" | "down" | "ok" };
type StatusResponse = { services: StatusService[] };

// The pill's resolved health, derived from the services list once it loads.
//   loading → neutral, pre-fetch (or a failed/empty fetch): a quiet muted dot.
//   ok      → every service operational: the alive gold heartbeat.
//   degraded/down → at least one service off: the loudest status wins (down beats
//                   degraded), with the count of services that aren't ok.
export type PillState =
  | { tone: "degraded" | "down"; count: number }
  | { tone: "loading" }
  | { tone: "ok" };

export function derivePillState(services: StatusService[]): PillState {
  if (services.length === 0) {
    // Nothing reporting yet: stay neutral rather than claim "operational".
    return { tone: "loading" };
  }

  const offCount = services.filter((service) => service.status !== "ok").length;

  if (offCount === 0) {
    return { tone: "ok" };
  }

  // Down beats degraded for the headline tone (the eye should land on the worst).
  const tone = services.some((service) => service.status === "down") ? "down" : "degraded";

  return { count: offCount, tone };
}

// The pill copy. "all systems operational" when healthy; otherwise "<n> system(s)
// degraded/down" — terse and lower-case to sit quiet in the footer (VOICE.md).
export function pillLabel(state: PillState): string {
  if (state.tone === "loading") {
    return "checking systems";
  }

  if (state.tone === "ok") {
    return "all systems operational";
  }

  const noun = state.count === 1 ? "system" : "systems";
  const verb = state.tone === "down" ? "down" : "degraded";

  return `${state.count} ${noun} ${verb}`;
}

// The dot's colour per tone, matching the /status indicator palette: gold for ok
// (the heartbeat), Eclipse Glow for degraded, Re-entry Red for down, a muted dot
// while loading. Gold "ok" is intentional and operator-approved (the /status dot
// is gold too); it's a small living signal in the footer, well under the One Sun
// budget, not a second primary.
function dotClass(tone: PillState["tone"]): string {
  if (tone === "down") {
    return "bg-destructive";
  }

  if (tone === "degraded") {
    return "bg-[var(--eclipse-glow)]";
  }

  if (tone === "ok") {
    return "bg-primary";
  }

  return "bg-muted-foreground/50";
}

export function HomeStatusPill() {
  const [state, setState] = useState<PillState>({ tone: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    async function loadStatus(): Promise<void> {
      try {
        const response = await fetch("/api/status", { signal: controller.signal });

        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as StatusResponse;

        if (Array.isArray(payload.services)) {
          setState(derivePillState(payload.services));
        }
      } catch {
        // Best-effort only: a failed fetch (offline, aborted, malformed) leaves the
        // pill in its quiet neutral state. Never an error — this is a footer detail.
      }
    }

    void loadStatus();

    return () => {
      controller.abort();
    };
  }, []);

  const tone = state.tone;
  const pinging = tone === "ok" || tone === "degraded" || tone === "down";

  return (
    <Link
      aria-label={`System status: ${pillLabel(state)}`}
      className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary/40 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-[color-mix(in_oklch,var(--primary)_40%,transparent)] hover:text-accent-foreground"
      to="/status"
    >
      <span className="relative flex size-1.5">
        {pinging ? (
          <span
            aria-hidden
            className={cn(
              "absolute inline-flex size-full rounded-full opacity-60 motion-safe:animate-ping",
              dotClass(tone),
            )}
          />
        ) : undefined}
        <span
          aria-hidden
          className={cn("relative inline-flex size-1.5 rounded-full", dotClass(tone))}
        />
      </span>
      {pillLabel(state)}
    </Link>
  );
}
