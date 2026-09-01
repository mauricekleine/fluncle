/**
 * The discovery walk's journey-organised summary — the pure half of `discovery-walk.ts`, kept
 * apart so it can be unit-tested and so the CI job can print the same table into its step
 * summary that the retained `summary.md` carries. One markdown document: the served commit
 * the walk attributes to, then one table per journey per viewport, one row per step, with the
 * observed destination, the outbound target, the robots directive, and the analytics events
 * the step sent. A verifier reads this without a repository, a browser, or a download.
 */

export type WalkStep = {
  beacons: string[];
  canonical: string | null;
  errors: string[];
  outbound: string | null;
  robots: string | null;
  screenshot: string;
  status: number | null;
  step: string;
  title: string;
  url: string;
};

export type WalkIndex = {
  base: string;
  journeys: Record<string, WalkStep[]>;
  /** The commit `<base>/api/v1/health` reported, so the evidence names what it walked. */
  served: string | null;
  viewport: { height: number; name: string; width: number };
};

/** The bounded event names a beacon carries (`event=discovery_open`), nothing else from its URL. */
export function beaconEvents(beacons: string[]): string[] {
  return beacons.flatMap((beacon) => {
    const match = /[?&]event=([a-z_]+)/.exec(beacon);

    return match?.[1] ? [match[1]] : [];
  });
}

function cell(value: string | null | undefined): string {
  return (value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim() || "—";
}

function relative(url: string, base: string): string {
  return url.startsWith(base) ? url.slice(base.length) || "/" : url;
}

export function renderWalkSummary(indexes: WalkIndex[]): string {
  const lines: string[] = ["# Discovery walk", ""];
  const bases = [...new Set(indexes.map((index) => index.base))];
  const served = [...new Set(indexes.map((index) => index.served ?? "unknown"))];

  lines.push(`Walked ${bases.join(", ")} serving commit ${served.join(", ")}.`, "");

  for (const index of indexes) {
    const errorCount = Object.values(index.journeys)
      .flat()
      .reduce((sum, step) => sum + step.errors.length, 0);

    lines.push(
      `## ${index.viewport.name} (${index.viewport.width}×${index.viewport.height}) — ${errorCount === 0 ? "no console or page errors" : `${errorCount} console/page error(s)`}`,
      "",
    );

    for (const [journey, steps] of Object.entries(index.journeys)) {
      lines.push(
        `### ${journey}`,
        "",
        "| step | destination | status | robots | outbound | events | screenshot |",
        "|---|---|---|---|---|---|---|",
      );

      for (const step of steps) {
        lines.push(
          `| ${cell(step.step)} | ${cell(relative(step.url, index.base))} | ${step.status ?? "—"} | ${cell(step.robots ?? "index")} | ${cell(step.outbound)} | ${cell(beaconEvents(step.beacons).join(", "))} | ${cell(step.screenshot)} |`,
        );
      }

      lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
