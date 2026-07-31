#!/usr/bin/env bun
// backfill-sweep.ts — the bun orchestrator behind the `--no-agent` catalogue-backfill
// cron (`fluncle-backfill`).
//
// LIVE. Version-controlled source; the repo is canonical and the box is a
// deploy target (fluncle-hermes-operator skill). Invoked by the bash wrapper
// (backfill-sweep.sh) the cron runner execs on a schedule — see that file's header
// for the `host-timer` wire-up and ../cron/README.md for the cron model.
//
// THE WORKER-PACED MODEL. The box holds NO Discogs/Last.fm vendor keys (those live
// in the Worker). So the backfill API calls happen IN THE WORKER; this box driver
// just PACES it — one small, bounded batch per tick via the `fluncle` CLI. The
// Worker carries the reliability state (per-finding cooldown/done columns) and the
// Retry-After backoff, so this driver stays dumb: drive a bounded `--limit` of each
// source, ship the summary, and let the next tick resume from the durable state.
// Pure HTTP driving, zero LLM tokens.
//
// The loop, idempotent by construction (the Worker skips already-done + cooling-down
// findings server-side), fast no-op once the catalogue is drained:
//
//   1. `fluncle admin backfills discogs         --limit <N> --json`  → one paced batch.
//   2. `fluncle admin backfills lastfm          --limit <N> --json`  → one paced batch.
//   3. `fluncle admin backfills apple-music     --limit <N> --json`  → one paced batch.
//   4. `fluncle admin backfills apple-catalogue --limit <M> --json`  → one batched pass.
//   5. `fluncle admin backfills beatport        --limit <B> --json`  → one paced batch.
//   6. `fluncle admin backfills discogs-facts   --limit <F> --json`  → one paced batch.
//
// The apple-music leg is a NO-OP until the Worker's MusicKit secrets are provisioned
// (the summary carries `configured: false`), exactly like the lastfm leg is a no-op
// without a session key — so this driver drives all four unconditionally and the
// server decides what actually runs.
//
// LEG 4 IS THE CATALOGUE SIBLING OF LEG 3, AND IT RUNS LAST ON PURPOSE. Both Apple
// legs draw on ONE shared call meter + auth breaker in the Worker, so the order IS
// the priority: the certified findings drain first, and whatever budget survives goes
// to the catalogue. It carries its own larger limit because its oracle is BATCHED
// (≤25 ISRCs per underlying request, versus one paced request per finding on leg 3).
//
// LEG 5 IS INDEPENDENT OF THE APPLE PAIR and runs last simply because it is newest. It shares
// nothing with legs 3-4 — no Apple meter, no Apple breaker — and paces on the Worker's Firecrawl
// limiter plus its own small `--limit`. One rendered scrape per finding is the slowest call in this
// sweep, so its default limit is the smallest here (10): ~85 certified findings drain in a handful
// of ticks, and the reliability cooldown keeps a drained archive quiet afterwards. It is a NO-OP
// until the Worker's Firecrawl key is provisioned (`configured: false`), like leg 3 without its
// MusicKit secrets.
//
// LEG 6 IS THE FACTS SIBLING OF LEG 1 and shares its vendor budget, which is exactly why it runs
// LAST: leg 1's release-ID resolves are the ones a finding's public `sameAs` depends on, so they get
// first call on the Discogs rate window and this leg drains whatever survives. It is ALBUM-grained
// (ten findings off one record cost one lookup), self-draining (an album leaves the worklist the
// moment it is ruled `resolved` or `none`), and cursorless. It is a NO-OP without the Worker's
// Discogs token (`configured: false`).
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config — a small bounded batch per source per tick so one tick stays well
// inside both the Worker request budget and the cron's 120s timeout. The Worker
// clamps each request to a 3-finding server pass AND stops the run (signalling the
// CLI to stop looping the cursor) the moment the vendor rate-limit circuit breaker
// trips — so a throttled tick bails after one short pass instead of grinding the
// cursor back into the same 429 wall for 300s+ (the timeout that errored this cron
// every tick). With that bail in place, 3 = exactly one server pass per source
// (~36s worst case for Discogs: ~10 paced ~1.1s lookups per unresolved finding),
// leaving wide headroom under the 120s timeout. The 30-minute cadence (see
// backfill-sweep.sh) lets the per-minute vendor budget recover between ticks; the
// reliability cooldown keeps a drained catalogue quiet.
// ---------------------------------------------------------------------------

const BATCH_LIMIT = Number(process.env.FLUNCLE_BACKFILL_LIMIT ?? "3");

// The CATALOGUE Apple leg gets its own, much larger limit: its oracle is BATCHED, so 100
// rows cost ceil(100/25) = 4 underlying requests plus at most 10 paced album-facts calls —
// ~14 meter ticks against the Worker's 18-per-minute Apple budget, and one server pass
// (100 is exactly the server's own per-pass ceiling, and also the CLI's `--limit` max).
// Matching the two means the CLI's drain loop is satisfied by that single pass instead of
// re-requesting a cursor it does not have; a pass that comes back short (duplicate ISRCs
// dedupe, the reliability gate) may cost ONE cheap follow-up pass, which the shared meter
// bounds. 65k catalogue rows drain at ~100/tick × 48 ticks/day without ever starving leg 3.
const CATALOGUE_BATCH_LIMIT = Number(process.env.FLUNCLE_BACKFILL_CATALOGUE_LIMIT ?? "100");

// The Beatport leg's own limit, the smallest in this sweep: each finding costs one RENDERED page
// scrape (Beatport is Cloudflare-walled, so the read goes through Firecrawl), which is far slower
// than an API call. 10 per 30-minute tick drains the certified archive comfortably while leaving
// the Firecrawl budget to the artist/bio sweeps that share it.
const BEATPORT_BATCH_LIMIT = Number(process.env.FLUNCLE_BACKFILL_BEATPORT_LIMIT ?? "10");

// The Discogs-FACTS leg's own limit. Each album costs one paced (~1.1s) Discogs release lookup, and
// the leg shares its rate window with leg 1, so 10 per 30-minute tick reads a record's catalogue
// number without ever crowding out the release-ID resolves the public `sameAs` depends on. The
// worklist is album-grained and terminal in both directions, so it drains to a fast no-op and stays
// there — a record does not grow a second catalogue number.
const DISCOGS_FACTS_BATCH_LIMIT = Number(process.env.FLUNCLE_BACKFILL_DISCOGS_FACTS_LIMIT ?? "10");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[backfill-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from each backfill summary.
// ---------------------------------------------------------------------------

type DiscogsSummary = {
  ok?: boolean;
  // True when the resolver's Discogs OR MusicBrainz leg hit its circuit breaker.
  rateLimited?: boolean;
  rateLimitedBy?: "discogs" | "musicbrainz" | null;
  resolvedCount?: number;
  skippedCount?: number;
  unresolvedCount?: number;
};

type LastfmSummary = {
  failedCount?: number;
  lovedCount?: number;
  ok?: boolean;
  rateLimited?: boolean;
  skippedCount?: number;
};

type AppleMusicSummary = {
  // False when the Worker's MusicKit secrets are unset — the leg was a no-op this tick.
  configured?: boolean;
  failedCount?: number;
  ok?: boolean;
  rateLimited?: boolean;
  resolvedCount?: number;
  skippedCount?: number;
  unresolvedCount?: number;
};

type AppleCatalogueSummary = {
  // Album rows given their second-authority facts (label/upc/artwork) this pass.
  albumFactsWritten?: number;
  // True when the pass STOPPED on the shared Apple auth breaker or a spent call budget —
  // distinct from a 429 (`rateLimited`) and from a drained worklist. Recorded so a tick that
  // yielded to leg 3's certified drain reads as YIELDED, never as a silent "0 resolved".
  breakerTripped?: boolean;
  // False when the Worker's MusicKit secrets are unset — the leg was a no-op this tick.
  configured?: boolean;
  failedCount?: number;
  ok?: boolean;
  rateLimited?: boolean;
  resolvedCount?: number;
  // No `skippedCount`: the catalogue worklist is a reliability-gated anti-join, so a
  // cooling-down row never enters the pass to be reported as skipped.
  unresolvedCount?: number;
};

type BeatportSummary = {
  // False when the Worker's Firecrawl key is unset — the leg was a no-op this tick.
  configured?: boolean;
  // Findings whose scrape errored (nothing learned; they back off and retry). Distinct from
  // `unresolvedCount`, which is a concluded "Beatport does not carry this recording".
  failedCount?: number;
  ok?: boolean;
  resolvedCount?: number;
  skippedCount?: number;
  unresolvedCount?: number;
};

type DiscogsFactsSummary = {
  // False when the Worker's Discogs token is unset — the leg was a no-op this tick.
  configured?: boolean;
  // Albums whose release lookup errored (nothing learned; they back off and retry). Distinct from
  // `noneCount`, which is a concluded "this release carries no catalogue number".
  failedCount?: number;
  noneCount?: number;
  ok?: boolean;
  rateLimited?: boolean;
  resolvedCount?: number;
};

// ---------------------------------------------------------------------------
// Shell helper — synchronous, fail-loud where it matters.
// ---------------------------------------------------------------------------

export function fluncleJson<T>(args: string[]): T {
  const result = spawnSync(FLUNCLE_BIN, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`failed to spawn ${FLUNCLE_BIN}: ${result.error.message}`);
  }

  const code = result.status ?? 1;
  const stdout = result.stdout ?? "";

  // Parse-first: a sweep command with per-item failures exits 1 but still prints
  // its full JSON summary (`ok: false` + the counts). That partial summary must be
  // RECORDED, not discarded as a crash — the loved/failed counts both survive. A
  // non-zero exit only throws when stdout carries no parseable JSON (a true
  // spawn/crash failure) or when the JSON is the CLI's own error payload (a failed
  // command, not a partial batch).
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    if (code !== 0) {
      throw new Error(`fluncle ${args.join(" ")} exited ${code}: ${(result.stderr ?? "").trim()}`);
    }

    throw new Error(`fluncle ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
  }

  if (code !== 0 && isCliErrorPayload(parsed)) {
    throw new Error(`fluncle ${args.join(" ")} failed (${parsed.code}): ${parsed.message}`);
  }

  return parsed as T;
}

// The CLI's own failure payload (`{ code, message, ok: false }` — validation, auth,
// or network errors). Distinguishable from a sweep summary, which never carries a
// `code`/`message` pair and keeps its per-source counts alongside `ok`.
function isCliErrorPayload(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

// ---------------------------------------------------------------------------
// The tick — drive one bounded batch of each source, in order. A failure of one
// source must not abort the next; each leg is independently best-effort, and the
// ORDER is the priority (certified findings before the catalogue on the shared
// Apple meter). Returns the summary; the entrypoint prints it.
// ---------------------------------------------------------------------------

export function runBackfillSweep() {
  const summary = {
    "apple-catalogue": {
      albumFacts: 0,
      breakerTripped: false,
      configured: false,
      error: null as string | null,
      failed: 0,
      resolved: 0,
      throttled: false,
      unresolved: 0,
    },
    "apple-music": {
      configured: false,
      error: null as string | null,
      failed: 0,
      resolved: 0,
      skipped: 0,
      throttled: false,
      unresolved: 0,
    },
    beatport: {
      configured: false,
      error: null as string | null,
      failed: 0,
      resolved: 0,
      skipped: 0,
      unresolved: 0,
    },
    checked: 0,
    discogs: {
      error: null as string | null,
      resolved: 0,
      skipped: 0,
      throttled: false,
      unresolved: 0,
    },
    "discogs-facts": {
      configured: false,
      error: null as string | null,
      failed: 0,
      none: 0,
      resolved: 0,
      throttled: false,
    },
    errors: 0,
    failed: 0,
    lastfm: { error: null as string | null, failed: 0, loved: 0, skipped: 0, throttled: false },
    musicbrainz: { throttled: false },
    ok: true,
    produced: 0,
  };

  const limit = ["--limit", String(BATCH_LIMIT)];

  try {
    const discogs = fluncleJson<DiscogsSummary>(["admin", "backfills", "discogs", ...limit]);
    summary.discogs.resolved = discogs.resolvedCount ?? 0;
    summary.discogs.unresolved = discogs.unresolvedCount ?? 0;
    summary.discogs.skipped = discogs.skippedCount ?? 0;
    summary.checked += summary.discogs.resolved + summary.discogs.unresolved;
    summary.produced += summary.discogs.resolved;
    summary.discogs.throttled = discogs.rateLimited === true && discogs.rateLimitedBy === "discogs";
    summary.musicbrainz.throttled =
      discogs.rateLimited === true && discogs.rateLimitedBy === "musicbrainz";

    if (discogs.ok === false) {
      summary.ok = false;
      log("discogs backfill reported a failed pass");
    }
  } catch (error) {
    summary.ok = false;
    summary.errors += 1;
    summary.discogs.error = error instanceof Error ? error.message : String(error);
    log(`discogs backfill failed: ${summary.discogs.error}`);
  }

  try {
    const lastfm = fluncleJson<LastfmSummary>(["admin", "backfills", "lastfm", ...limit]);
    summary.lastfm.loved = lastfm.lovedCount ?? 0;
    summary.lastfm.failed = lastfm.failedCount ?? 0;
    summary.lastfm.skipped = lastfm.skippedCount ?? 0;
    summary.lastfm.throttled = lastfm.rateLimited ?? false;
    summary.checked += summary.lastfm.loved + summary.lastfm.failed;
    summary.produced += summary.lastfm.loved;
    summary.failed += summary.lastfm.failed;

    if (lastfm.ok === false) {
      summary.ok = false;
      // A partial-failure batch (`ok: false`, exit 1): the counts above are the
      // honest summary — some loved, some failed — distinct from the catch below,
      // which is the whole source erroring with no batch summary at all.
      log(`lastfm backfill partial: ${summary.lastfm.failed} item(s) failed this tick`);
    }
  } catch (error) {
    summary.ok = false;
    summary.errors += 1;
    summary.lastfm.error = error instanceof Error ? error.message : String(error);
    log(`lastfm backfill failed: ${summary.lastfm.error}`);
  }

  try {
    const apple = fluncleJson<AppleMusicSummary>(["admin", "backfills", "apple-music", ...limit]);
    summary["apple-music"].configured = apple.configured ?? false;
    summary["apple-music"].resolved = apple.resolvedCount ?? 0;
    summary["apple-music"].unresolved = apple.unresolvedCount ?? 0;
    summary["apple-music"].failed = apple.failedCount ?? 0;
    summary["apple-music"].skipped = apple.skippedCount ?? 0;
    summary["apple-music"].throttled = apple.rateLimited ?? false;
    summary.checked +=
      summary["apple-music"].resolved +
      summary["apple-music"].unresolved +
      summary["apple-music"].failed;
    summary.produced += summary["apple-music"].resolved;
    summary.failed += summary["apple-music"].failed;

    if (apple.ok === false) {
      summary.ok = false;
      // A partial-failure batch (`ok: false`, exit 1): the counts above are the honest
      // summary — some resolved, some failed — distinct from the catch below.
      log(
        `apple-music backfill partial: ${summary["apple-music"].failed} item(s) failed this tick`,
      );
    }
  } catch (error) {
    summary.ok = false;
    summary.errors += 1;
    summary["apple-music"].error = error instanceof Error ? error.message : String(error);
    log(`apple-music backfill failed: ${summary["apple-music"].error}`);
  }

  // The CATALOGUE Apple leg, last: leg 3's certified rows get first call on the shared
  // Apple meter, and this drains whatever budget survives (RFC dnb-identity-graph U1.3).
  try {
    const catalogue = fluncleJson<AppleCatalogueSummary>([
      "admin",
      "backfills",
      "apple-catalogue",
      "--limit",
      String(CATALOGUE_BATCH_LIMIT),
    ]);
    summary["apple-catalogue"].configured = catalogue.configured ?? false;
    summary["apple-catalogue"].resolved = catalogue.resolvedCount ?? 0;
    summary["apple-catalogue"].unresolved = catalogue.unresolvedCount ?? 0;
    summary["apple-catalogue"].failed = catalogue.failedCount ?? 0;
    summary["apple-catalogue"].albumFacts = catalogue.albumFactsWritten ?? 0;
    summary["apple-catalogue"].throttled = catalogue.rateLimited ?? false;
    summary["apple-catalogue"].breakerTripped = catalogue.breakerTripped ?? false;
    summary.checked +=
      summary["apple-catalogue"].resolved +
      summary["apple-catalogue"].unresolved +
      summary["apple-catalogue"].failed;
    summary.produced += summary["apple-catalogue"].resolved;
    summary.failed += summary["apple-catalogue"].failed;

    if (catalogue.ok === false) {
      summary.ok = false;
      // A partial-failure batch (`ok: false`, exit 1): the counts above are the honest
      // summary — some resolved, some failed — distinct from the catch below.
      log(
        `apple-catalogue backfill partial: ${summary["apple-catalogue"].failed} row(s) failed this tick`,
      );
    }

    if (summary["apple-catalogue"].breakerTripped) {
      log("apple-catalogue backfill yielded: the shared Apple breaker/budget stopped the pass");
    }
  } catch (error) {
    summary.ok = false;
    summary.errors += 1;
    summary["apple-catalogue"].error = error instanceof Error ? error.message : String(error);
    log(`apple-catalogue backfill failed: ${summary["apple-catalogue"].error}`);
  }

  // The Beatport store leg. Independent of the Apple pair (its own vendor, its own limiter), so its
  // placement last carries no priority meaning — and its failure, like every other leg's, is
  // contained here so it can never abort the sweep.
  try {
    const beatport = fluncleJson<BeatportSummary>([
      "admin",
      "backfills",
      "beatport",
      "--limit",
      String(BEATPORT_BATCH_LIMIT),
    ]);
    summary.beatport.configured = beatport.configured ?? false;
    summary.beatport.resolved = beatport.resolvedCount ?? 0;
    summary.beatport.unresolved = beatport.unresolvedCount ?? 0;
    summary.beatport.failed = beatport.failedCount ?? 0;
    summary.beatport.skipped = beatport.skippedCount ?? 0;
    summary.checked +=
      summary.beatport.resolved + summary.beatport.unresolved + summary.beatport.failed;
    summary.produced += summary.beatport.resolved;
    summary.failed += summary.beatport.failed;

    if (beatport.ok === false) {
      // A partial-failure batch (`ok: false`, exit 1): the counts above are the honest summary —
      // some resolved, some failed — distinct from the catch below.
      log(`beatport backfill partial: ${summary.beatport.failed} finding(s) failed this tick`);
    }
  } catch (error) {
    // Preserve the pre-existing exit/`ok` behaviour for this slice: this bug is reported
    // separately. The canonical run-failure counter still exposes the failed whole leg.
    summary.errors += 1;
    summary.beatport.error = error instanceof Error ? error.message : String(error);
    log(`beatport backfill failed: ${summary.beatport.error}`);
  }

  // The Discogs release-FACTS leg, last: it shares leg 1's Discogs rate window, and leg 1's
  // release-ID resolves (which a finding's public `sameAs` depends on) get first call on it. Its
  // failure is contained here like every other leg's, so it can never abort the sweep.
  try {
    const facts = fluncleJson<DiscogsFactsSummary>([
      "admin",
      "backfills",
      "discogs-facts",
      "--limit",
      String(DISCOGS_FACTS_BATCH_LIMIT),
    ]);
    summary["discogs-facts"].configured = facts.configured ?? false;
    summary["discogs-facts"].resolved = facts.resolvedCount ?? 0;
    summary["discogs-facts"].none = facts.noneCount ?? 0;
    summary["discogs-facts"].failed = facts.failedCount ?? 0;
    summary["discogs-facts"].throttled = facts.rateLimited ?? false;

    if (facts.ok === false) {
      // A partial-failure batch (`ok: false`, exit 1): the counts above are the honest summary —
      // some read, some failed — distinct from the catch below, which is the whole leg erroring.
      log(`discogs-facts backfill partial: ${summary["discogs-facts"].failed} album(s) failed`);
    }
  } catch (error) {
    summary["discogs-facts"].error = error instanceof Error ? error.message : String(error);
    log(`discogs-facts backfill failed: ${summary["discogs-facts"].error}`);
  }

  return summary;
}

export function backfillSweepExitCode(summary: { ok: boolean }): 0 | 1 {
  return summary.ok ? 0 : 1;
}

// The cron runs this file directly; the guard keeps importing `fluncleJson` and
// `runBackfillSweep` for the tests (backfill-sweep.test.ts) side-effect free.
if (import.meta.main) {
  const summary = runBackfillSweep();
  console.log(JSON.stringify(summary));
  process.exitCode = backfillSweepExitCode(summary);
}
