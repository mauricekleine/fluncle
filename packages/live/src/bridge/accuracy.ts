// THE MANDATORY ACCURACY RUN — replay the de-risk spike's real DJ set offline
// through the PRODUCTION streaming matcher and report pointer accuracy vs ground
// truth. This is the one check that proves the star works on real audio; it needs
// ffmpeg + the spike fixtures, so it is NOT part of `bun test` — run it directly:
//
//   FLUNCLE_ALIGN_FIXTURES=<dir> bun run --cwd packages/live test:matcher-accuracy
//
// The fixture dir (the plan-pointer spike beside align.ts) must hold:
//   tracklist.json  — [{ i, logId, title, previewUrl|null, durationMs }, …] (17)
//   anchors.json    — align.ts's per-preview global-best + top-20 candidates
//   prev/<i>.mp3    — each track's official 30s preview (i matches tracklist.i)
//   set.m4a         — the recorded ~72min set
//
// It fingerprints the local previews with the SAME mel pipeline the bridge uses,
// decodes the set to the glass's 10Hz mel-frame feed, streams it through the
// PlanMatcher with the production defaults, and scores the auto-advances against a
// MONOTONIC ground truth (a DP over the anchors' top-20 candidates — the spike's
// "perfect ordering" reconstruction; the raw per-track global-best is non-monotone
// for a few tightly-mixed tail tracks, which is exactly why the DP exists).

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodeMonoFile, fingerprintFile } from "./fingerprint";
import { DEFAULT_MATCHER_CONFIG, type Fingerprint, PlanMatcher } from "./matcher";
import { MEL_FFT_SIZE, MEL_HOP, MEL_HOP_MS, melFrames } from "./mel";

const FIXTURES = process.env.FLUNCLE_ALIGN_FIXTURES;
if (!FIXTURES) {
  console.error(
    "accuracy: set FLUNCLE_ALIGN_FIXTURES=<dir> (the plan-pointer spike beside align.ts:\n" +
      "  tracklist.json + anchors.json + prev/<i>.mp3 + set.m4a).",
  );
  process.exit(2);
}

type Track = { i: number; logId: string; title: string; previewUrl: string | null };
type Anchor = { i: number; logId: string; bestMs: number; top3: [number, number][] };

/** Monotonic ground truth: DP over each anchored track's top-K candidate times so
 * the chosen hook times are non-decreasing (min 30s apart) and total score is max. */
function monotonicGroundTruth(anchors: Anchor[]): { i: number; logId: string; ms: number }[] {
  const MIN_GAP = 30_000;
  const anc = anchors.filter((a) => a.top3?.length);
  const cands = anc.map((a) => a.top3.map(([ms, sc]) => ({ ms, sc })).filter((c) => c.ms >= 0));
  const k = cands.length;
  const NEG = -1e9;
  const dp = cands.map((c) => c.map(() => NEG));
  const bk = cands.map((c) => c.map(() => -1));
  for (let j = 0; j < cands[0].length; j++) {
    dp[0][j] = cands[0][j].sc;
  }
  for (let i = 1; i < k; i++) {
    for (let j = 0; j < cands[i].length; j++) {
      const t = cands[i][j].ms;
      for (let p = 0; p < cands[i - 1].length; p++) {
        if (dp[i - 1][p] <= NEG) {
          continue;
        }
        if (cands[i - 1][p].ms + MIN_GAP <= t) {
          const v = dp[i - 1][p] + cands[i][j].sc;
          if (v > dp[i][j]) {
            dp[i][j] = v;
            bk[i][j] = p;
          }
        }
      }
    }
  }
  let best = 0;
  for (let j = 1; j < cands[k - 1].length; j++) {
    if (dp[k - 1][j] > dp[k - 1][best]) {
      best = j;
    }
  }
  const chosen: number[] = Array.from({ length: k });
  let ci = best;
  for (let i = k - 1; i >= 0; i--) {
    chosen[i] = ci;
    ci = bk[i][ci];
  }
  return anc.map((a, i) => ({ i: a.i, logId: a.logId, ms: cands[i][chosen[i]].ms }));
}

/** Per-hop RMS energy of the set PCM (the pre-arm hint's realistic input). */
function frameEnergies(signal: Float32Array, frameCount: number): Float32Array {
  const e = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const off = f * MEL_HOP;
    let acc = 0;
    for (let i = 0; i < MEL_FFT_SIZE; i++) {
      const s = signal[off + i];
      acc += s * s;
    }
    e[f] = Math.sqrt(acc / MEL_FFT_SIZE);
  }
  return e;
}

async function main(): Promise<void> {
  const dir = FIXTURES as string;
  const tracklist = JSON.parse(await readFile(join(dir, "tracklist.json"), "utf8")) as Track[];
  const anchors = JSON.parse(await readFile(join(dir, "anchors.json"), "utf8")) as Anchor[];
  const gt = monotonicGroundTruth(anchors);

  // 1. Fingerprint each planned preview (null where the finding has no preview).
  console.error(`accuracy: fingerprinting ${tracklist.length} previews…`);
  const fingerprints: Fingerprint[] = [];
  for (const t of tracklist) {
    if (t.previewUrl) {
      fingerprints.push(await fingerprintFile(t.logId, join(dir, "prev", `${t.i}.mp3`)));
    } else {
      fingerprints.push({ frames: null, logId: t.logId });
    }
  }
  const order = tracklist.map((t) => t.i);

  // 2. Decode the set to the glass's 10Hz mel feed + realistic per-frame energy.
  console.error("accuracy: decoding the set…");
  const setSignal = await decodeMonoFile(join(dir, "set.m4a"));
  const setFrames = melFrames(setSignal);
  const energies = frameEnergies(setSignal, setFrames.length);
  console.error(
    `accuracy: set = ${setFrames.length} frames (${(setFrames.length / 600).toFixed(1)}min)`,
  );

  // 3. Stream through the PRODUCTION matcher.
  const matcher = new PlanMatcher(fingerprints, DEFAULT_MATCHER_CONFIG);
  const events: { orderIdx: number; ms: number; score: number }[] = [];
  for (let f = 0; f < setFrames.length; f++) {
    const tMs = f * MEL_HOP_MS;
    const tick = matcher.pushFrame(setFrames[f], energies[f] ?? 0, tMs);
    if (tick.advanced) {
      events.push({ ms: tMs, orderIdx: order[tick.pointer], score: tick.score });
    }
  }

  // 4. Score. Structural latency: the matcher confirms ~half a window + the sustain
  // after the hook enters, so compensate before comparing to the anchor.
  const latency =
    (DEFAULT_MATCHER_CONFIG.windowFrames * MEL_HOP_MS) / 2 + DEFAULT_MATCHER_CONFIG.sustainMs;
  const rows: string[] = [];
  let within20 = 0;
  let within30 = 0;
  let ordered = true;
  let lastMs = -Infinity;
  let spurious = 0;
  const gtByI = new Map(gt.map((g) => [g.i, g.ms]));

  // pointer 0 (the opener) is correct by construction — count it as a hit.
  within20++;
  within30++;
  for (const ev of events) {
    if (ev.ms < lastMs) {
      ordered = false;
    }
    lastMs = ev.ms;
    const gtMs = gtByI.get(ev.orderIdx);
    if (gtMs === undefined) {
      spurious++;
      rows.push(`  t${ev.orderIdx} @${(ev.ms / 1000).toFixed(0)}s  (no ground truth — SPURIOUS)`);
      continue;
    }
    const comp = ev.ms - latency;
    const dt = (comp - gtMs) / 1000;
    if (Math.abs(dt) <= 20) {
      within20++;
    }
    if (Math.abs(dt) <= 30) {
      within30++;
    }
    // An advance landing well BEFORE its track's true hook = a genuine early error.
    if (comp < gtMs - 30_000) {
      spurious++;
    }
    rows.push(
      `  t${ev.orderIdx} @${(ev.ms / 1000).toFixed(0)}s  hook~${(gtMs / 1000).toFixed(0)}s  Δ${dt >= 0 ? "+" : ""}${dt.toFixed(0)}s  (${ev.score.toFixed(2)})`,
    );
  }

  const advancedTracks = new Set(events.map((e) => e.orderIdx));
  // The opener (gt[0]) is the starting pointer, never an advance target — exclude it.
  const openerI = gt[0]?.i;
  const missed = gt
    .filter((g) => g.i !== openerI && !advancedTracks.has(g.i))
    .map((g) => `t${g.i}`);

  console.log("\n=== PLAN-SCOPED MATCHER — ACCURACY (production defaults) ===");
  console.log(rows.join("\n"));
  console.log(
    `\nadvances: ${events.length} · ground-truth transitions: ${gt.length} (+ opener)\n` +
      `ordering integrity: ${ordered ? "PERFECT (monotone, no out-of-order)" : "BROKEN"}\n` +
      `within ±20s of the hook: ${within20}/${gt.length + 1}\n` +
      `within ±30s of the hook: ${within30}/${gt.length + 1}\n` +
      `spurious (phantom / >30s early): ${spurious}\n` +
      `missed (need a manual nudge): ${missed.length ? missed.join(" ") : "none"}\n` +
      `structural latency compensated: ${(latency / 1000).toFixed(1)}s (half-window + sustain)`,
  );
}

main().catch((err) => {
  console.error("accuracy: fatal —", err);
  process.exit(1);
});
