#!/usr/bin/env bun
// embed-batch.ts — the GPU BATCH embed path (docs/gpu-batch-embed.md).
//
// The on-box sweep (embed-sweep.ts) embeds ONE track per 5-minute tick on rave-02, which is
// CPU-only: a windowed full-song MuQ forward is minutes-scale there, so the box does roughly
// a dozen tracks a day. That is fine for the certified archive — Fluncle finds ~15 tracks a
// WEEK — and hopeless for the catalogue, which the crawler will land in the thousands. At a
// dozen a day, a 10k catalogue is two years, and The Ear ranks by embedding, so a catalogue
// track with no vector is a track The Ear cannot hear at all.
//
// So this is the other shape of the same job: take tracks off the SAME queue, pull their audio,
// embed them on a rented GPU, and write the vectors back through the SAME agent-tier API. It is
// not a cron — it is an OPERATOR-FIRED batch on a rented pod (RunPod), because the pod costs
// money by the minute and nothing here should be able to start one on its own.
//
// ── THE RUN IS BOUNDED BY THE CLOCK, NOT BY THE QUEUE ─────────────────────────────────────
// THIS IS THE WHOLE DESIGN. You do not rent 200 tracks; you rent an HOUR. A run that embeds one
// page and exits leaves the pod idle for the rest of the hour you already bought — the entire
// cost with almost none of the benefit. So the run takes a TIME budget (`--minutes`, default 55)
// and keeps pulling pages until the queue is DRY or the budget is spent.
//
// 55, not 60, on purpose: spilling one minute past an hour boundary buys a whole SECOND hour for
// one track. Stop short, deliberately. `--minutes 115` for a two-hour block.
//
// `--limit` is the PAGE size, never the run size. The run size is the clock.
//
// ── THE PAGE IS SIZED TO THE TIME THAT IS LEFT ────────────────────────────────────────────
// A page whose audio was downloaded and then abandoned is money paid for nothing, so a page is
// never STARTED that the budget cannot finish: each page is cut to `remaining time ÷ OBSERVED
// per-track time`, measured from the pages this run has already done — never a hardcoded guess.
//
// The first page has nothing to observe, and a page cannot be stopped halfway. So the first page
// is ONE TRACK: a calibration probe. It costs a model load and a song, it cannot overrun the
// budget by more than that one track however slow the pod turns out to be, and it buys the real
// number that sizes every page after it. (The alternative — sizing page 1 off a guess — is the
// one mistake here that can cost hours of rental if the guess is wrong in the wrong direction.)
//
// A page pulled speculatively by the prefetch is then re-checked against the REAL clock before a
// second of GPU time is spent on it: if the budget moved, the page is trimmed, or dropped whole.
//
// ── THE DOWNLOAD OVERLAPS THE GPU ─────────────────────────────────────────────────────────
// The pod is remote from R2 and the GPU is the expensive thing in the room, so the NEXT page's
// audio is pulled WHILE the current page is on the GPU. `DOWNLOAD_CONCURRENCY` is the within-page
// parallelism; this is the across-page one, and it is where the throughput actually is.
//
// It costs one non-obvious constraint, and it is why the page cap is 100 rather than the server's
// 200: the tracks currently ON the GPU have not had their vectors written back yet, so the server
// still lists them at the HEAD of the queue. To see PAST them, the prefetch's worklist read asks
// for `already-claimed + wanted` rows and filters what this run already holds — which only fits
// under the server's 200-row ceiling if a page is at most half of it.
//
// ── WHAT MAKES THE TWO PATHS ONE PIPELINE ────────────────────────────────────────────────
// The inference is the SAME script (embed-track.py) with two env knobs — `MUQ_DEVICE=cuda` and
// a wider `MUQ_WINDOW_BATCH`. That is deliberate and it is the load-bearing decision here: the
// decode → window → mean-pool → L2-normalize pipeline IS the embedding contract, and a second
// implementation of it "for the GPU" is how you end up with two vectors of the same track that
// no longer sit in the same space. Same script, same windows, same pooling — only the device
// and the number of kernel launches differ. A CPU-embedded finding and a GPU-embedded
// catalogue track are directly comparable, which is the entire point of The Ear.
//
// One python process per PAGE, not per run: the multi-second model load is amortized across the
// page (which is the win), and a page boundary is a natural place for the process to hand back
// its VRAM. A fresh load costs seconds against a page that costs minutes.
//
// ── THE BOUNDARY ─────────────────────────────────────────────────────────────────────────
// This is the CONSUMER side: given audio ALREADY in the private R2 bucket, embed it. How the
// bytes got there (the acquisition) is a separate concern with its own metered budget, and it
// is not this script's business. This one reads, embeds, and writes back — nothing else.
//
//   1. GET /api/v1/admin/tracks/work?kind=embed  → the worklist, in the server's drain order
//      (certified first, then the Ear's capture-priority ladder). Catalogue-aware.
//   2. S3-GET each track's captured full song from the PRIVATE bucket, CONCURRENTLY.
//   3. ONE `embed-track.py` call over the page.
//   4. PATCH each vector back via the agent-tier `update_track`. The WORKER is the publish
//      boundary; this pod never touches the database.
//
// NO fluncle CLI. A rented pod is a bare container, and the box's CLI is a pinned release
// baked into a different image — so every API call here is direct HTTP with the agent token,
// exactly as capture-sweep.ts already does for its queue read.
//
// RESUMABLE BY CONSTRUCTION. An embedded track leaves the `embedding_json IS NULL` queue, so
// re-running after a crash (or a pod that got reclaimed) simply picks up what is left. Nothing
// is checkpointed because nothing needs to be — and the write-back is per TRACK, not per page,
// so a pod that dies at track 400 of 500 has 400 vectors safely in the archive.
//
// AND IT REPORTS HONESTLY. The final summary carries `remaining` — the size of the WHOLE
// backlog, counted server-side, not the length of the last page. A run that says "done" while
// 8,000 tracks are still queued is lying to the person deciding whether to rent another hour.
//
// Usage (on the pod — see docs/gpu-batch-embed.md for the full runbook):
//   bun embed-batch.ts --minutes 55            # a one-hour rental
//   bun embed-batch.ts --minutes 115           # a two-hour block
//   bun embed-batch.ts --dry-run               # what would this do — no GPU, no billed bytes
//
// stdout: one JSON summary line. Diagnostics → stderr.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";
const EMBED_SCRIPT =
  process.env.FLUNCLE_EMBED_SCRIPT ?? new URL("embed-track.py", import.meta.url).pathname;

// The PRIVATE source-audio bucket. Read-only is all this needs — it never writes an object.
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const R2_ACCESS_KEY_ID = process.env.FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET = process.env.FLUNCLE_SOURCE_AUDIO_R2_BUCKET ?? "fluncle-source-audio";
const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

/** How many R2 GETs are in flight at once, WITHIN a page. (Across pages, see the prefetch.) */
const DOWNLOAD_CONCURRENCY = Number(process.env.FLUNCLE_EMBED_DOWNLOAD_CONCURRENCY ?? "6");

/** The server's own ceiling on ONE worklist read. */
export const MAX_QUEUE_LIMIT = 200;

/**
 * The largest PAGE this run will take — half the server's worklist ceiling, and that is not a
 * round number chosen for taste.
 *
 * The page currently on the GPU has not been written back yet, so the server still lists those
 * tracks at the HEAD of the embed queue. The prefetch therefore has to read PAST them: it asks
 * for `claimed + wanted` rows and drops what this run already holds. That read is capped at 200
 * by the server, so `page + page <= 200` is exactly the condition under which a prefetch can see
 * any new work at all. A 200-track page would make the cross-page prefetch structurally
 * impossible — the read would come back full of the page already in flight.
 */
export const MAX_PAGE = 100;

/** The default rental, in minutes. 55 and not 60 — see the header: never spill past the hour. */
export const DEFAULT_MINUTES = 55;

/**
 * The per-track time assumed on the FIRST page, before this run has measured anything.
 *
 * It is used for ONE decision only — "is there time to attempt anything at all" — and it is
 * deliberately pessimistic: a mid-range CUDA GPU embeds a full song in seconds, so 60s is a wide
 * margin. It is NOT used to size a real page, because a guess is not a measurement (see
 * CALIBRATION_TRACKS).
 */
export const FIRST_PAGE_TRACK_MS = Number(process.env.FLUNCLE_EMBED_FIRST_PAGE_TRACK_MS ?? "60000");

/**
 * THE CALIBRATION PAGE. The first page of a run is ONE track.
 *
 * This is the honest answer to "you have no measurement on the first page". A guess — however
 * conservative — is not a measurement, and the run cannot stop in the MIDDLE of a page: whatever
 * the first page starts, it finishes. So if the first page were sized off a guess and the pod
 * turned out to be 6× slower than the guess, the run would blow through the hour by hours. That
 * is the one failure mode that can actually cost real money.
 *
 * So the first page is a single track: a probe. It costs one model load and one song, it CANNOT
 * overrun the budget by more than one track, and it buys the real number — the pod's observed
 * per-track wall time, model load included — that sizes every page after it. On a 4090 that probe
 * is under a minute of a 55-minute run; on a CPU pod it is the measurement that (correctly) keeps
 * every later page tiny.
 *
 * The probe's rate over-states the marginal cost (it carries the whole model load on one track),
 * which errs toward caution; the running average across pages converges on the truth as the run
 * goes on.
 */
export const CALIBRATION_TRACKS = Math.max(
  1,
  Number(process.env.FLUNCLE_EMBED_CALIBRATION_TRACKS ?? "1"),
);

/** Headroom on the OBSERVED per-track time. A page that runs 25% slow must still fit. */
export const SAFETY_FACTOR = Number(process.env.FLUNCLE_EMBED_SAFETY_FACTOR ?? "1.25");

const log = (message: string) => console.error(`[embed-batch] ${message}`);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkItem = {
  artists?: string[];
  certified?: boolean;
  logId?: null | string;
  sourceAudioKey?: null | string;
  title?: string;
  trackId?: string;
};

export type EmbedResult = { embedding: number[]; id: string };
export type EmbedError = { error: string; id: string };
export type EmbedOutput = { errors?: EmbedError[]; results?: EmbedResult[] };

export type BatchArgs = {
  dryRun: boolean;
  /** The PAGE size. The RUN size is the clock. */
  limit: number;
  minutes: number;
  scope: "all" | "catalogue" | "findings";
};

/** One page of audio on the pod's disk, ready for the GPU. */
export type PageAudio = {
  entries: Array<{ id: string; path: string }>;
  workdir: string;
};

export type QueuePage = {
  /** The size of the WHOLE backlog — only when the read asked for it. */
  queued?: number;
  tracks: WorkItem[];
};

/**
 * Why the run ended. The operator reads this before deciding whether to rent again.
 *
 *   `queue_dry`     — nothing left to embed. The only reason that means "done".
 *   `budget_spent`  — the clock ran out. There is more work; rent another block.
 *   `queue_blocked` — every row the server can show us is one this run already tried and could
 *                     not finish (a dead R2 object, a failing write-back). No progress is
 *                     possible without looking at those tracks.
 *   `embed_failed`  — the python side exited non-zero. Systemic (OOM, missing weights); stop.
 */
export type StopReason = "budget_spent" | "embed_failed" | "queue_blocked" | "queue_dry";

export type BatchSummary = {
  /** Audio pulled from R2 and then NOT embedded, because the clock moved. Should be 0 or tiny. */
  abandoned: number;
  catalogue: number;
  downloadFailed: number;
  downloaded: number;
  /** Vectors actually WRITTEN BACK. The number that matters. */
  embedded: number;
  /** Tracks the model could not embed (a bad decode). They stay queued. */
  failed: number;
  findings: number;
  minutes: number;
  pages: number;
  /** The WHOLE backlog after this run, counted server-side. `null` when the count was refused. */
  remaining: null | number;
  scope: string;
  stopReason: StopReason;
  tracksPerMinute: number;
  writeFailed: number;
};

/**
 * Everything the drain loop touches that is not pure. Injected so the clock bound, the page
 * sizing, the prefetch overlap and the resumability can be proven with a FAKE clock and a
 * STUBBED GPU — no pod, no R2, no python (embed-batch.test.ts).
 */
export type BatchDeps = {
  /** Delete a page's audio from the pod's disk. Private audio never outlives its page. */
  discard: (audio: PageAudio) => void;
  download: (items: WorkItem[], workdir: string) => Promise<PageAudio["entries"]>;
  embed: (audio: PageAudio) => Promise<EmbedOutput>;
  fetchQueue: (options: { count: boolean; limit: number }) => Promise<QueuePage>;
  log: (message: string) => void;
  mkWorkdir: () => string;
  now: () => number;
  write: (trackId: string, embedding: number[]) => Promise<void>;
};

/** The python side exited non-zero — systemic, not per-track. */
export class EmbedScriptError extends Error {}

// ---------------------------------------------------------------------------
// Pure helpers (exported for embed-batch.test.ts)
// ---------------------------------------------------------------------------

/**
 * Parse the pod's argv. Everything has a safe default.
 *
 * `--limit` is the PAGE size, clamped to MAX_PAGE (see its comment — the prefetch needs the
 * headroom under the server's 200-row read). `--minutes` is the RUN, and it is the number the
 * operator actually reaches for: match it to the block you rented, minus a margin.
 */
export function parseBatchArgs(argv: string[]): BatchArgs {
  const args: BatchArgs = {
    dryRun: false,
    limit: MAX_PAGE,
    minutes: envMinutes(),
    scope: "all",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--limit") {
      const value = Number(argv[index + 1]);

      if (Number.isFinite(value) && value > 0) {
        args.limit = Math.min(Math.trunc(value), MAX_PAGE);
      }

      index += 1;
    } else if (arg === "--minutes") {
      const value = Number(argv[index + 1]);

      if (Number.isFinite(value) && value > 0) {
        args.minutes = Math.trunc(value);
      }

      index += 1;
    } else if (arg === "--scope") {
      const value = argv[index + 1];

      if (value === "all" || value === "catalogue" || value === "findings") {
        args.scope = value;
      }

      index += 1;
    }
  }

  return args;
}

function envMinutes(): number {
  const value = Number(process.env.FLUNCLE_EMBED_RUN_MINUTES ?? "");

  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : DEFAULT_MINUTES;
}

/**
 * The file extension of a source-audio key, so the temp file carries the captured container's
 * suffix. ffmpeg decodes by content, so this is hygiene rather than load-bearing.
 */
export function sourceAudioExt(key: string): string {
  const base = key.slice(key.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");

  if (dot <= 0 || dot === base.length - 1) {
    return ".audio";
  }

  return base.slice(dot).toLowerCase();
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight, preserving nothing about
 * order (the manifest is keyed by trackId, not by position). A worker that throws yields
 * `null` — one dead object in R2 must never sink the batch, and the track simply stays queued.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<null | R>> {
  const results: Array<null | R> = Array.from({ length: items.length }, () => null);
  const width = Math.max(1, Math.trunc(concurrency));
  let next = 0;

  async function pump(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;

      if (index >= items.length) {
        return;
      }

      const item = items[index];

      if (item === undefined) {
        continue;
      }

      try {
        results[index] = await worker(item);
      } catch {
        results[index] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(width, items.length) }, () => pump()));

  return results;
}

/**
 * How many tracks the time that is LEFT can pay for.
 *
 * This is the page sizer, and it is the whole reason a run fills its hour without spilling out
 * of it: never a hardcoded batch size, always `time left ÷ what a track actually costs`.
 *
 *   `perTrackMs` — the OBSERVED per-track wall time of the pages already done this run (embed
 *                  + write-back), widened by SAFETY_FACTOR. Before the first page there is
 *                  nothing to observe, so the caller passes FIRST_PAGE_TRACK_MS.
 *
 * Returns 0 when the budget cannot pay for even one track — which is the signal to STOP rather
 * than start a page that would be abandoned half-downloaded.
 */
export function affordableTracks(options: {
  at: number;
  deadline: number;
  page: number;
  perTrackMs: number;
}): number {
  const left = options.deadline - options.at;

  if (left <= 0 || options.perTrackMs <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(options.page, Math.floor(left / options.perTrackMs)));
}

// ---------------------------------------------------------------------------
// The drain loop — the run, bounded by the clock
// ---------------------------------------------------------------------------

/**
 * Pull pages off the embed queue until the queue is DRY or the time budget is spent.
 *
 * Every effect is injected (see BatchDeps), so this function is the thing the tests drive with
 * a fake clock and a stubbed GPU — the clock bound, the "never start a page you cannot finish"
 * rule, the prefetch overlap and the honest remaining-count are properties of THIS function and
 * are proven without renting anything.
 */
export async function runBatch(args: BatchArgs, deps: BatchDeps): Promise<BatchSummary> {
  const startedAt = deps.now();
  const deadline = startedAt + args.minutes * 60_000;

  // Every track this run has taken responsibility for — embedded, failed, or trimmed. It is
  // what lets the prefetch read PAST the page still on the GPU (whose rows the server, quite
  // correctly, still lists as un-embedded), and what stops a track that failed once from being
  // handed back forever by a queue that is ordered, not stateful.
  const claimed = new Set<string>();

  const summary: BatchSummary = {
    abandoned: 0,
    catalogue: 0,
    downloadFailed: 0,
    downloaded: 0,
    embedded: 0,
    failed: 0,
    findings: 0,
    minutes: 0,
    pages: 0,
    remaining: null,
    scope: args.scope,
    stopReason: "queue_dry",
    tracksPerMinute: 0,
    writeFailed: 0,
  };

  let pageMs = 0;
  let pageTracks = 0;
  let queueStop: null | StopReason = null;

  /** The measured cost of one track, widened. Before the probe: the pessimistic assumption. */
  const perTrackMs = (): number =>
    pageTracks > 0 ? (pageMs / pageTracks) * SAFETY_FACTOR : FIRST_PAGE_TRACK_MS;

  /** Has this run MEASURED the pod yet, or is it still guessing? */
  const calibrated = (): boolean => pageTracks > 0;

  const affordable = (at: number): number =>
    affordableTracks({ at, deadline, page: args.limit, perTrackMs: perTrackMs() });

  /**
   * How big the next page may be, at time `at`.
   *
   * Two rules, and the second is the one that keeps a slow pod from eating the whole rental:
   * the budget decides the ceiling, and until the run has MEASURED the pod, the page is the
   * one-track calibration probe. A page cannot be stopped in the middle, so an un-calibrated
   * run never starts one it would regret.
   */
  const nextPageSize = (at: number): number =>
    Math.min(affordable(at), calibrated() ? args.limit : CALIBRATION_TRACKS);

  /**
   * Claim `desired` tracks off the queue and pull their audio.
   *
   * The read OVER-fetches by what this run already holds: the page on the GPU has not been
   * written back, so those rows are still at the head of the server's queue. Filtering them
   * client-side is what makes the prefetch see new work at all.
   */
  async function claimPage(desired: number): Promise<null | PageAudio> {
    const want = Math.max(1, Math.min(desired, args.limit));
    const readLimit = Math.min(MAX_QUEUE_LIMIT, claimed.size + want);
    const { tracks } = await deps.fetchQueue({ count: false, limit: readLimit });

    const fresh = tracks
      .filter(
        (item): item is WorkItem & { sourceAudioKey: string; trackId: string } =>
          Boolean(item.trackId) && Boolean(item.sourceAudioKey) && !claimed.has(item.trackId ?? ""),
      )
      .slice(0, want);

    if (fresh.length === 0) {
      // Rows came back and NONE of them is new: every track the server can show us is one this
      // run already tried and could not finish (a dead R2 object, a failing write-back). That is
      // not an empty queue, and calling it one would be the lie this whole summary exists to
      // avoid. Only a genuinely empty read is a drained queue.
      queueStop = tracks.length > 0 ? "queue_blocked" : "queue_dry";

      return null;
    }

    for (const item of fresh) {
      claimed.add(item.trackId);

      if (item.certified) {
        summary.findings += 1;
      } else {
        summary.catalogue += 1;
      }
    }

    const workdir = deps.mkWorkdir();
    const entries = await deps.download(fresh, workdir);

    summary.downloadFailed += fresh.length - entries.length;
    summary.downloaded += entries.length;

    return { entries, workdir };
  }

  /** One page through the GPU and back into the archive, timed (the timing IS the page sizer). */
  async function embedPage(audio: PageAudio): Promise<void> {
    const at = deps.now();
    const output = await deps.embed(audio);

    // Write back per TRACK, not per page: a pod reclaimed mid-write-back keeps every vector it
    // already sent, and the rest simply stay queued.
    for (const result of output.results ?? []) {
      try {
        await deps.write(result.id, result.embedding);
        summary.embedded += 1;
      } catch (error) {
        summary.writeFailed += 1;
        deps.log(
          `${result.id}: write-back failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    for (const failure of output.errors ?? []) {
      summary.failed += 1;
      deps.log(`${failure.id}: embed error — ${failure.error}`);
    }

    // The whole page's wall clock — embed AND write-back — over the tracks it attempted. That
    // is what the next page is sized against.
    pageMs += deps.now() - at;
    pageTracks += audio.entries.length;
  }

  /**
   * Close the run — and COUNT what is left.
   *
   * The count is a server-side count of the WHOLE backlog, taken AFTER the write-backs, and it
   * is the only reason this summary can be trusted: the length of the last page says nothing
   * about the 8,000 rows behind it, and "how many are still queued" is precisely the question
   * the operator is answering when he decides whether to rent another hour. It is asked ONCE,
   * here, so no page read pays for it.
   */
  const finish = async (stopReason: StopReason): Promise<BatchSummary> => {
    try {
      const { queued } = await deps.fetchQueue({ count: true, limit: 1 });

      summary.remaining = queued ?? null;
    } catch (error) {
      deps.log(`remaining count failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const minutes = (deps.now() - startedAt) / 60_000;

    summary.stopReason = stopReason;
    summary.minutes = Math.round(minutes * 10) / 10;
    summary.tracksPerMinute =
      minutes > 0 ? Math.round((summary.embedded / minutes) * 100) / 100 : 0;

    return summary;
  };

  /** The page the prefetch is pulling right now. `null` = nothing in flight; claim one serially. */
  let pending: null | Promise<null | PageAudio> = null;

  /**
   * Was `pending` claimed by the PREFETCH — i.e. read while the previous page was still on the
   * GPU and therefore still listed as un-embedded by the server?
   *
   * It matters for exactly one judgement: an empty prefetch is not evidence of an empty queue.
   * The prefetch reads BEFORE the current page's vectors are written back, so on the last page of
   * a run every row it can see is one this run already holds — which looks identical to a drained
   * queue and to a blocked one. So an empty PREFETCH is never a verdict; the loop simply re-reads
   * serially once the write-backs have landed, and judges on that.
   */
  let prefetched = false;

  /** Drop a page the prefetch pulled that the run will never embed. Private audio, off the disk. */
  const dropPending = async (): Promise<void> => {
    if (pending === null) {
      return;
    }

    await pending.then(
      (orphan) => {
        if (orphan) {
          summary.abandoned += orphan.entries.length;
          deps.discard(orphan);
        }
      },
      () => undefined,
    );

    pending = null;
  };

  for (;;) {
    // NOTHING IN FLIGHT → size the next page against the REAL clock and claim it. This is the
    // only gate that decides whether the run continues; the prefetch below is an optimization on
    // top of it, never the authority. (First time round, `nextPageSize` yields the one-track
    // calibration probe — the run has not measured the pod yet.)
    if (pending === null) {
      const size = nextPageSize(deps.now());

      if (size === 0) {
        return await finish("budget_spent");
      }

      pending = claimPage(size);
    }

    let page: null | PageAudio;

    try {
      page = await pending;
    } catch (error) {
      deps.log(`queue read failed: ${error instanceof Error ? error.message : String(error)}`);

      return await finish("queue_blocked");
    }

    pending = null;

    if (page === null) {
      // An empty PREFETCH proves nothing (see `prefetched`) — the write-backs have landed since,
      // so read the queue again, serially, and judge on THAT.
      if (prefetched) {
        prefetched = false;
        queueStop = null;
        continue;
      }

      return await finish(queueStop ?? "queue_dry");
    }

    prefetched = false;

    if (page.entries.length === 0) {
      // Every object in this page failed to download. Those tracks are CLAIMED (so the queue
      // cannot hand them straight back), the queue is not necessarily dry, and the clock is still
      // running — take another page rather than calling this a drained queue.
      deps.discard(page);
      continue;
    }

    summary.pages += 1;

    // THE RE-CHECK. This page may have been downloaded speculatively while the previous one was
    // on the GPU, and the clock has moved since. Not a second of GPU time is spent on it without
    // asking the REAL time whether it still fits.
    const allowed = affordable(deps.now());

    if (allowed === 0) {
      summary.abandoned += page.entries.length;
      deps.discard(page);

      return await finish("budget_spent");
    }

    const trimmed = allowed < page.entries.length;
    const entries = trimmed ? page.entries.slice(0, allowed) : page.entries;

    if (trimmed) {
      summary.abandoned += page.entries.length - entries.length;
      deps.log(`budget: trimming this page to ${entries.length} track(s) — the hour is nearly up`);
    }

    // PREFETCH — the across-page overlap, and where the throughput is. Kick the next page's R2
    // pull NOW so it runs while this page is on the (expensive) GPU.
    //
    // Only once the run has MEASURED the pod: projecting the finish time of the calibration probe
    // off the very guess the probe exists to replace is how you download a page you cannot afford.
    // And a mis-projection here is not a hazard — the page it pulls is re-checked against the real
    // clock at the top of the next iteration, so the worst case is a trim, never an overrun.
    if (!trimmed && calibrated()) {
      const projectedEnd = deps.now() + entries.length * perTrackMs();
      const next = nextPageSize(projectedEnd);

      pending = next > 0 ? claimPage(next) : null;
      prefetched = pending !== null;
    }

    try {
      await embedPage({ entries, workdir: page.workdir });
    } catch (error) {
      deps.discard(page);
      deps.log(`embed step failed: ${error instanceof Error ? error.message : String(error)}`);
      await dropPending();

      return await finish(error instanceof EmbedScriptError ? "embed_failed" : "queue_blocked");
    }

    deps.discard(page);

    if (trimmed) {
      // The trim WAS the last of the budget. Nothing was prefetched behind it.
      return await finish("budget_spent");
    }

    deps.log(
      `page ${summary.pages}: ${summary.embedded} embedded · ${Math.max(0, Math.round((deadline - deps.now()) / 60_000))} min left · ~${Math.round(perTrackMs() / 1000)}s/track`,
    );
  }
}

// ---------------------------------------------------------------------------
// AWS SigV4 — MIRROR of apps/web/src/lib/server/aws-sigv4.ts (via embed-sweep.ts).
// Box/pod scripts cannot import the workspace, so the self-contained copy is the norm.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  let hex = "";

  for (const byte of new Uint8Array(buffer)) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;

  return toHex(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );

  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalUri(pathname: string): string {
  return pathname.split("/").map(encodeRfc3986).join("/");
}

async function signS3Get(url: string): Promise<Record<string, string>> {
  const parsed = new URL(url);
  const now = new Date();
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = stamp.slice(0, 8);
  const payloadHash = await sha256Hex(new Uint8Array());
  const headers: Record<string, string> = {
    host: parsed.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    "GET",
    canonicalUri(parsed.pathname),
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(canonicalRequest)].join(
    "\n",
  );

  let signingKey: ArrayBuffer | Uint8Array = encoder.encode(`AWS4${R2_SECRET_ACCESS_KEY}`);

  for (const part of [dateStamp, "auto", "s3", "aws4_request"]) {
    signingKey = await hmac(signingKey, part);
  }

  const signature = toHex(await hmac(signingKey, stringToSign));
  const { host: _host, ...sent } = headers;

  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/** GET the captured full song from the PRIVATE bucket. The key is used AS STORED, never rebuilt. */
async function r2Get(key: string): Promise<Uint8Array> {
  const url = `${R2_ENDPOINT}/${R2_BUCKET}/${encodeKey(key)}`;
  const res = await fetch(url, { headers: await signS3Get(url), method: "GET" });

  if (!res.ok) {
    throw new Error(`R2 GET ${key} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// The agent-tier API (direct HTTP — the Worker is the publish boundary)
// ---------------------------------------------------------------------------

async function fetchEmbedQueue(
  scope: BatchArgs["scope"],
  options: { count: boolean; limit: number },
): Promise<QueuePage> {
  const params = new URLSearchParams({
    kind: "embed",
    limit: String(Math.min(Math.max(1, options.limit), MAX_QUEUE_LIMIT)),
    scope,
  });

  // `count=true` costs the server a COUNT over the (partial-indexed) embed backlog, so it is
  // asked ONCE per run — at the end, for the honest `remaining`. The paging reads do not pay it.
  if (options.count) {
    params.set("count", "true");
  }

  const res = await fetch(`${API_BASE_URL}/api/v1/admin/tracks/work?${params.toString()}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`embed queue read failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  const body = (await res.json()) as QueuePage;

  return { queued: body.queued, tracks: Array.isArray(body.tracks) ? body.tracks : [] };
}

/**
 * Write ONE vector back through the agent-tier `update_track`. NOTHING ELSE is sent: no status,
 * no note, no coordinate. `embedding` is a `tracks` column, so this is legal on a catalogue
 * track — and the certification fields are not, which the server enforces (a 409 `uncertified`).
 * The pod holds an agent token and never speaks to the database.
 */
async function writeEmbedding(trackId: string, embedding: number[]): Promise<void> {
  const url = `${API_BASE_URL}/api/v1/admin/tracks/${encodeURIComponent(trackId)}`;
  const res = await fetch(url, {
    body: JSON.stringify({ embedding }),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "content-type": "application/json",
    },
    method: "PATCH",
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(
      `update_track ${trackId} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The real (pod-side) effects
// ---------------------------------------------------------------------------

/**
 * ONE `embed-track.py` per page, spawned ASYNCHRONOUSLY.
 *
 * Async is load-bearing, not stylistic: the old `spawnSync` blocked the event loop for the whole
 * page, which would have made the cross-page prefetch a no-op. With `spawn`, the next page's R2
 * pull runs while the GPU works. python's stderr is inherited so its per-track progress reaches
 * the operator's terminal live during a 55-minute run.
 */
function runEmbedScript(audio: PageAudio): Promise<EmbedOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [EMBED_SCRIPT], { stdio: ["pipe", "pipe", "inherit"] });
    let stdout = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.on("error", (error) => reject(new EmbedScriptError(String(error))));

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new EmbedScriptError(`embed-track exited ${code}`));

        return;
      }

      try {
        resolve(JSON.parse(stdout) as EmbedOutput);
      } catch {
        reject(new EmbedScriptError(`embed-track did not return JSON: ${stdout.slice(0, 200)}`));
      }
    });

    child.stdin.end(JSON.stringify(audio.entries));
  });
}

function podDeps(args: BatchArgs): BatchDeps {
  return {
    discard: (audio) => rmSync(audio.workdir, { force: true, recursive: true }),
    download: async (items, workdir) => {
      const downloaded = await mapWithConcurrency(items, DOWNLOAD_CONCURRENCY, async (item) => {
        const key = item.sourceAudioKey;
        const id = item.trackId;

        if (!key || !id) {
          return null;
        }

        const path = join(workdir, `${id}${sourceAudioExt(key)}`);
        writeFileSync(path, await r2Get(key));

        return { id, path };
      });

      return downloaded.filter((entry): entry is { id: string; path: string } => entry !== null);
    },
    embed: runEmbedScript,
    fetchQueue: (options) => fetchEmbedQueue(args.scope, options),
    log,
    mkWorkdir: () => mkdtempSync(join(tmpdir(), "fluncle-embed-batch-")),
    now: () => Date.now(),
    write: writeEmbedding,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseBatchArgs(process.argv.slice(2));

  if (!API_TOKEN) {
    console.log(JSON.stringify({ ok: false, reason: "missing_api_token" }));
    process.exitCode = 1;

    return;
  }

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.log(JSON.stringify({ ok: false, reason: "missing_r2_credentials" }));
    process.exitCode = 1;

    return;
  }

  if (args.dryRun) {
    // The pod costs money by the minute, so "what would this run do" must be answerable WITHOUT
    // starting the GPU and without pulling a single (billed) byte out of R2. It answers the two
    // questions that decide the rental: how big is the backlog, and how much of it fits.
    const { queued, tracks } = await fetchEmbedQueue(args.scope, {
      count: true,
      limit: args.limit,
    });

    log(`dry run — ${queued ?? "?"} track(s) queued (${args.scope})`);
    log(`  budget ${args.minutes} min · page ${args.limit} · first page assumes`);
    log(`  ${Math.round(FIRST_PAGE_TRACK_MS / 1000)}s/track until the run measures the real rate`);

    for (const item of tracks) {
      log(
        `  ${item.logId ?? `${item.trackId} · catalogue`} — ${(item.artists ?? []).join(", ")} — ${item.title ?? "?"}`,
      );
    }

    console.log(
      JSON.stringify({
        dryRun: true,
        minutes: args.minutes,
        ok: true,
        page: args.limit,
        queued: queued ?? null,
        scope: args.scope,
      }),
    );

    return;
  }

  log(`run: ${args.minutes} min budget · page ${args.limit} · scope ${args.scope}`);

  const deps = podDeps(args);
  const summary = await runBatch(args, deps);

  log(
    summary.remaining === 0
      ? `done — the ${args.scope} embed queue is drained.`
      : `${summary.remaining ?? "?"} still queued. ${summary.stopReason === "budget_spent" ? "Rent another block to keep going." : ""}`,
  );

  console.log(JSON.stringify({ ok: summary.stopReason !== "embed_failed", ...summary }));

  if (summary.stopReason === "embed_failed") {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    console.log(JSON.stringify({ ok: false, reason: "fatal" }));
    process.exitCode = 1;
  });
}
