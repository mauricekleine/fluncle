import { type ServiceHealthStatus } from "@fluncle/contracts";
import { liveSurfaces } from "@fluncle/registry";
import { publicApiGet } from "../api";

export type StatusService = {
  checkedAt: string | null;
  latencyMs: number | null;
  message: string | null;
  service: string;
  since: string | null;
  status: ServiceHealthStatus;
};

export type StatusResponse = {
  freshestReportAt: string | null;
  generatedAt: string;
  secondsSinceFreshestReport: number | null;
  secondsSinceProberReport: number | null;
  services: StatusService[];
};

export async function statusCommand(): Promise<StatusResponse> {
  return publicApiGet<StatusResponse>("/api/v1/status");
}

const serviceLabels: ReadonlyMap<string, string> = (() => {
  const labels = new Map<string, string>();

  for (const surface of liveSurfaces()) {
    const match = surface.operatorNotes?.match(/service `([a-z0-9-]+)`/);
    const id = match?.[1];
    const label = surface.exposedContent[0];

    if (id !== undefined && label !== undefined && !labels.has(id)) {
      labels.set(id, label);
    }
  }

  return labels;
})();

const statusMarks: Record<ServiceHealthStatus, string> = {
  degraded: "~",
  down: "x",
  ok: "+",
};

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
