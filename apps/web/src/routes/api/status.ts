import { createFileRoute } from "@tanstack/react-router";
import { getServiceStatuses } from "@/lib/server/status";
import { type ApiHandlers, aliasHandlers } from "./-alias";

// The PUBLIC, machine-readable sibling of the /status HTML dashboard. Same
// exposure (no auth — anyone may read the current health of Fluncle's services),
// same source store (`getServiceStatuses`), but emits JSON for a poller instead
// of HTML for a human.
//
// Its load-bearing field is `secondsSinceFreshestReport`: the server-computed gap
// between now and the freshest `checkedAt` across all services. Because the
// healthcheck cron (on the Hermes box, "rave-02") rewrites EVERY service's
// `checkedAt` on each ~10m tick, `max(checkedAt)` is the last cron tick — so this
// number answers "how long since the rave-02 prober last reported anything." The
// rave-01 watchdog reads exactly this one integer to decide whether the prober has
// gone dark (the dead-man's-switch cross-ping). Computing it server-side avoids any
// client clock skew.
//
// PUBLIC-SAFE BY CONSTRUCTION (this repo is open source): it echoes only the
// already-public service name / status / short message / latency / timestamps that
// the /status page shows — never an internal address (the probe + `record_health`
// keep `message` clean). No field beyond the documented shape is added.
//
// Handlers live in a shared `serverHandlers` object so the canonical /api/v1 mount
// (./v1/status) and the permanent /api back-compat alias serve identical behaviour
// from this one source — exactly like ./health. Deliberately NOT an oRPC operation:
// it is a resource read like /api/health and /api/tracks (carved out of the oRPC
// coverage net), so it needs no contract.
export const serverHandlers: ApiHandlers = {
  GET: async () => {
    const services = await getServiceStatuses();

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

    return Response.json(
      {
        freshestReportAt,
        generatedAt: new Date(now).toISOString(),
        secondsSinceFreshestReport,
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
