import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

export type StatusService = { status: "degraded" | "down" | "ok" };
type StatusResponse = { services: StatusService[] };

export type PillState =
  | { tone: "degraded" | "down"; count: number }
  | { tone: "loading" }
  | { tone: "ok" };

export function derivePillState(services: StatusService[]): PillState {
  if (services.length === 0) {
    return { tone: "loading" };
  }

  const offCount = services.filter((service) => service.status !== "ok").length;

  if (offCount === 0) {
    return { tone: "ok" };
  }

  const tone = services.some((service) => service.status === "down") ? "down" : "degraded";

  return { count: offCount, tone };
}

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

const STATUS_PILL_QUERY_KEY = ["home-status-pill"] as const;

async function fetchStatusServices(signal: AbortSignal): Promise<StatusService[]> {
  const response = await fetch("/api/v1/status", { signal });

  if (!response.ok) {
    throw new Error(`status ${response.status}`);
  }

  const payload = (await response.json()) as StatusResponse;

  if (!Array.isArray(payload.services)) {
    throw new Error("malformed status payload");
  }

  return payload.services;
}

export function HomeStatusPill() {
  const { data } = useQuery({
    queryFn: ({ signal }) => fetchStatusServices(signal),
    queryKey: STATUS_PILL_QUERY_KEY,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60_000,
  });

  const state: PillState = data ? derivePillState(data) : { tone: "loading" };
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
