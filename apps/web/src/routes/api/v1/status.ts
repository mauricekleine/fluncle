import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "@/lib/server/db";
import { getLiveState } from "@/lib/server/live";
import { getServiceStatuses } from "@/lib/server/status";

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

export const serverHandlers = {
  GET: async () => {
    const [services, live, dbProbe] = await Promise.all([
      getServiceStatuses(),
      getLiveState(),
      probeDbRoundTrip(),
    ]);

    const freshestReportMs = services.reduce<number | null>((max, service) => {
      if (service.checked_at === null) {
        return max;
      }

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

    const hermes = services.find((service) => service.service === "hermes");
    const proberReportMs = hermes?.checked_at ? Date.parse(hermes.checked_at) : Number.NaN;
    const secondsSinceProberReport = Number.isNaN(proberReportMs)
      ? null
      : Math.max(0, Math.round((now - proberReportMs) / 1000));

    return Response.json(
      {
        dbProbe,
        freshestReportAt,
        generatedAt: new Date(now).toISOString(),

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
  server: { handlers: serverHandlers },
});
