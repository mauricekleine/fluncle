// Self-running check for the INPUT caps on the batch-shaped admin writes — no framework, the
// `devices.test.ts` style. Every op here is AGENT tier: the box's token drives them, so the threat is
// a buggy or compromised sweep posting an unbounded payload, not a stranger. Each cap is asserted at
// the cap (accepted — the real sizes are far below it) and one past it (REJECTED at the edge, never
// trimmed: a dropped cost row is a wrong ledger, a dropped cluster is a broken map).
// Run: `bun src/orpc/input-caps.test.ts`.

import assert from "node:assert/strict";

import { DEEZER_CANDIDATE_LIMIT, resolveAnchor } from "./admin-catalogue";
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

// ── resolve_anchor: the box-fetched Deezer hits, bounded on every axis ─────────────────────
//
// This one is not merely a batch cap. The whole point of moving the Deezer FETCH to the box is that
// the box is a source we deliberately do NOT trust — the Worker re-verifies every hit before an ISRC
// is written. An untrusted source's payload is exactly the thing to bound at the edge, so a malformed
// one fails as a clean 400 instead of reaching the handler at all.
{
  const hit = (over: Record<string, unknown> = {}) => ({
    artistName: "Muffler",
    durationMs: 201_000,
    isrc: "GBTESTDZ0001",
    title: "Dribble",
    ...over,
  });

  assert.equal(
    accepts(resolveAnchor, { trackId: "mb_1" }),
    true,
    "no hits at all is the pre-box shape: the Worker searches Deezer itself",
  );
  assert.equal(
    accepts(resolveAnchor, { deezerCandidates: [], trackId: "mb_1" }),
    true,
    "an EMPTY list is a first-class answer — the box searched and found nothing",
  );

  // The array cap IS Deezer's page size: more hits than Deezer itself pages is already wrong.
  assert.equal(
    accepts(resolveAnchor, {
      deezerCandidates: Array.from({ length: DEEZER_CANDIDATE_LIMIT }, () => hit()),
      trackId: "mb_1",
    }),
    true,
    "a payload AT the cap is accepted",
  );
  assert.equal(
    accepts(resolveAnchor, {
      deezerCandidates: Array.from({ length: DEEZER_CANDIDATE_LIMIT + 1 }, () => hit()),
      trackId: "mb_1",
    }),
    false,
    "one hit past the cap is rejected",
  );

  // The three strings are bounded, generously — a cap that bit a real billing or title would turn a
  // recoverable row into a rejected call, which is the worse failure.
  assert.equal(
    accepts(resolveAnchor, {
      deezerCandidates: [hit({ artistName: "a".repeat(300), title: "b".repeat(300) })],
      trackId: "mb_1",
    }),
    true,
    "strings AT the length cap are accepted",
  );
  assert.equal(
    accepts(resolveAnchor, {
      deezerCandidates: [hit({ artistName: "a".repeat(301) })],
      trackId: "mb_1",
    }),
    false,
    "an oversized artistName is rejected",
  );
  assert.equal(
    accepts(resolveAnchor, {
      deezerCandidates: [hit({ title: "b".repeat(301) })],
      trackId: "mb_1",
    }),
    false,
    "an oversized title is rejected",
  );
  assert.equal(
    accepts(resolveAnchor, { deezerCandidates: [hit({ isrc: "c".repeat(65) })], trackId: "mb_1" }),
    false,
    "an oversized isrc is rejected",
  );

  // A duration that is not a recording length. The gate would read each of these as a plain miss —
  // indistinguishable from an honest one — so the boundary names it instead.
  for (const durationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      accepts(resolveAnchor, { deezerCandidates: [hit({ durationMs })], trackId: "mb_1" }),
      false,
      `a durationMs of ${String(durationMs)} is rejected`,
    );
  }

  // …and the fields are still REQUIRED: a hit missing one cannot be verified against the row.
  assert.equal(
    accepts(resolveAnchor, { deezerCandidates: [{ isrc: "GBTESTDZ0001" }], trackId: "mb_1" }),
    false,
    "a hit missing the gate's signals is rejected",
  );
}

console.log("input-caps: ok");
