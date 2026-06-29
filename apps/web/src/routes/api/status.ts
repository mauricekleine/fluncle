import { createFileRoute } from "@tanstack/react-router";
import { getLiveState } from "@/lib/server/live";
import { getServiceStatuses } from "@/lib/server/status";
import { type ApiHandlers, aliasHandlers } from "./-alias";

// The PUBLIC, machine-readable sibling of the /status HTML dashboard. Same
// exposure (no auth — anyone may read the current health of Fluncle's services),
// same source store (`getServiceStatuses`), but emits JSON for a poller instead
// of HTML for a human.
//
// Two server-computed freshness gaps (no client clock skew):
//   - `secondsSinceFreshestReport`: now − the freshest `checkedAt` across ALL
//     services — "how long since ANY service was reported."
//   - `secondsSinceProberReport`: now − the `hermes` service's `checkedAt`. `hermes`
//     is the rave-02 healthcheck cron's self-liveness, posted ONLY by that cron, so
//     this is "how long since the rave-02 PROBER reported." The rave-01 watchdog's
//     dead-man's-switch cross-ping reads THIS one (not the global): rave-01 itself
//     now posts an `onion` check, which would keep the global freshest current and
//     mask rave-02 going dark — `hermes` stays untouched by rave-01.
//
// PUBLIC-SAFE BY CONSTRUCTION (this repo is open source): it echoes only the
// already-public service name / status / short message / latency / timestamps that
// the /status page shows — never an internal address (the probe + `record_health`
// keep `message` clean). The one addition beyond the health shape is `live` (the
// cross-surface live-set callout) — also public-safe: only the live boolean, the
// public Twitch stream title/startedAt, and the public channel url.
//
// Handlers live in a shared `serverHandlers` object so the canonical /api/v1 mount
// (./v1/status) and the permanent /api back-compat alias serve identical behaviour
// from this one source — exactly like ./health. Deliberately NOT an oRPC operation:
// it is a resource read like /api/health and /api/tracks (carved out of the oRPC
// coverage net), so it needs no contract.
export const serverHandlers: ApiHandlers = {
  GET: async () => {
    const [services, live] = await Promise.all([getServiceStatuses(), getLiveState()]);

    // The freshest report instant across all services = the last cron tick. Null
    // when there are no services yet (a brand-new store the cron hasn't written).
    const freshestReportMs = services.reduce<number | null>((max, service) => {
      const ms = Date.parse(service.checked_at);

      if (Number.isNaN(ms)) {
        return max;
      }

      return max === null || ms > max ? ms : max;
    }, null);

    const now = Date.now();
    const freshestReportAt =
      freshestReportMs === null ? null : new Date(freshestReportMs).toISOString();
    const secondsSinceFreshestReport =
      freshestReportMs === null ? null : Math.max(0, Math.round((now - freshestReportMs) / 1000));

    // The rave-02 PROBER's own freshness, keyed on the `hermes` service — the
    // healthcheck cron's self-liveness, which ONLY that cron posts. The dead-man's-
    // switch cross-ping (the rave-01 watchdog) reads THIS, not the global freshest:
    // rave-01 now posts its own `onion` check, which would keep
    // `secondsSinceFreshestReport` fresh and mask rave-02 going dark. `hermes` is
    // untouched by rave-01, so its staleness is the true "rave-02 prober dark" signal.
    const hermes = services.find((service) => service.service === "hermes");
    const proberReportMs = hermes ? Date.parse(hermes.checked_at) : Number.NaN;
    const secondsSinceProberReport = Number.isNaN(proberReportMs)
      ? null
      : Math.max(0, Math.round((now - proberReportMs) / 1000));

    return Response.json(
      {
        freshestReportAt,
        generatedAt: new Date(now).toISOString(),
        // The cross-surface live-set callout (staleness already applied by
        // getLiveState): `on` plus the public stream title/startedAt and the Twitch
        // url. SSH, the CLI, and dig all read this one field; the web home loader and
        // the MCP live-note read getLiveState() directly.
        live,
        secondsSinceFreshestReport,
        secondsSinceProberReport,
        services: services.map((service) => ({
          checkedAt: service.checked_at,
          latencyMs: service.latency_ms,
          message: service.message,
          service: service.service,
          since: service.since,
          status: service.status,
        })),
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  },
};

export const Route = createFileRoute("/api/status")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
