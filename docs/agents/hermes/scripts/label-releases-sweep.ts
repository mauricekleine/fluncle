#!/usr/bin/env bun
// label-releases-sweep.ts — the bun orchestrator behind the FRESHNESS TAP cron (`fluncle-label-releases`,
// D8), scheduled by a rave-02 HOST systemd timer (../label-releases-timer/).
//
// WHY THIS EXISTS. MusicBrainz WALKS the graph (the crawler), but its editorial database lags a
// release by ~2 weeks, so a Friday drop is invisible on /fresh until the volunteers enter it. Spotify
// has it day one. So the tap finds each ENABLED seed label's last-two-weeks releases and mints
// METADATA-ONLY catalogue rows with their real (day-one) dates.
//
// THIS SCRIPT IS A TRIGGER, NOT A PIPELINE. All the work — the Spotify search, the album/track reads,
// the artist-grounding + copyright gate, the dedupe, the mint — happens in the WORKER
// (`backfill_label_releases`, apps/web/src/lib/server/label-releases.ts). The box holds no Spotify
// identity and no vendor token on this path; it just paces the Worker, one bounded pass per POST.
//
// WHY NOT THE ACTOR ANY MORE (2026-07-20). For half a day this sweep ran the Apify actor
// `musicae~spotify-extended-scraper` itself and POSTed candidate albums for the Worker to verify —
// to keep the tap off the official Spotify app's small shared budget. That is REVERTED: the actor's
// ALBUM mode broke Spotify-side (an album search, an album-by-id, and a famous-album query all came
// back `result:"0/N", albums:[]` while its TRACK mode kept working and the actor's own code was
// untouched — a rotated persisted-query hash only its maintainer can re-fix). The alternatives were
// measured dead too: apiharvest's actors 403 behind their residential proxy, and the working TRACK
// mode cannot substitute (`tag:new` is ALBUM-only, and track results carry no release_date — the one
// field this tap exists for). The official API's album search is documented and stable, and the
// budget problem is now solved properly by the shared call meter the Worker paces itself against.
// THE ANCHOR SWEEP STILL USES THE ACTOR (its TRACK mode works) and is untouched by this.
//
// WHY HTTP AND NOT THE CLI. The baked `fluncle` CLI is a PINNED release, so this sweep calls the
// oRPC endpoint DIRECTLY with the agent token (the anchor-sweep precedent) rather than shelling out
// to `fluncle admin backfills label-releases` — a pinned CLI that predates a flag fails the run
// outright (`Unknown option '--limit'`, seen live). HTTP has no such version coupling.
//
// LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (label-releases-sweep.sh) the host
// timer docker-execs — see that file's header for the wire-up and ../label-releases-timer/README.md.
//
// ── THE LOOP, per tick ───────────────────────────────────────────────────────────────────────
// POST one bounded pass at a time until the work is done, because a pass is capped at a few labels
// by design. It stops on: nothing due (`labelsProbed: 0`), a Spotify 429, a gone grant
// (`configured: false`), or the pass fuse. THE ONE CASE IT WAITS ON is `budgetPaused` — the Worker
// stepped back from the shared Spotify window to leave room for a user's playlist mint. That is the
// system working, not a fault: the window is ~30s, so the sweep sleeps one window and carries on,
// bounded by its own pause fuse so a permanently-busy app can never spin here all night.
//
// COST. Zero vendor spend and zero LLM tokens — the Worker's Spotify calls ride the OAuth grant we
// already hold. Pause = stop the timer. Attended burn = `--limit N`.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

// ── Config (env; the shared ~/.fluncle-secrets.env supplies the token on the box) ──

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

/** Enabled seed labels asked for per PASS. The Worker clamps this to its own per-pass cap; the
 *  sweep loops passes until the due set is drained. `--limit` overrides it for an attended burn. */
const BATCH = Number(process.env.FLUNCLE_LABEL_RELEASES_LABELS ?? "5");

/** The pass fuse — the most bounded passes one tick will drive. At the Worker's 5-labels-per-pass
 *  cap this is ~150 labels, comfortably more than the enabled seed set, so it only ever trips on a
 *  pathological loop (a pass that keeps reporting work but never stamps). */
const MAX_PASSES = Number(process.env.FLUNCLE_LABEL_RELEASES_MAX_PASSES ?? "30");

/** How long to stand down when the Worker reports it stepped back from the shared Spotify window.
 *  One meter window (`SPOTIFY_CALL_WINDOW_MS`, 30s) — long enough for the window to roll over. */
const BUDGET_WAIT_MS = Number(process.env.FLUNCLE_LABEL_RELEASES_BUDGET_WAIT_MS ?? "30000");

/** The pause fuse: consecutive budget stand-downs before the tick gives up and leaves the rest for
 *  the next one. A busy app is a reason to come back later, never a reason to spin. */
const MAX_BUDGET_WAITS = Number(process.env.FLUNCLE_LABEL_RELEASES_MAX_BUDGET_WAITS ?? "5");

const log = (message: string) => console.error(`[label-releases-sweep] ${message}`);

// ── Types ────────────────────────────────────────────────────────────────────

/** One bounded pass's verdict, as `backfill_label_releases` returns it (the fields the tick reads). */
export type PassResult = {
  albumsMatched: number;
  albumsSeen: number;
  /** The Worker stepped back from the shared Spotify window at the tap's ceiling — wait, retry. */
  budgetPaused: boolean;
  /** False when the publish path's Spotify grant is gone — the tap is a whole no-op until reconnect. */
  configured: boolean;
  failedLabels: string[];
  /** True when the pass ended on its per-pass single-fetch ceiling — more work remains. */
  fetchCeilingHit: boolean;
  /** Enabled seed labels whose search actually ran. 0 means nothing was due — the tick is done. */
  labelsProbed: number;
  newRows: number;
  rateLimited: boolean;
  skippedKnown: number;
  skippedUndated: number;
  skippedUngrounded: number;
};

/** One tick's honest tally — the JSON summary line. */
export type LabelReleasesSummary = {
  albumsMatched: number;
  albumsSeen: number;
  /** True when the tick ended standing down for the shared Spotify budget (not a fault). */
  budgetPaused: boolean;
  /** False when the Spotify grant is gone — nothing ran; the operator must reconnect Spotify. */
  configured: boolean;
  error: null | string;
  /** Seed labels that hit a transient Spotify error on their search (backed off, re-probed later). */
  failedLabels: number;
  /** Enabled seed labels probed across every pass this tick. */
  labelsProbed: number;
  newRows: number;
  ok: boolean;
  /** Bounded passes driven this tick. */
  passes: number;
  /** True when the tick stopped on a Spotify 429 (the backstop beneath the meter). */
  rateLimited: boolean;
  skippedKnown: number;
  skippedUndated: number;
  skippedUngrounded: number;
};

/** The injected effects — so the tick's loop + stop conditions are provable with stubs (no network). */
export type LabelReleasesDeps = {
  log: (message: string) => void;
  /** Drive ONE bounded pass (the `backfill_label_releases` POST). */
  runPass: (limit: number) => Promise<PassResult>;
  /** Stand down for the shared Spotify window (stubbed to a no-op in tests). */
  wait: (ms: number) => Promise<void>;
};

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Parse `--limit N` (an attended backlog burn); default is the tick's `FLUNCLE_LABEL_RELEASES_LABELS`. */
export function parseLimitArg(argv: string[], fallback: number): number {
  const index = argv.indexOf("--limit");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

// ── One tick, with injected effects ──────────────────────────────────────────

/**
 * Drive bounded passes until the due set is drained or a stop condition fires. The Worker owns every
 * decision; this only decides whether to ask again. `budgetPaused` is the sole WAIT-and-retry case
 * (the tap yielding the Spotify window to a user path); everything else either continues or stops.
 */
export async function runLabelReleasesTick(
  limit: number,
  deps: LabelReleasesDeps,
): Promise<LabelReleasesSummary> {
  const summary: LabelReleasesSummary = {
    albumsMatched: 0,
    albumsSeen: 0,
    budgetPaused: false,
    configured: true,
    error: null,
    failedLabels: 0,
    labelsProbed: 0,
    newRows: 0,
    ok: true,
    passes: 0,
    rateLimited: false,
    skippedKnown: 0,
    skippedUndated: 0,
    skippedUngrounded: 0,
  };

  let budgetWaits = 0;

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let result: PassResult;

    try {
      result = await deps.runPass(limit);
    } catch (error) {
      // A failed pass ends the tick — the per-label cadence stamps are durable, so the next tick
      // resumes from exactly where this one stopped. Nothing is lost by giving up here.
      summary.ok = false;
      summary.error = error instanceof Error ? error.message : String(error);

      return summary;
    }

    summary.passes += 1;
    summary.labelsProbed += result.labelsProbed;
    summary.albumsSeen += result.albumsSeen;
    summary.albumsMatched += result.albumsMatched;
    summary.newRows += result.newRows;
    summary.skippedKnown += result.skippedKnown;
    summary.skippedUndated += result.skippedUndated;
    summary.skippedUngrounded += result.skippedUngrounded;
    summary.failedLabels += result.failedLabels.length;

    if (!result.configured) {
      // The Spotify grant is gone. Not a crash — a documented no-op until the operator reconnects.
      summary.configured = false;
      deps.log("spotify grant gone (configured:false) — reconnect Spotify to resume the tap");

      return summary;
    }

    if (result.rateLimited) {
      summary.rateLimited = true;
      deps.log("stopped on a Spotify 429 — the next tick resumes");

      return summary;
    }

    if (result.budgetPaused) {
      // THE TAP YIELDED. The Worker stepped back to leave window headroom for a user's mint. Wait
      // one window and ask again — bounded, so a permanently-busy app ends the tick instead.
      budgetWaits += 1;
      summary.budgetPaused = true;

      if (budgetWaits > MAX_BUDGET_WAITS) {
        deps.log(
          `stood down ${MAX_BUDGET_WAITS}x for the shared Spotify budget — leaving the rest`,
        );

        return summary;
      }

      deps.log(`shared Spotify budget busy — standing down ${BUDGET_WAIT_MS}ms for a user path`);
      await deps.wait(BUDGET_WAIT_MS);
      continue;
    }

    // A pass that probed nothing means nothing is due — the tick is done.
    if (result.labelsProbed === 0) {
      return summary;
    }
  }

  deps.log(`hit the ${MAX_PASSES}-pass fuse — the next tick drains the rest`);

  return summary;
}

// ── The real (box-side) effects ───────────────────────────────────────────────

async function runPass(limit: number): Promise<PassResult> {
  const res = await fetch(`${API_BASE_URL}/api/admin/backfill/label-releases`, {
    body: JSON.stringify({ dryRun: false, limit }),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    // The Worker's pass makes a trickle of Spotify reads; generous, with headroom for a slow app.
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    throw new Error(
      `backfill_label_releases failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as Partial<PassResult>;

  return {
    albumsMatched: Number(body.albumsMatched ?? 0),
    albumsSeen: Number(body.albumsSeen ?? 0),
    budgetPaused: Boolean(body.budgetPaused),
    // Absent ⇒ configured: only an explicit `false` means the grant is gone.
    configured: body.configured !== false,
    failedLabels: Array.isArray(body.failedLabels) ? body.failedLabels : [],
    fetchCeilingHit: Boolean(body.fetchCeilingHit),
    labelsProbed: Number(body.labelsProbed ?? 0),
    newRows: Number(body.newRows ?? 0),
    rateLimited: Boolean(body.rateLimited),
    skippedKnown: Number(body.skippedKnown ?? 0),
    skippedUndated: Number(body.skippedUndated ?? 0),
    skippedUngrounded: Number(body.skippedUngrounded ?? 0),
  };
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const started = Date.now();

  if (!API_TOKEN) {
    console.log(JSON.stringify({ ok: false, reason: "missing_api_token" }));
    process.exit(1);
  }

  const limit = parseLimitArg(
    process.argv.slice(2),
    Number.isFinite(BATCH) && BATCH > 0 ? Math.trunc(BATCH) : 5,
  );

  const summary = await runLabelReleasesTick(limit, { log, runPass, wait });

  console.log(JSON.stringify({ ...summary, elapsedMs: Date.now() - started }));

  if (!summary.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`label-releases-sweep failed: ${message}`);
    console.log(JSON.stringify({ error: message, ok: false, reason: "label_releases_failed" }));
    process.exit(1);
  });
}
