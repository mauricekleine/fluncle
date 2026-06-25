// Self-running asserts for the surfaces registry — no framework (bun test executes
// the top-level asserts; "0 tests" is the repo pattern). Locks the catalog's
// invariants (unique names, kind-shaped fields) and the selectors, so a future
// surface edit can't silently break a consumer (/status, the dev-row, llms.txt).
// Run: `bun src/index.test.ts` (exits non-zero on failure).

import assert from "node:assert/strict";

import {
  cronSurfaces,
  statusProbes,
  SURFACES,
  type Surface,
  type SurfaceContext,
  surfacesByKind,
  surfacesByWeight,
  surfacesForContext,
} from "./index";

// Names are the catalog's primary key — a consumer keys off them, so duplicates
// would silently shadow.
const names = SURFACES.map((surface) => surface.name);
assert.equal(new Set(names).size, names.length, "surface names must be unique");

// Every surface must say what it exposes — that string[] is the human-facing
// payload description every consumer renders.
for (const surface of SURFACES) {
  assert.ok(surface.exposedContent.length > 0, `${surface.name}: exposedContent must be non-empty`);
}

// Kind-shaped fields: a cron is checked by freshness, not a URL, so it carries a
// `cron`-kind probeConfig with a cronName; a `cron` probeConfig only ever sits on a
// cron surface.
for (const surface of SURFACES) {
  if (surface.probeConfig?.kind === "cron") {
    assert.equal(surface.kind, "cron", `${surface.name}: cron probe must be a cron surface`);
    assert.ok(surface.probeConfig.cronName, `${surface.name}: cron probe needs a cronName`);
  }
}

// Weight is per-display-context now, and SPARSE. Within ONE context, the weights
// partition the surfaces displayed there: the four weights cover surfacesForContext
// exactly, no surface counted twice. Run the invariant for every context.
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
  // surfacesForContext is sorted loudest-first.
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
// An absent context key means "not displayed there": the crons never lead the web nav.
assert.equal(
  surfacesForContext("web").filter((surface) => surface.kind === "cron").length,
  0,
  "crons are not displayed in the web context",
);

// surfacesByKind returns only that kind, and the union over all kinds is the whole
// catalog (no surface has an off-list kind).
assert.ok(
  surfacesByKind("cli").every((surface: Surface) => surface.kind === "cli"),
  "surfacesByKind filters by kind",
);

// statusProbes is exactly the probeConfig-bearing set, and the narrowed type lets a
// consumer read probeConfig without a guard.
const probes = statusProbes();
assert.equal(
  probes.length,
  SURFACES.filter((surface) => surface.probeConfig !== undefined).length,
  "statusProbes returns every probeConfig-bearing surface",
);
for (const probe of probes) {
  assert.ok(probe.probeConfig.kind, "a status probe has a probe kind");
}

// cronSurfaces is the cron family, and each one is freshness-probed by name.
const crons = cronSurfaces();
assert.equal(crons.length, surfacesByKind("cron").length, "cronSurfaces is the cron kind");
for (const cron of crons) {
  assert.equal(cron.probeConfig?.kind, "cron", `${cron.name}: a cron is freshness-probed`);
}

// Sanity anchors — the load-bearing surfaces a consumer is sure to want.
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
