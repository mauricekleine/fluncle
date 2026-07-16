#!/usr/bin/env bun
/**
 * THE MIXABILITY DIAGNOSTIC — a characterization, NOT a fit.
 *
 * The draft planned a weight fit against Fluncle's own published sets. The panel ran
 * the data and it does not survive: over the real ordered transitions of mixtape
 * `019.F.1A`, the Camelot sub-score is AT CHANCE — indistinguishable from random key
 * pairs. Fluncle mixes on phrasing, intros/outros, and energy, not harmonic
 * adjacency. So the engine computes the well-defined clean-mixability objective, the
 * weights (`MIX_WEIGHTS`) are versioned product config, and this script CHARACTERIZES
 * the engine — it never trains it. Do not re-invent the fit.
 *
 * It prints three things:
 *   1. The floor check — the real consecutive-transition Camelot distribution vs the
 *      all-pairs random baseline (the same verdict the committed floor-check unit
 *      test pins, printed with detail).
 *   2. The within-set successor rank — for each set member, where the TRUE next track
 *      ranks by mixability among the remaining unplayed members (the uncontaminated
 *      pool — whole-archive MRR is contaminated because the other set members are
 *      near-perfect decoys). The random baseline (expected rank) is printed beside it.
 *   3. The join-coverage honesty numbers — how many set members carried key / features
 *      at run time.
 *
 * Reads the 17 set members off the PUBLIC API (key/bpm/features are public), so it is
 * reproducible with no DB. Embedding presence is NOT public — run against a
 * dev server (`--base http://localhost:3000`) if you want the embedding coverage line
 * populated; against the public API it prints "unknown (not public)".
 *
 * Usage:
 *   bun run scripts/mixability-diagnostics.ts
 *   bun run scripts/mixability-diagnostics.ts --base http://localhost:3000
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseKey, toCamelot } from "../src/lib/key-camelot";
import { harmonicScore, type MixTrack, scoreMix } from "../src/lib/server/mixability";

const TRACKLIST = resolve(
  import.meta.dirname,
  "../../../packages/video/src/set-video/__fixtures__/019.F.1A.tracklist.json",
);

type Member = {
  bpm: number | null;
  features: MixTrack["features"];
  key: string | null;
  logId: string;
};

function baseArg(): string {
  const index = process.argv.indexOf("--base");
  const value = index >= 0 ? process.argv[index + 1] : undefined;

  return (value ?? "https://www.fluncle.com").replace(/\/$/, "");
}

function camelotOf(key: string | null) {
  const parsed = parseKey(key);

  return parsed ? toCamelot(parsed) : null;
}

function mean(values: number[]): number {
  return values.length === 0 ? Number.NaN : values.reduce((s, v) => s + v, 0) / values.length;
}

function toMix(member: Member): MixTrack {
  return { bpm: member.bpm, embedding: null, features: member.features, key: member.key };
}

async function main(): Promise<void> {
  const base = baseArg();
  const fixture = JSON.parse(await readFile(TRACKLIST, "utf8")) as { i: number; logId: string }[];
  const ordered = [...fixture].sort((a, b) => a.i - b.i);

  const members: Member[] = [];

  for (const { logId } of ordered) {
    const response = await fetch(`${base}/api/v1/tracks/${logId}`);
    const body = (await response.json()) as { track?: Record<string, unknown> };
    const track = body.track ?? {};
    const features = track.features as Record<string, number> | undefined;

    members.push({
      bpm: typeof track.bpm === "number" ? track.bpm : null,
      features: features
        ? [
            features.centroidHz ?? 0,
            features.highRatio ?? 0,
            features.midFlatness ?? 0,
            features.onsetRate ?? 0,
            features.subBassRatio ?? 0,
          ]
        : null,
      key: typeof track.key === "string" ? track.key : null,
      logId,
    });
  }

  // ── 1. Floor check ─────────────────────────────────────────────────────────
  const real = members.flatMap((member, index) => {
    const next = members[index + 1];
    const score = next ? harmonicScore(camelotOf(member.key), camelotOf(next.key)) : null;

    return score === null ? [] : [score];
  });
  const baseline = members.flatMap((left, i) =>
    members.flatMap((right, j) => {
      if (i === j) {
        return [];
      }

      const score = harmonicScore(camelotOf(left.key), camelotOf(right.key));

      return score === null ? [] : [score];
    }),
  );

  console.log("── Floor check (Camelot harmonic axis) ──");
  console.log(`  real consecutive transitions: n=${real.length}  mean=${mean(real).toFixed(4)}`);
  console.log(
    `  all-pairs random baseline:    n=${baseline.length}  mean=${mean(baseline).toFixed(4)}`,
  );
  console.log(
    `  verdict: ${mean(real) <= mean(baseline) + 0.05 ? "AT CHANCE — key does not predict Fluncle's sequencing" : "ABOVE BASELINE (investigate)"}`,
  );

  // ── 2. Within-set successor rank (uncontaminated pool) ─────────────────────
  const ranks: number[] = [];

  for (let i = 0; i < members.length - 1; i += 1) {
    const current = members[i];
    const trueNext = members[i + 1];

    if (!current || !trueNext) {
      continue;
    }

    const pool = members.slice(i + 1); // the remaining unplayed set members
    const scored = pool
      .map((candidate) => ({
        logId: candidate.logId,
        score: scoreMix(toMix(current), toMix(candidate)).score ?? -1,
      }))
      .sort((a, b) => b.score - a.score);
    const rank = scored.findIndex((entry) => entry.logId === trueNext.logId) + 1;
    ranks.push(rank);
  }

  const expectedRandomRank = mean(
    members.slice(0, -1).map((_, i) => (members.length - i) / 2), // avg rank in a pool of size (n-i-1)+... ≈ half
  );

  console.log("\n── Within-set successor rank (true next among remaining members) ──");
  console.log(`  mean true-next rank: ${mean(ranks).toFixed(2)}  (over ${ranks.length} steps)`);
  console.log(`  random-guess expected rank (~half the pool): ${expectedRandomRank.toFixed(2)}`);

  // ── 3. Join coverage ───────────────────────────────────────────────────────
  const keyed = members.filter((m) => m.key).length;
  const featured = members.filter((m) => m.features).length;

  console.log("\n── Join coverage (this run) ──");
  console.log(`  total set members: ${members.length}`);
  console.log(`  key present:       ${keyed}/${members.length}`);
  console.log(`  features present:  ${featured}/${members.length}`);
  console.log(
    `  embedding present: ${base.includes("fluncle.com") ? "unknown (not public — re-run with --base <dev server> for embedding coverage)" : "read from the dev DB is not wired here; check the admin board's embed queue"}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
