import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "@/lib/server/db";
import { getLiveState } from "@/lib/server/live";
import { getServiceStatuses } from "@/lib/server/status";
import { type ApiHandlers, aliasHandlers } from "../-alias";

/**
 * A WORKER-vantage Turso round-trip sample: the Worker times a `select 1` to the Turso
 * primary (aws-eu-west-1, Dublin) on THIS request. It is the exact path a visitor's page
 * load pays — a Cloudflare Worker at the edge reaching across to the Dublin primary — so it
 * is the honest signal for "how is Turso responding right now", as opposed to the rave-02
 * prober's box→Turso path. `select 1` isolates the network + connection cost from any query
 * work, which is what makes a trend of it a clean read on latency/jitter over time.
 *
 * NON-FATAL by construction: a probe failure returns `null` and never breaks the status
 * response (the whole point of /status is to stay up while something else is down). The
 * healthcheck cron reads this field on its /api/v1/status GET and records it as the `db`
 * service, so the sample flows into the existing `service_check_samples` uptime series —
 * no new storage, no per-request write.
 */
async function probeDbRoundTrip(): Promise<{ at: string; roundTripMs: number } | null> {
  try {
    const db = await getDb();
    const started = performance.now();
    await db.execute("select 1");

    return { at: new Date().toISOString(), roundTripMs: Math.round(performance.now() - started) };
  } catch {
    return null;
  }
}

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
// The vocabulary cut removed the bare `/api/status` back-compat alias: this is the
// single canonical mount. Deliberately NOT an oRPC operation — it is a resource read
// like /api/v1/health (carved out of the oRPC coverage net), so it needs no contract.
export const serverHandlers: ApiHandlers = {
  GET: async () => {
    const [services, live, dbProbe] = await Promise.all([
      getServiceStatuses(),
      getLiveState(),
      probeDbRoundTrip(),
    ]);

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
        // This request's Worker→Turso (Dublin) round-trip, or null if the probe failed.
        // A poller (the healthcheck cron) turns a series of these into the `db` uptime bar.
        dbProbe,
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

export const Route = createFileRoute("/api/v1/status")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
