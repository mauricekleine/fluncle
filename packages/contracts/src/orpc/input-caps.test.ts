// Self-running check for the ARRAY-LENGTH caps on the two batch-shaped admin writes — no
// framework, the `devices.test.ts` style. Both ops are AGENT tier: the box's token drives them, so
// the threat is a buggy or compromised sweep posting an unbounded batch into one transactional
// write, not a stranger. Each cap is asserted at the cap (accepted — the real batch sizes are far
// below it) and one past it (REJECTED at the edge, never trimmed: a dropped cost row is a wrong
// ledger, a dropped cluster is a broken map). Run: `bun src/orpc/input-caps.test.ts`.

import assert from "node:assert/strict";

import { recordCost } from "./admin-costs";
import { updateGalaxyMap } from "./admin-galaxies";

/**
 * The Standard Schema surface we need, spelled out locally rather than imported from
 * `@standard-schema/spec` (a transitive dep of oRPC, not one this package declares).
 */
type Validator = {
  "~standard": {
    validate: (input: unknown) => { issues?: readonly unknown[] } | Promise<unknown>;
  };
};

/** Does the op's declared INPUT schema accept this body? */
function accepts(op: unknown, input: unknown): boolean {
  const schema = (op as { "~orpc": { inputSchema?: Validator } })["~orpc"].inputSchema;

  assert.ok(schema, "the op declares an input schema");

  const result = schema["~standard"].validate(input);

  assert.ok(!(result instanceof Promise), "validation is synchronous");

  return result.issues === undefined;
}

// ── record_cost: at most 500 rows per batch (the widest sweep queue is 50) ────────────────
{
  const event = (index: number) => ({
    costBasis: "cash" as const,
    id: `evt-${index}`,
    occurredAt: "2026-07-26T00:00:00.000Z",
    quantity: 1,
    source: "measured" as const,
    step: "embed" as const,
    unitType: "seconds" as const,
    vendor: "self" as const,
  });

  assert.equal(accepts(recordCost, [event(0)]), true, "a one-row batch is the common case");
  assert.equal(
    accepts(
      recordCost,
      Array.from({ length: 500 }, (_, i) => event(i)),
    ),
    true,
    "a batch AT the cap is accepted",
  );
  assert.equal(
    accepts(
      recordCost,
      Array.from({ length: 501 }, (_, i) => event(i)),
    ),
    false,
    "one row past the cap is rejected",
  );
}

// ── update_galaxy_map: at most 64 clusters, each centroid at most 2048 floats ─────────────
{
  const cluster = (dimensions = 1024) => ({
    centroid: Array.from({ length: dimensions }, () => 0.1),
    id: null,
  });

  // k = 9 today; the live shape must stay comfortably inside both caps.
  assert.equal(
    accepts(updateGalaxyMap, { clusters: Array.from({ length: 9 }, () => cluster()) }),
    true,
    "the live k=9 map with 1024-dim centroids is accepted",
  );
  assert.equal(
    accepts(updateGalaxyMap, { clusters: Array.from({ length: 64 }, () => cluster(8)) }),
    true,
    "a map AT the cluster cap is accepted",
  );
  assert.equal(
    accepts(updateGalaxyMap, { clusters: Array.from({ length: 65 }, () => cluster(8)) }),
    false,
    "one cluster past the cap is rejected",
  );
  assert.equal(
    accepts(updateGalaxyMap, { clusters: [cluster(2048)] }),
    true,
    "a centroid AT the dimension cap is accepted",
  );
  assert.equal(
    accepts(updateGalaxyMap, { clusters: [cluster(2049)] }),
    false,
    "one dimension past the cap is rejected",
  );
}

console.log("input-caps: ok");
