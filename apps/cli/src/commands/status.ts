import { SURFACES } from "@fluncle/registry";
import { publicApiGet } from "../api";

// The three-state service health enum the /api/status endpoint emits. It mirrors
// the server's `ServiceHealthStatusSchema` (the `admin-health` contract), which
// is not re-exported from the contracts package root; the CLI is a thin client,
// so this small union is declared at the wire boundary like the rest of the
// /api/status shape below.
export type ServiceHealthStatus = "degraded" | "down" | "ok";

// One service row as the public /api/status endpoint emits it. This is the
// machine-readable sibling of the /status HTML dashboard — a non-oRPC resource
// read (carved out of the contract-coverage net), so there is no generated
// response type to import; the wire shape is mirrored here.
export type StatusService = {
  checkedAt: string;
  latencyMs: number | null;
  message: string | null;
  service: string;
  since: string;
  status: ServiceHealthStatus;
};

// The full /api/status payload: the service grid plus the server-computed
// freshness gaps (no client clock skew). `freshestReportAt` /
// `secondsSinceFreshestReport` are null until the healthcheck cron has written
// at least one snapshot.
export type StatusResponse = {
  freshestReportAt: string | null;
  generatedAt: string;
  secondsSinceFreshestReport: number | null;
  secondsSinceProberReport: number | null;
  services: StatusService[];
};

// The current health of Fluncle's services, read from the public status snapshot
// the healthcheck cron posts. A thin GET — no auth, no business logic.
export async function statusCommand(): Promise<StatusResponse> {
  return publicApiGet<StatusResponse>("/api/status");
}

// The registry tags the surfaces it expects a /status probe to cover by writing
// "Probed on /status as service `<id>`" into their `operatorNotes`. Mine those
// notes once so a service id (e.g. `r2`, `dns`, `ssh`) reads back as the surface's
// own plain-words description — the labels then track the catalog instead of a
// second hand-kept copy here. Anything the registry doesn't name (web, db, hermes)
// falls back to the raw service id.
const serviceLabels: ReadonlyMap<string, string> = (() => {
  const labels = new Map<string, string>();

  for (const surface of SURFACES) {
    const match = surface.operatorNotes?.match(/service `([a-z0-9-]+)`/);
    const id = match?.[1];
    const label = surface.exposedContent[0];

    if (id !== undefined && label !== undefined && !labels.has(id)) {
      labels.set(id, label);
    }
  }

  return labels;
})();

// The status glyph for a service's health — deadpan, no emoji (CLI register).
const statusMarks: Record<ServiceHealthStatus, string> = {
  degraded: "~",
  down: "x",
  ok: "+",
};

// How long ago a report landed, in the terse "5m ago" / "2h ago" shape. Used for
// the snapshot age so a stale board reads at a glance.
function ago(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m ago`;
  }

  if (seconds < 86_400) {
    return `${Math.round(seconds / 3600)}h ago`;
  }

  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * Render the status snapshot as a terse, deadpan board (the CLI register): one
 * aligned row per service — a health mark, the service name, its state, and a
 * short note — under a one-line headline, with the snapshot's age last. No emoji,
 * active voice. The headline reads the worst service so the top line tells the
 * whole story.
 */
export function statusLines(snapshot: StatusResponse): string[] {
  const { secondsSinceFreshestReport, services } = snapshot;

  if (services.length === 0) {
    return ["No service reports yet. The healthcheck hasn't called in."];
  }

  const down = services.filter((service) => service.status === "down").length;
  const degraded = services.filter((service) => service.status === "degraded").length;

  const headline =
    down > 0
      ? `${down} service${down === 1 ? "" : "s"} down.`
      : degraded > 0
        ? `${degraded} service${degraded === 1 ? "" : "s"} limping. The rest holds.`
        : "All services up. The Galaxy holds.";

  const nameWidth = services.reduce((width, service) => Math.max(width, service.service.length), 0);
  const stateWidth = services.reduce((width, service) => Math.max(width, service.status.length), 0);

  const lines = [headline, ""];

  for (const service of services) {
    const note = service.message ?? serviceLabels.get(service.service) ?? "";
    const row = [
      statusMarks[service.status],
      service.service.padEnd(nameWidth),
      service.status.padEnd(stateWidth),
      note,
    ]
      .join("  ")
      .trimEnd();

    lines.push(row);
  }

  if (secondsSinceFreshestReport !== null) {
    lines.push("", `Last checked ${ago(secondsSinceFreshestReport)}.`);
  }

  return lines;
}
