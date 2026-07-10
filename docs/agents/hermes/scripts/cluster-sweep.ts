#!/usr/bin/env bun
// cluster-sweep.ts — the bun orchestrator behind the sonic-galaxy cluster engine
// (`fluncle-cluster`), scheduled NIGHTLY by a rave-02 HOST systemd timer
// (../cluster-timer/), not a Hermes gateway cron: a stateful batch job that reads the
// whole embedded corpus and writes the map wants the box, never the shared serial runner.
// See ../cluster-timer/README.md + docs/agents/cluster-engine.md + docs/rfcs/browse-by-feel.md.
//
// LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy
// target (fluncle-hermes-operator skill). Invoked by the bash wrapper (cluster-sweep.sh) the
// host timer `docker exec`s once a night — and, for the operator acts, by hand:
//   bash /opt/hermes-scripts/cluster-sweep.sh                 # the nightly, assignment-only tick
//   bash /opt/hermes-scripts/cluster-sweep.sh --cold-start    # run 1: the k=4 fit (map must be empty; FLUNCLE_CLUSTER_K overrides)
//   bash /opt/hermes-scripts/cluster-sweep.sh --remint        # deliberate full redraw (retire all, refit)
//
// THE SHAPE (docs/agents/cluster-engine.md — the fixed-point-by-construction design):
//   - The NIGHTLY tick is ASSIGNMENT-ONLY and PURE TS: assign each finding to its nearest
//     STORED centroid (cosine), recompute each centroid as its members' L2-normalized mean,
//     retire an emptied galaxy. No clustering fit runs — no relabeling step exists, so ids
//     are stable by construction and a bookmarked galaxy can never teleport. On an unchanged
//     corpus the tick is a no-op. It ALSO consumes an operator's `split_requested_at` (a k=2
//     fit on that galaxy's members only — the one place the nightly tick spawns python).
//   - A full k-means fit is an OPERATOR ACT ONLY (cold start, remint), never the timer's
//     default: a warm-started full re-fit can relocate an emptied centroid across the map
//     (sklearn `_relocate_empty_clusters`), the exact bookmark-breaking reshuffle the feature
//     forbids. The fits (+ splits) go through cluster.py (sklearn); the nightly math is here.
//
// THE WRITE-ORDER CONTRACT (the run's consistency boundary, RFC Unit A): (1) upsert the map
// FIRST for any minted/retired/reshaped clusters — the Worker mints ids + handles and returns
// them, so every id a finding can point at exists BEFORE any assignment lands; (2) write the
// CHANGED assignments (a handful per night — diffed against each finding's current galaxyId);
// (3) refresh centroids + retire empties in a final map write. member_count is derived
// server-side, never stored. A mid-run crash is resume-safe: re-running converges and no
// assignment ever points at a missing map row.
//
// The pure helpers below are exported + unit-tested in cluster-sweep.test.ts; `main()` is
// guarded behind `import.meta.main` so importing this module for the tests is side-effect free
// (no fluncle spawn, no python, no network).
//
// stdout: one JSON summary line (the run output the /status prober reads). Diagnostics -> stderr.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxCostEvent, emitCost, selfSecondsCost } from "./cost-emit";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// The operator-held fit k. The RFC's formula proposed 9, but the k=9 pilot spread a
// 60-finding corpus thin (silhouette 0.044, three sliver clusters) and the operator
// held it at 4 — the four canon galaxies, now data-real. Overridable per fit via
// FLUNCLE_CLUSTER_K; only an operator cold-start / remint fits k, never the nightly tick.
const COLD_START_K = readK(process.env.FLUNCLE_CLUSTER_K, 4);

/** Parse an operator-supplied k override, falling back to the held default. */
function readK(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);

  return Number.isInteger(parsed) && parsed >= 2 && parsed <= 24 ? parsed : fallback;
}

// A galaxy needs at least this many members to be splittable into two coherent children.
const MIN_SPLIT_MEMBERS = 4;

// Cursor-page size for the corpus read (clamped server-side to the embeddings max).
const CORPUS_PAGE_LIMIT = 500;

// A hard ceiling on how many corpus pages we page through — a guard against an unbounded
// loop if the cursor ever failed to advance (each page is up to CORPUS_PAGE_LIMIT rows, so
// this covers a corpus far larger than the archive will be for years).
const MAX_CORPUS_PAGES = 1000;

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";
// The k-means fit helper — baked beside this orchestrator (/opt/hermes-scripts/).
const CLUSTER_SCRIPT =
  process.env.FLUNCLE_CLUSTER_SCRIPT ?? new URL("cluster.py", import.meta.url).pathname;

const log = (message: string) => console.error(`[cluster-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from each surface.
// ---------------------------------------------------------------------------

export type Vector = number[];

/** A live map row (the non-retired galaxies the nightly tick assigns against). */
export type Galaxy = { centroid: Vector; id: string };

/** One embedded finding + its CURRENT assignment (null when unplaced). */
export type Finding = { embedding: Vector; galaxyId: string | null; trackId: string };

/** The nearest-centroid result for one finding: where it goes vs where it was. */
export type Assignment = { galaxyId: string; previousGalaxyId: string | null; trackId: string };

/** One row of the transactional map write (`update_galaxy_map`). */
export type ClusterRow = {
  centroid: Vector;
  clearSplitRequest?: boolean;
  id: string | null;
  retire?: boolean;
};

// A full galaxy row as the `admin galaxies map` read returns it (only the fields we read).
type GalaxyMapRow = {
  centroid: Vector;
  id: string;
  retiredAt: string | null;
  splitRequestedAt: string | null;
};

export type RunMode = "cold-start" | "nightly" | "remint";

// ---------------------------------------------------------------------------
// Pure vector helpers (exported for cluster-sweep.test.ts) — deterministic, no I/O.
// MuQ vectors are L2-normalized, so cosine == dot product and Euclidean k-means == spherical.
// ---------------------------------------------------------------------------

/** Dot product; 0 when the vectors disagree in length (a defensive, never-crash floor). */
export function dot(a: Vector, b: Vector): number {
  if (a.length !== b.length) {
    return 0;
  }

  let sum = 0;

  for (let i = 0; i < a.length; i += 1) {
    sum += a[i] * b[i];
  }

  return sum;
}

/** L2-normalize a vector; an all-zero vector is returned unchanged (never divides by 0). */
export function l2normalize(v: Vector): Vector {
  let sumSq = 0;

  for (const value of v) {
    sumSq += value * value;
  }

  const norm = Math.sqrt(sumSq);

  return norm === 0 ? [...v] : v.map((value) => value / norm);
}

/**
 * The L2-normalized elementwise mean of a set of vectors — a galaxy's centroid as the mean
 * of its members (the assignment-only tick's one bounded step). Null for an empty set (an
 * emptied galaxy, which the caller retires).
 */
export function meanVector(vectors: Vector[]): Vector | null {
  if (vectors.length === 0) {
    return null;
  }

  const dims = vectors[0].length;
  const sum = Array.from({ length: dims }, () => 0);

  for (const vector of vectors) {
    for (let i = 0; i < dims; i += 1) {
      sum[i] += vector[i] ?? 0;
    }
  }

  return l2normalize(sum.map((value) => value / vectors.length));
}

/**
 * The id of the nearest galaxy to `embedding` by cosine (max dot, since both are
 * L2-normalized). Null when there are no galaxies. Ties break on the earliest galaxy in the
 * list (stable), so the assignment is deterministic.
 */
export function nearestGalaxyId(embedding: Vector, galaxies: Galaxy[]): string | null {
  let bestId: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const galaxy of galaxies) {
    const score = dot(embedding, galaxy.centroid);

    if (score > bestScore) {
      bestScore = score;
      bestId = galaxy.id;
    }
  }

  return bestId;
}

/**
 * Assign every finding to its nearest galaxy (cosine), pairing the result with the finding's
 * current assignment so the caller can diff. A finding with no galaxy to go to (an empty map)
 * is dropped from the result — nothing to assign.
 */
export function assignFindings(findings: Finding[], galaxies: Galaxy[]): Assignment[] {
  if (galaxies.length === 0) {
    return [];
  }

  const assignments: Assignment[] = [];

  for (const finding of findings) {
    const galaxyId = nearestGalaxyId(finding.embedding, galaxies);

    if (galaxyId !== null) {
      assignments.push({ galaxyId, previousGalaxyId: finding.galaxyId, trackId: finding.trackId });
    }
  }

  return assignments;
}

/** The assignments that actually MOVED — the write-order contract's "a handful per night". */
export function changedAssignments(assignments: Assignment[]): Assignment[] {
  return assignments.filter((a) => a.galaxyId !== a.previousGalaxyId);
}

/**
 * Recompute each galaxy's centroid as the L2-normalized mean of the findings now assigned to
 * it, given the fresh assignment. A galaxy that ended the pass with zero members is `emptied`
 * (the caller retires it) — reachable precisely because no library relocation runs on the
 * nightly tick.
 */
export function recomputeCentroids(
  findings: Finding[],
  assignedById: Map<string, string>,
  galaxyIds: string[],
): { centroids: Map<string, Vector>; emptied: string[] } {
  const members = new Map<string, Vector[]>();

  for (const id of galaxyIds) {
    members.set(id, []);
  }

  for (const finding of findings) {
    const galaxyId = assignedById.get(finding.trackId);
    const bucket = galaxyId ? members.get(galaxyId) : undefined;

    if (bucket) {
      bucket.push(finding.embedding);
    }
  }

  const centroids = new Map<string, Vector>();
  const emptied: string[] = [];

  for (const id of galaxyIds) {
    const centroid = meanVector(members.get(id) ?? []);

    if (centroid === null) {
      emptied.push(id);
    } else {
      centroids.set(id, centroid);
    }
  }

  return { centroids, emptied };
}

/**
 * Mean cosine silhouette per galaxy + overall — the coherence evidence the operator's naming
 * view reads (RFC: "computed for display only"). O(N²), trivial at archive scale. A point's
 * silhouette is (b - a) / max(a, b) with a = its mean cosine DISTANCE (1 - dot) to its own
 * cluster, b = the smallest mean distance to any OTHER cluster. Needs ≥2 non-empty clusters;
 * fewer → all-null (undefined at k<2). A singleton cluster scores its lone member's a = 0.
 */
export function cosineSilhouette(
  findings: Finding[],
  assignedById: Map<string, string>,
  galaxyIds: string[],
): { overall: number | null; perCluster: Map<string, number | null> } {
  const byCluster = new Map<string, Finding[]>();

  for (const id of galaxyIds) {
    byCluster.set(id, []);
  }

  for (const finding of findings) {
    const galaxyId = assignedById.get(finding.trackId);
    const bucket = galaxyId ? byCluster.get(galaxyId) : undefined;

    if (bucket) {
      bucket.push(finding);
    }
  }

  const nonEmpty = galaxyIds.filter((id) => (byCluster.get(id)?.length ?? 0) > 0);
  const perCluster = new Map<string, number | null>();

  // Silhouette is undefined below two clusters (there is no "other cluster" for b).
  if (nonEmpty.length < 2) {
    for (const id of galaxyIds) {
      perCluster.set(id, null);
    }

    return { overall: null, perCluster };
  }

  const meanDistance = (from: Finding, to: Finding[], excludeSelf: boolean): number => {
    let sum = 0;
    let count = 0;

    for (const other of to) {
      if (excludeSelf && other.trackId === from.trackId) {
        continue;
      }

      sum += 1 - dot(from.embedding, other.embedding);
      count += 1;
    }

    return count === 0 ? 0 : sum / count;
  };

  let overallSum = 0;
  let overallCount = 0;

  for (const id of nonEmpty) {
    const own = byCluster.get(id) ?? [];
    let clusterSum = 0;

    for (const point of own) {
      const a = meanDistance(point, own, true);
      let b = Number.POSITIVE_INFINITY;

      for (const otherId of nonEmpty) {
        if (otherId === id) {
          continue;
        }

        b = Math.min(b, meanDistance(point, byCluster.get(otherId) ?? [], false));
      }

      const denom = Math.max(a, b);
      const s = denom === 0 ? 0 : (b - a) / denom;
      clusterSum += s;
      overallSum += s;
      overallCount += 1;
    }

    perCluster.set(id, own.length === 0 ? null : clusterSum / own.length);
  }

  for (const id of galaxyIds) {
    if (!perCluster.has(id)) {
      perCluster.set(id, null);
    }
  }

  return { overall: overallCount === 0 ? null : overallSum / overallCount, perCluster };
}

/**
 * Split ONE galaxy's members into two children given the k=2 fit centroids: assign each
 * member to its nearer child, and return the two child centroids ordered LARGER-FIRST (so the
 * parent's id stays on the bigger child, the RFC's continuity rule). Null when the fit did not
 * return exactly two usable centroids (the caller then just clears the flag, no reshape).
 */
export function planSplit(
  members: Finding[],
  childCentroids: Vector[],
): { newChild: Vector; parentChild: Vector } | null {
  if (childCentroids.length !== 2) {
    return null;
  }

  const galaxies: Galaxy[] = [
    { centroid: childCentroids[0], id: "0" },
    { centroid: childCentroids[1], id: "1" },
  ];
  const sizes = [0, 0];

  for (const member of members) {
    const nearest = nearestGalaxyId(member.embedding, galaxies);

    if (nearest === "0") {
      sizes[0] += 1;
    } else if (nearest === "1") {
      sizes[1] += 1;
    }
  }

  const largerIsFirst = sizes[0] >= sizes[1];

  return {
    newChild: largerIsFirst ? childCentroids[1] : childCentroids[0],
    parentChild: largerIsFirst ? childCentroids[0] : childCentroids[1],
  };
}

// ---------------------------------------------------------------------------
// Shell + fit helpers — synchronous, fail-loud where it matters.
// ---------------------------------------------------------------------------

function run(
  bin: string,
  args: string[],
  input?: string,
): { code: number; stderr: string; stdout: string } {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024, // the corpus of 1024-float vectors can be large
  });

  if (result.error) {
    throw new Error(`failed to spawn ${bin}: ${result.error.message}`);
  }

  return { code: result.status ?? 1, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

function fluncleJson<T>(args: string[]): T {
  const { code, stderr, stdout } = run(FLUNCLE_BIN, [...args, "--json"]);

  if (code !== 0) {
    throw new Error(`fluncle ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`fluncle ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
  }
}

/** Run the k-means fit helper (cluster.py) over `vectors`, returning k L2-normalized centroids. */
function fitCentroids(vectors: Vector[], k: number): Vector[] {
  const fit = run(PYTHON_BIN, [CLUSTER_SCRIPT], JSON.stringify({ k, vectors }));

  if (fit.code !== 0) {
    throw new Error(`cluster.py exited ${fit.code}: ${fit.stderr.trim().slice(-400)}`);
  }

  const parsed = JSON.parse(fit.stdout) as { centroids?: Vector[]; error?: string };

  if (parsed.error || !Array.isArray(parsed.centroids)) {
    throw new Error(`cluster.py: ${parsed.error ?? "no centroids returned"}`);
  }

  return parsed.centroids;
}

// ── the map + corpus reads, and the transactional map write ──────────────────

/** The full galaxy map (named + unnamed + retired), via the box's admin token. */
function readMap(): GalaxyMapRow[] {
  const response = fluncleJson<{ galaxies?: GalaxyMapRow[] }>(["admin", "galaxies", "map"]);
  return response.galaxies ?? [];
}

/** The whole embedded corpus, paged over the stable track_id cursor until drained. */
function readCorpus(): Finding[] {
  const findings: Finding[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_CORPUS_PAGES; page += 1) {
    const args = ["admin", "galaxies", "embeddings", "--limit", String(CORPUS_PAGE_LIMIT)];

    if (cursor) {
      args.push("--cursor", cursor);
    }

    const response = fluncleJson<{
      embeddings?: Finding[];
      nextCursor?: string | null;
    }>(args);

    for (const row of response.embeddings ?? []) {
      findings.push(row);
    }

    if (!response.nextCursor) {
      return findings;
    }

    cursor = response.nextCursor;
  }

  log(`corpus read hit the ${MAX_CORPUS_PAGES}-page ceiling — proceeding with a partial corpus`);

  return findings;
}

/**
 * Write the map transactionally (mint/retire/upsert) and return the resulting live map. The
 * clusters go through a temp file (`set-map --file`) — a 1024-float centroid array per row is
 * too large for an inline flag, the same file-arg habit embed-sweep uses for the vector write.
 */
function writeMap(rows: ClusterRow[]): Galaxy[] {
  if (rows.length === 0) {
    return readMap()
      .filter((g) => g.retiredAt === null)
      .map((g) => ({ centroid: g.centroid, id: g.id }));
  }

  const workdir = mkdtempSync(join(tmpdir(), "fluncle-cluster-"));

  try {
    const file = join(workdir, "clusters.json");
    writeFileSync(file, JSON.stringify({ clusters: rows }));

    const response = fluncleJson<{ galaxies?: GalaxyMapRow[] }>([
      "admin",
      "galaxies",
      "set-map",
      "--file",
      file,
    ]);

    return (response.galaxies ?? [])
      .filter((g) => g.retiredAt === null)
      .map((g) => ({ centroid: g.centroid, id: g.id }));
  } finally {
    rmSync(workdir, { force: true, recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Main — one nightly assignment tick, or an operator cold-start / remint.
// ---------------------------------------------------------------------------

/** Parse the run mode from argv (the operator acts are explicit flags; default is nightly). */
export function parseMode(argv: string[]): RunMode {
  if (argv.includes("--cold-start")) {
    return "cold-start";
  }

  if (argv.includes("--remint")) {
    return "remint";
  }

  return "nightly";
}

async function main(): Promise<void> {
  const started = Date.now();
  const mode = parseMode(process.argv.slice(2));

  const map = readMap();
  const corpus = readCorpus();
  let active: Galaxy[] = map
    .filter((g) => g.retiredAt === null)
    .map((g) => ({ centroid: g.centroid, id: g.id }));

  const summary: Record<string, unknown> = {
    activeBefore: active.length,
    corpus: corpus.length,
    emptied: 0,
    minted: 0,
    mode,
    ok: true,
    reassigned: 0,
    retired: 0,
    splits: 0,
  };

  if (corpus.length === 0) {
    console.log(JSON.stringify({ ...summary, reason: "empty_corpus" }));
    return;
  }

  // ── operator act: cold start (map must be empty) ──────────────────────────
  if (mode === "cold-start") {
    if (active.length > 0) {
      console.log(JSON.stringify({ ...summary, ok: false, reason: "map_not_empty" }));
      process.exitCode = 1;
      return;
    }

    const centroids = fitCentroids(
      corpus.map((f) => f.embedding),
      COLD_START_K,
    );
    active = writeMap(centroids.map((centroid) => ({ centroid, id: null })));
    summary.minted = active.length;
  }

  // ── operator act: remint (retire every id, refit fresh) ───────────────────
  else if (mode === "remint") {
    const centroids = fitCentroids(
      corpus.map((f) => f.embedding),
      COLD_START_K,
    );
    const rows: ClusterRow[] = [
      ...active.map((g) => ({ centroid: g.centroid, id: g.id, retire: true })),
      ...centroids.map((centroid) => ({ centroid, id: null })),
    ];
    summary.retired = active.length;
    active = writeMap(rows);
    summary.minted = active.length;
  }

  // ── nightly: consume any operator split request, then assign ──────────────
  else {
    if (active.length === 0) {
      console.log(JSON.stringify({ ...summary, reason: "map_empty" }));
      return;
    }

    const flagged = map.filter((g) => g.retiredAt === null && g.splitRequestedAt);

    if (flagged.length > 0) {
      const structural: ClusterRow[] = [];

      for (const parent of flagged) {
        const members = corpus.filter((f) => f.galaxyId === parent.id);

        // Too few members to split into two coherent children: clear the flag (upsert the
        // centroid unchanged) so a stuck request can never re-fire every night.
        if (members.length < MIN_SPLIT_MEMBERS) {
          structural.push({ centroid: parent.centroid, clearSplitRequest: true, id: parent.id });
          log(`${parent.id}: split requested but only ${members.length} members — clearing flag`);
          continue;
        }

        const childCentroids = fitCentroids(
          members.map((f) => f.embedding),
          2,
        );
        const plan = planSplit(members, childCentroids);

        if (!plan) {
          structural.push({ centroid: parent.centroid, clearSplitRequest: true, id: parent.id });
          log(`${parent.id}: split fit did not yield two children — clearing flag`);
          continue;
        }

        // Parent keeps its id on the larger child (+ the flag cleared); the smaller child is
        // a NEW cluster the Worker mints an id + handle for.
        structural.push({ centroid: plan.parentChild, clearSplitRequest: true, id: parent.id });
        structural.push({ centroid: plan.newChild, id: null });
        summary.splits = (summary.splits as number) + 1;
      }

      if (structural.length > 0) {
        active = writeMap(structural);
      }
    }
  }

  // ── assignment phase (shared by every mode): nearest centroid, diff, write ──
  const assignments = assignFindings(corpus, active);
  const changed = changedAssignments(assignments);

  for (const assignment of changed) {
    fluncleJson([
      "admin",
      "tracks",
      "update",
      assignment.trackId,
      "--galaxy-id",
      assignment.galaxyId,
    ]);
  }

  summary.reassigned = changed.length;

  // ── centroid refresh + empty retire (the final map write) ─────────────────
  const assignedById = new Map(assignments.map((a) => [a.trackId, a.galaxyId]));
  const activeIds = active.map((g) => g.id);
  const { centroids, emptied } = recomputeCentroids(corpus, assignedById, activeIds);

  const finalRows: ClusterRow[] = active.map((galaxy) =>
    emptied.includes(galaxy.id)
      ? { centroid: galaxy.centroid, id: galaxy.id, retire: true }
      : { centroid: centroids.get(galaxy.id) ?? galaxy.centroid, id: galaxy.id },
  );

  writeMap(finalRows);
  summary.emptied = emptied.length;
  summary.retired = (summary.retired as number) + emptied.length;

  // ── silhouette evidence (report-only; the operator's naming view reads it) ──
  const survivingIds = activeIds.filter((id) => !emptied.includes(id));
  const silhouette = cosineSilhouette(corpus, assignedById, survivingIds);
  summary.silhouette = {
    overall: silhouette.overall,
    perCluster: Object.fromEntries(silhouette.perCluster),
  };
  summary.galaxies = survivingIds.length;

  // The summary line the /status prober reads is the LAST stdout line.
  console.log(JSON.stringify(summary));

  // The tick's compute spend — one `self`/`seconds` row (global scope; not per-finding),
  // best-effort, AFTER the summary is printed (emitCost is stderr-only, never throws).
  const costs: BoxCostEvent[] = [
    selfSecondsCost({
      occurredAt: new Date().toISOString(),
      seconds: (Date.now() - started) / 1000,
      step: "cluster",
    }),
  ];
  await emitCost(costs);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      `[cluster-sweep] fatal: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log(JSON.stringify({ ok: false, reason: "fatal" }));
    process.exitCode = 1;
  });
}
