import assert from "node:assert/strict";

import {
  cronSurfaces,
  liveSurfaces,
  runLedgerWriters,
  statusProbes,
  SURFACES,
  type Surface,
  type SurfaceContext,
  surfacesByKind,
  surfacesByWeight,
  surfacesForContext,
} from "./index";

const names = SURFACES.map((surface) => surface.name);
assert.equal(new Set(names).size, names.length, "surface names must be unique");

for (const surface of SURFACES) {
  assert.ok(surface.exposedContent.length > 0, `${surface.name}: exposedContent must be non-empty`);
}

for (const surface of SURFACES) {
  if (surface.probeConfig?.kind === "cron") {
    assert.equal(surface.kind, "cron", `${surface.name}: cron probe must be a cron surface`);
    assert.ok(surface.probeConfig.cronName, `${surface.name}: cron probe needs a cronName`);
  }
}

const weights = ["primary", "secondary", "tertiary", "hidden"] as const;
const contexts: readonly SurfaceContext[] = ["web", "ssh", "cli", "status"];
for (const ctx of contexts) {
  const shown = surfacesForContext(ctx);
  const byWeightTotal = weights.reduce(
    (sum, weight) => sum + surfacesByWeight(ctx, weight).length,
    0,
  );
  assert.equal(
    byWeightTotal,
    shown.length,
    `${ctx}: every displayed surface has exactly one weight in this context`,
  );

  const order = { hidden: 3, primary: 0, secondary: 1, tertiary: 2 } as const;
  for (let i = 1; i < shown.length; i++) {
    const prev = shown[i - 1]?.weights[ctx];
    const curr = shown[i]?.weights[ctx];
    if (prev && curr) {
      assert.ok(order[prev] <= order[curr], `${ctx}: surfacesForContext sorts primary→hidden`);
    }
  }
}
assert.ok(surfacesForContext("web").length > 0, "the web context displays at least one surface");
assert.ok(surfacesByWeight("web", "primary").length > 0, "the web homepage has a primary surface");

assert.equal(
  surfacesForContext("web").filter((surface) => surface.kind === "cron").length,
  0,
  "crons are not displayed in the web context",
);

assert.ok(
  surfacesByKind("cli").every((surface: Surface) => surface.kind === "cli"),
  "surfacesByKind filters by kind",
);

const probes = statusProbes();
assert.equal(
  probes.length,
  liveSurfaces().filter((surface) => surface.probeConfig !== undefined).length,
  "statusProbes returns every probeConfig-bearing LIVE surface",
);
for (const probe of probes) {
  assert.ok(probe.probeConfig.kind, "a status probe has a probe kind");
}

const crons = cronSurfaces();
assert.equal(crons.length, surfacesByKind("cron").length, "cronSurfaces is the cron kind");
for (const cron of crons) {
  assert.equal(cron.probeConfig?.kind, "cron", `${cron.name}: a cron is freshness-probed`);
}

const ledgerWriters = runLedgerWriters();
const ledgerWriterNames = ledgerWriters.map((writer) => writer.unit);
assert.equal(
  new Set(ledgerWriterNames).size,
  ledgerWriterNames.length,
  "ledger writers are unique",
);
assert.equal(ledgerWriters.length, 50, "the run-ledger roster has 46 cron + 4 direct writers");
assert.ok(
  !ledgerWriterNames.includes("fluncle-healthcheck"),
  "the non-ledger healthcheck is excluded from the run-ledger roster",
);
assert.deepEqual(
  ledgerWriters
    .filter((writer) =>
      ["fluncle-secrets-sync", "fluncle-sonar-freshen", "fluncle-timer-watchdog"].includes(
        writer.unit,
      ),
    )
    .map((writer) => [writer.unit, writer.expectedIntervalMs]),
  [
    ["fluncle-secrets-sync", 900_000],
    ["fluncle-sonar-freshen", 3_600_000],
    ["fluncle-timer-watchdog", 900_000],
  ],
  "the direct ledger writers and their cadences stay declared",
);

for (const cron of crons) {
  assert.ok(
    cron.title !== undefined && cron.title.trim().length > 0,
    `${cron.name}: a status-visible surface must carry a non-empty title`,
  );
  assert.ok(
    cron.statusDescription !== undefined && cron.statusDescription.trim().length > 0,
    `${cron.name}: a status-visible surface must carry a non-empty statusDescription`,
  );
}

const projectionMaintenance = SURFACES.find(
  (surface) => surface.name === "cron.projection-maintenance",
);
assert.ok(projectionMaintenance, "projection maintenance is registered");
assert.equal(
  projectionMaintenance.command,
  "fluncle admin projections get --json; fluncle admin projections advance --target <track_due_work|crawl_due_work> --action repair --limit 500 --max-steps <adaptive> --no-terminal-status --json; fluncle admin projections advance --target <public_aggregates|artist_qualification> --action repair --limit 500 --max-steps <adaptive> --no-terminal-status --json",
  "projection maintenance pins the one-read due/public repair budgets",
);
assert.match(
  projectionMaintenance.exposedContent.join(" "),
  /all four runtime projection families/,
  "projection maintenance exposes all four runtime families",
);
assert.match(
  projectionMaintenance.operatorNotes ?? "",
  /track, crawl, and public cutovers gate their own families independently/,
  "projection maintenance keeps independent cutover gates",
);
assert.match(
  projectionMaintenance.operatorNotes ?? "",
  /track and crawl get at most twenty pages of 500.*public aggregates and artist qualification get at most four pages of 500/,
  "projection maintenance pins the 20-step and 4-step serial budgets",
);

assert.ok(
  SURFACES.some((surface) => surface.name === "discovery.llms"),
  "the llms.txt surface is registered",
);
assert.ok(
  SURFACES.some((surface) => surface.name === "mcp.server"),
  "the MCP server surface is registered",
);
assert.ok(
  SURFACES.some((surface) => surface.name === "cron.newsletter"),
  "the newsletter cron is registered",
);

const live = liveSurfaces();
assert.equal(
  live.length,
  SURFACES.filter((surface) => surface.pending !== true).length,
  "liveSurfaces is the catalog minus pending surfaces",
);
assert.ok(
  live.every((surface) => surface.pending !== true),
  "liveSurfaces excludes every pending surface",
);

const lens = SURFACES.find((surface) => surface.name === "extension.lens");
assert.ok(lens, "the Fluncle Lens surface is registered");
assert.notEqual(lens?.pending, true, "the Fluncle Lens surface is live (not pending)");
assert.ok(
  liveSurfaces().some((surface) => surface.name === "extension.lens"),
  "the Fluncle Lens surface appears in liveSurfaces",
);
assert.ok(
  surfacesForContext("web").some((surface) => surface.name === "extension.lens"),
  "the Fluncle Lens surface appears in the web context",
);

for (const surface of SURFACES.filter((s) => s.pending === true)) {
  assert.ok(
    !liveSurfaces().some((s) => s.name === surface.name),
    `${surface.name}: a pending surface is absent from liveSurfaces`,
  );

  for (const ctx of contexts) {
    if (surface.weights[ctx] !== undefined) {
      assert.ok(
        !surfacesForContext(ctx).some((s) => s.name === surface.name),
        `${surface.name}: a pending surface is absent from surfacesForContext("${ctx}")`,
      );
      const weight = surface.weights[ctx];
      if (weight) {
        assert.ok(
          !surfacesByWeight(ctx, weight).some((s) => s.name === surface.name),
          `${surface.name}: a pending surface is absent from surfacesByWeight("${ctx}", …)`,
        );
      }
    }
  }

  assert.ok(
    !surfacesByKind(surface.kind).some((s) => s.name === surface.name),
    `${surface.name}: a pending surface is absent from surfacesByKind`,
  );

  if (surface.probeConfig !== undefined) {
    assert.ok(
      !statusProbes().some((s) => s.name === surface.name),
      `${surface.name}: a pending surface is not probed by /status`,
    );
  }
}
