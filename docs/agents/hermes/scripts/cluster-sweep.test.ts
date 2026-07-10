// Unit tests for the pure helpers in cluster-sweep.ts — the box-script sweep is
// self-contained (it can't import the workspace) and lives outside any package's test
// runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/cluster-sweep.test.ts
//
// `main()` is guarded behind `import.meta.main` in the sweep, so importing it here is
// side-effect free (no fluncle spawn, no python, no network). These cover the engine's
// LOAD-BEARING math (the RFC acceptance criteria): nearest-centroid assignment, the
// mean-centroid recompute, the FIXED-POINT invariant, the empty-retire path, the diff that
// keeps a nightly write to "a handful", the split's larger-first continuity, and silhouette.
import { describe, expect, test } from "bun:test";

import {
  assignFindings,
  changedAssignments,
  cosineSilhouette,
  dot,
  type Finding,
  type Galaxy,
  l2normalize,
  meanVector,
  nearestGalaxyId,
  parseMode,
  planSplit,
  recomputeCentroids,
} from "./cluster-sweep";

// Two well-separated 2-D clusters: A hugs [1,0], B hugs [0,1] (all unit vectors, so cosine
// == dot, the MuQ-space property the engine relies on).
const A: Galaxy = { centroid: [1, 0], id: "gal_a" };
const B: Galaxy = { centroid: [0, 1], id: "gal_b" };

function unit(x: number, y: number): number[] {
  return l2normalize([x, y]);
}

const corpus: Finding[] = [
  { embedding: unit(1, 0.1), galaxyId: "gal_a", trackId: "t1" },
  { embedding: unit(1, 0.2), galaxyId: "gal_a", trackId: "t2" },
  { embedding: unit(0.1, 1), galaxyId: "gal_b", trackId: "t3" },
  { embedding: unit(0.2, 1), galaxyId: "gal_b", trackId: "t4" },
];

describe("vector primitives", () => {
  test("dot is the sum of products; mismatched lengths floor to 0", () => {
    expect(dot([1, 2, 3], [1, 2, 3])).toBe(14);
    expect(dot([1, 0], [1, 0, 0])).toBe(0);
  });

  test("l2normalize yields a unit vector and never divides by zero", () => {
    const n = l2normalize([3, 4]);
    expect(Math.hypot(n[0], n[1])).toBeCloseTo(1, 10);
    expect(l2normalize([0, 0])).toEqual([0, 0]);
  });

  test("meanVector is the normalized elementwise mean; empty is null", () => {
    const m = meanVector([
      [1, 0],
      [0, 1],
    ]);
    expect(m).not.toBeNull();
    expect(Math.hypot(m?.[0] ?? 0, m?.[1] ?? 0)).toBeCloseTo(1, 10);
    expect(meanVector([])).toBeNull();
  });
});

describe("nearestGalaxyId", () => {
  test("picks the higher-cosine centroid", () => {
    expect(nearestGalaxyId(unit(1, 0.1), [A, B])).toBe("gal_a");
    expect(nearestGalaxyId(unit(0.1, 1), [A, B])).toBe("gal_b");
  });

  test("no galaxies -> null (an empty map has nothing to assign to)", () => {
    expect(nearestGalaxyId(unit(1, 0), [])).toBeNull();
  });

  test("a tie breaks on the earliest galaxy (deterministic)", () => {
    // Equidistant from both centroids -> the first one in the list wins.
    expect(nearestGalaxyId(unit(1, 1), [A, B])).toBe("gal_a");
    expect(nearestGalaxyId(unit(1, 1), [B, A])).toBe("gal_b");
  });
});

describe("assignFindings + changedAssignments", () => {
  test("assigns each finding to its nearest galaxy", () => {
    const assignments = assignFindings(corpus, [A, B]);
    expect(assignments.map((a) => a.galaxyId)).toEqual(["gal_a", "gal_a", "gal_b", "gal_b"]);
  });

  test("changedAssignments keeps only the findings that MOVED (a handful per night)", () => {
    // Corpus already sits in its nearest galaxy -> nothing changed.
    expect(changedAssignments(assignFindings(corpus, [A, B]))).toHaveLength(0);

    // A finding currently in B but nearest to A is the only move.
    const drifting: Finding[] = [{ embedding: unit(1, 0.05), galaxyId: "gal_b", trackId: "t5" }];
    const changed = changedAssignments(assignFindings(drifting, [A, B]));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      galaxyId: "gal_a",
      previousGalaxyId: "gal_b",
      trackId: "t5",
    });
  });

  test("a NEW finding (galaxyId null) reads as changed", () => {
    const fresh: Finding[] = [{ embedding: unit(1, 0), galaxyId: null, trackId: "t6" }];
    expect(changedAssignments(assignFindings(fresh, [A, B]))).toHaveLength(1);
  });
});

describe("recomputeCentroids", () => {
  test("each centroid becomes its members' normalized mean", () => {
    const assignedById = new Map(
      assignFindings(corpus, [A, B]).map((a) => [a.trackId, a.galaxyId]),
    );
    const { centroids, emptied } = recomputeCentroids(corpus, assignedById, ["gal_a", "gal_b"]);
    expect(emptied).toHaveLength(0);
    const a = centroids.get("gal_a");
    expect(a).toBeDefined();
    expect(Math.hypot(a?.[0] ?? 0, a?.[1] ?? 0)).toBeCloseTo(1, 10);
    // gal_a's members lean toward +x, so its x-component dominates.
    expect((a?.[0] ?? 0) > (a?.[1] ?? 0)).toBe(true);
  });

  test("a galaxy that ended with zero members is emptied (the retire path)", () => {
    // Force everything into gal_a; gal_b keeps no members.
    const assignedById = new Map(corpus.map((f) => [f.trackId, "gal_a"]));
    const { centroids, emptied } = recomputeCentroids(corpus, assignedById, ["gal_a", "gal_b"]);
    expect(emptied).toEqual(["gal_b"]);
    expect(centroids.has("gal_b")).toBe(false);
    expect(centroids.has("gal_a")).toBe(true);
  });
});

describe("the fixed-point invariant (RFC acceptance)", () => {
  test("assign -> recompute -> assign is stable: identical labels, centroids within 1e-6", () => {
    const galaxies = [A, B];
    const first = assignFindings(corpus, galaxies);
    const assignedById = new Map(first.map((a) => [a.trackId, a.galaxyId]));
    const { centroids } = recomputeCentroids(corpus, assignedById, ["gal_a", "gal_b"]);

    const refit: Galaxy[] = [
      { centroid: centroids.get("gal_a") ?? A.centroid, id: "gal_a" },
      { centroid: centroids.get("gal_b") ?? B.centroid, id: "gal_b" },
    ];
    const second = assignFindings(corpus, refit);

    // Labels are identical (no reshuffle).
    expect(second.map((a) => a.galaxyId)).toEqual(first.map((a) => a.galaxyId));

    // Recomputing again reproduces the same centroids within 1e-6 cosine (a converged map).
    const assignedAgain = new Map(second.map((a) => [a.trackId, a.galaxyId]));
    const again = recomputeCentroids(corpus, assignedAgain, ["gal_a", "gal_b"]);
    for (const id of ["gal_a", "gal_b"]) {
      const before = centroids.get(id);
      const after = again.centroids.get(id);
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      expect(1 - dot(before ?? [], after ?? [])).toBeLessThan(1e-6);
    }
  });

  test("+ a synthetic finding moves no existing assignment except a genuine boundary case", () => {
    const before = assignFindings(corpus, [A, B]);
    const withExtra = [...corpus, { embedding: unit(1, 0.15), galaxyId: null, trackId: "t7" }];
    const after = assignFindings(withExtra, [A, B]);
    // Every original finding keeps its galaxy; only the new one is added.
    for (const original of before) {
      const match = after.find((a) => a.trackId === original.trackId);
      expect(match?.galaxyId).toBe(original.galaxyId);
    }
    expect(after.find((a) => a.trackId === "t7")?.galaxyId).toBe("gal_a");
  });
});

describe("cosineSilhouette (report-only evidence)", () => {
  test("well-separated clusters score high; each cluster gets a number", () => {
    const assignedById = new Map(
      assignFindings(corpus, [A, B]).map((a) => [a.trackId, a.galaxyId]),
    );
    const { overall, perCluster } = cosineSilhouette(corpus, assignedById, ["gal_a", "gal_b"]);
    expect(overall).not.toBeNull();
    expect(overall ?? 0).toBeGreaterThan(0.5);
    expect(perCluster.get("gal_a")).not.toBeNull();
    expect(perCluster.get("gal_b")).not.toBeNull();
  });

  test("silhouette is undefined below two non-empty clusters -> all null", () => {
    const assignedById = new Map(corpus.map((f) => [f.trackId, "gal_a"]));
    const { overall, perCluster } = cosineSilhouette(corpus, assignedById, ["gal_a", "gal_b"]);
    expect(overall).toBeNull();
    expect(perCluster.get("gal_a")).toBeNull();
  });
});

describe("planSplit (the parent keeps its id on the LARGER child)", () => {
  test("orders the child centroids larger-first by member count", () => {
    // Three members hug +x, one hugs +y -> the +x child is larger and comes first.
    const members: Finding[] = [
      { embedding: unit(1, 0), galaxyId: "g", trackId: "m1" },
      { embedding: unit(1, 0.1), galaxyId: "g", trackId: "m2" },
      { embedding: unit(1, 0.2), galaxyId: "g", trackId: "m3" },
      { embedding: unit(0, 1), galaxyId: "g", trackId: "m4" },
    ];
    const plan = planSplit(members, [
      [1, 0],
      [0, 1],
    ]);
    expect(plan).not.toBeNull();
    // parentChild is the larger (+x) child; newChild is the smaller (+y) one.
    expect(plan?.parentChild).toEqual([1, 0]);
    expect(plan?.newChild).toEqual([0, 1]);
  });

  test("a fit that did not yield exactly two centroids -> null (caller just clears the flag)", () => {
    expect(planSplit([], [[1, 0]])).toBeNull();
  });
});

describe("parseMode", () => {
  test("the operator acts are explicit flags; the default is the nightly tick", () => {
    expect(parseMode([])).toBe("nightly");
    expect(parseMode(["--cold-start"])).toBe("cold-start");
    expect(parseMode(["--remint"])).toBe("remint");
    // cold-start wins if both are (mistakenly) passed — a snap beats a redraw.
    expect(parseMode(["--cold-start", "--remint"])).toBe("cold-start");
  });
});
