#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxCostEvent, emitCost, selfSecondsCost } from "./cost-emit";

const COLD_START_K = readK(process.env.FLUNCLE_CLUSTER_K, 4);

function readK(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);

  return Number.isInteger(parsed) && parsed >= 2 && parsed <= 24 ? parsed : fallback;
}

const MIN_SPLIT_MEMBERS = 4;

const CORPUS_PAGE_LIMIT = 500;

const MAX_CORPUS_PAGES = 1000;

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";

const CLUSTER_SCRIPT =
  process.env.FLUNCLE_CLUSTER_SCRIPT ?? new URL("cluster.py", import.meta.url).pathname;

const log = (message: string) => console.error(`[cluster-sweep] ${message}`);

const fatalCounters: { checked: null | number; produced: null | number } = {
  checked: null,
  produced: null,
};

export type Vector = number[];

export type Galaxy = { centroid: Vector; id: string };

export type Finding = { embedding: Vector; galaxyId: string | null; trackId: string };

export type Assignment = { galaxyId: string; previousGalaxyId: string | null; trackId: string };

export type ClusterRow = {
  centroid: Vector;
  clearSplitRequest?: boolean;
  id: string | null;
  retire?: boolean;
};

type GalaxyMapRow = {
  centroid: Vector;
  id: string;
  retiredAt: string | null;
  splitRequestedAt: string | null;
};

export type RunMode = "cold-start" | "nightly" | "remint";

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

export function l2normalize(v: Vector): Vector {
  let sumSq = 0;

  for (const value of v) {
    sumSq += value * value;
  }

  const norm = Math.sqrt(sumSq);

  return norm === 0 ? [...v] : v.map((value) => value / norm);
}

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

export function changedAssignments(assignments: Assignment[]): Assignment[] {
  return assignments.filter((a) => a.galaxyId !== a.previousGalaxyId);
}

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

function run(
  bin: string,
  args: string[],
  input?: string,
): { code: number; stderr: string; stdout: string } {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
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

function readMap(): GalaxyMapRow[] {
  const response = fluncleJson<{ galaxies?: GalaxyMapRow[] }>(["admin", "galaxies", "map"]);
  return response.galaxies ?? [];
}

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

  fatalCounters.checked = null;
  fatalCounters.produced = null;

  const map = readMap();
  const corpus = readCorpus();
  fatalCounters.checked = corpus.length;
  fatalCounters.produced = 0;
  let active: Galaxy[] = map
    .filter((g) => g.retiredAt === null)
    .map((g) => ({ centroid: g.centroid, id: g.id }));

  const summary: Record<string, unknown> = {
    activeBefore: active.length,
    checked: corpus.length,
    corpus: corpus.length,
    emptied: 0,
    errors: 0,
    minted: 0,
    mode,
    ok: true,
    produced: 0,
    reassigned: 0,
    retired: 0,
    splits: 0,
  };

  if (corpus.length === 0) {
    console.log(JSON.stringify({ ...summary, reason: "empty_corpus" }));
    return;
  }

  if (mode === "cold-start") {
    if (active.length > 0) {
      console.log(JSON.stringify({ ...summary, errors: 1, ok: false, reason: "map_not_empty" }));
      process.exitCode = 1;
      return;
    }

    const centroids = fitCentroids(
      corpus.map((f) => f.embedding),
      COLD_START_K,
    );
    active = writeMap(centroids.map((centroid) => ({ centroid, id: null })));
    summary.minted = active.length;
  } else if (mode === "remint") {
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
  } else {
    if (active.length === 0) {
      console.log(JSON.stringify({ ...summary, reason: "map_empty" }));
      return;
    }

    const flagged = map.filter((g) => g.retiredAt === null && g.splitRequestedAt);

    if (flagged.length > 0) {
      const structural: ClusterRow[] = [];

      for (const parent of flagged) {
        const members = corpus.filter((f) => f.galaxyId === parent.id);

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

        structural.push({ centroid: plan.parentChild, clearSplitRequest: true, id: parent.id });
        structural.push({ centroid: plan.newChild, id: null });
        summary.splits = (summary.splits as number) + 1;
      }

      if (structural.length > 0) {
        active = writeMap(structural);
      }
    }
  }

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
    summary.produced = (summary.produced as number) + 1;
    fatalCounters.produced = (fatalCounters.produced ?? 0) + 1;
  }

  summary.reassigned = changed.length;

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

  const survivingIds = activeIds.filter((id) => !emptied.includes(id));
  const silhouette = cosineSilhouette(corpus, assignedById, survivingIds);
  summary.silhouette = {
    overall: silhouette.overall,
    perCluster: Object.fromEntries(silhouette.perCluster),
  };
  summary.galaxies = survivingIds.length;

  const costs: BoxCostEvent[] = [
    selfSecondsCost({
      occurredAt: new Date().toISOString(),
      seconds: (Date.now() - started) / 1000,
      step: "cluster",
    }),
  ];
  const costWriteFailures = (await emitCost(costs)).failed;

  console.log(JSON.stringify({ costWriteFailures, ...summary }));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      `[cluster-sweep] fatal: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log(
      JSON.stringify({
        checked: fatalCounters.checked,
        errors: 1,
        ok: false,
        produced: fatalCounters.produced,
        reason: "fatal",
      }),
    );
    process.exitCode = 1;
  });
}
