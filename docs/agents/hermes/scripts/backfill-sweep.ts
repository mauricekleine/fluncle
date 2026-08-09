#!/usr/bin/env bun
// backfill-sweep.ts — the bun orchestrator behind the `--no-agent` catalogue-backfill
// cron (`fluncle-backfill`).
//
// LIVE. Version-controlled source; the repo is canonical and the box is a
// deploy target (fluncle-hermes-operator skill). Invoked by the bash wrapper
// (backfill-sweep.sh) the cron runner execs on a schedule — see that file's header
// for the `host-timer` wire-up and ../cron/README.md for the cron model.
//
// THE DISCOGS SPLIT. The box performs only paced Discogs reads from its own egress. Bounded release
// evidence returns through the existing agent operations; the Worker re-reads identity, applies the
// existing gate, and owns every reliability/facts write. All non-Discogs legs retain their existing
// CLI path. Pure HTTP driving, zero LLM tokens.
//
// The loop, idempotent by construction (the Worker skips already-done + cooling-down
// findings server-side), fast no-op once the catalogue is drained:
//
//   1. Discogs ids: Worker prepare → box fetch → Worker verdict.
//   2. `fluncle admin backfills lastfm          --limit <N> --json`  → one paced batch.
//   3. `fluncle admin backfills apple-music     --limit <N> --json`  → one paced batch.
//   4. `fluncle admin backfills apple-catalogue --limit <M> --json`  → one batched pass.
//   5. `fluncle admin backfills beatport        --limit <B> --json`  → one paced batch.
//   6. Discogs facts: Worker prepare → box fetch → Worker verdict.
//   7. `fluncle admin backfills deezer          --limit <D> --json`  → one paced batch.
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
// moment it is ruled `resolved` or `none`), and cursorless. Both legs share one box-side pacer.
//
// LEG 5 NOW CARRIES A SECOND TIER. Beatport drains the certified feed first and, on the pass that
// exhausts it, scrapes a small capped batch of CATALOGUE rows — the forward-accretion half, so a
// newly crawled row gets its buy link without waiting for a manual campaign. That tier's cap is a
// WORKER var (FLUNCLE_BACKFILL_BEATPORT_CATALOGUE_LIMIT, default 5), not a flag here: each row is a
// Firecrawl credit, so the cap lives where the key and the spend are, and the box's PINNED CLI
// cannot fail on a flag it does not know. Its counts land under `beatport.catalogue*`.
//
// LEG 7 IS THE DEEZER SIBLING OF LEG 5's NEW TIER, and it runs last because it is newest. It is
// KEYLESS — `GET /track/isrc:<ISRC>` needs no token — so unlike legs 3-6 it has no `configured`
// flag to report and is live the moment it deploys. Its limit is the second-smallest here for a
// different reason than Beatport's: Deezer's quota is PER-IP and the Worker egresses from
// Cloudflare's SHARED edge, so a big burst earns a throttle for rows that would otherwise resolve.
// A throttle is recorded as `throttled` and stamps nothing at all — the rows stay eligible.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

import {
  createDiscogsFetcher,
  type DiscogsBatchResult,
  type DiscogsFactsCandidate,
  type DiscogsFactsWork,
  type DiscogsReleaseCandidate,
  type DiscogsReleaseWork,
  postDiscogsAgentOperation,
} from "./discogs-fetch";

// ---------------------------------------------------------------------------
// Config — each Discogs prepare response is bounded to three findings and the helper serializes
// every search/detail request behind one 1.1s gate. The 30-minute timer is the outer loop; durable
// Worker state makes a drained catalogue cheap and resumable.
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

// The Deezer leg's own limit. Deezer's tokenless quota is PER-IP and the Worker egresses from
// Cloudflare's shared edge IPs, where that budget is spent by the whole platform rather than by
// Fluncle — measured: the same search code recovered 0 of 5,133 rows from the edge and answered
// 25/25 from the box's own IP. So this stays modest on purpose: 25 keyless reads a tick accretes
// steadily across the catalogue without bursting into a quota answer, and the server clamps to the
// same number anyway. A throttled pass ends early and the next tick resumes with a fresh window.
const DEEZER_BATCH_LIMIT = Number(process.env.FLUNCLE_BACKFILL_DEEZER_LIMIT ?? "25");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[backfill-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from each backfill summary.
// ---------------------------------------------------------------------------

type DiscogsSummary = {
  discogsWork?: DiscogsReleaseWork[];
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
  // The CATALOGUE tier's counts, reported apart from the certified ones because that tier is the
  // metered spend (one Firecrawl credit per row against a five-figure catalogue).
  catalogueFailedCount?: number;
  catalogueResolvedCount?: number;
  catalogueUnresolvedCount?: number;
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

type DeezerSummary = {
  // Rows whose lookup errored in transport (nothing learned; they retry until a failure cap).
  failedCount?: number;
  ok?: boolean;
  // True when Deezer answered its quota limit — the pass stopped and stamped NOTHING. Recorded so a
  // throttled tick reads as THROTTLED rather than as a silent "0 resolved".
  rateLimited?: boolean;
  resolvedCount?: number;
  // ISRCs Deezer concluded it carries no recording for — a stamped, honest negative.
  unresolvedCount?: number;
  // Rows Deezer picked a track for whose duration did not vouch — stamped nothing, still eligible.
  unvouchableCount?: number;
  // No `configured`: the endpoint is keyless, so there is nothing to provision and the leg is live
  // from its first tick. No `skippedCount` either — the worklist is a ledger-gated read, so a
  // concluded row never enters the pass to be reported as skipped.
};

type DiscogsFactsSummary = {
  // False when neither the legacy Worker fetch nor the box-fetch split is configured.
  configured?: boolean;
  discogsWork?: DiscogsFactsWork[];
  // Albums whose release lookup errored (nothing learned; they back off and retry). Distinct from
  // `noneCount`, which is a concluded "this release carries no catalogue number".
  failedCount?: number;
  noneCount?: number;
  ok?: boolean;
  rateLimited?: boolean;
  resolvedCount?: number;
};

type BackfillEnvironment = {
  DISCOGS_USER_TOKEN?: string;
  FLUNCLE_API_BASE_URL?: string;
  FLUNCLE_API_TOKEN?: string;
};

type BackfillDiscogsFetcher = {
  fetchFactsCandidates: (
    work: DiscogsFactsWork[],
  ) => Promise<DiscogsBatchResult<DiscogsFactsCandidate>>;
  fetchReleaseCandidates: (
    work: DiscogsReleaseWork[],
  ) => Promise<DiscogsBatchResult<DiscogsReleaseCandidate>>;
};

export type BackfillSweepEffects = {
  createFetcher?: (
    token: string,
    options: { fetch?: typeof globalThis.fetch },
  ) => BackfillDiscogsFetcher;
  env?: BackfillEnvironment;
  fetch?: typeof globalThis.fetch;
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

export async function runBackfillSweep(effects: BackfillSweepEffects = {}) {
  const env = effects.env ?? process.env;
  const apiToken = env.FLUNCLE_API_TOKEN ?? "";
  const discogsToken = env.DISCOGS_USER_TOKEN ?? "";
  const agentBaseUrl = env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
  let discogsFetcher: BackfillDiscogsFetcher | undefined;
  const getDiscogsFetcher = (): BackfillDiscogsFetcher => {
    discogsFetcher ??= (effects.createFetcher ?? createDiscogsFetcher)(discogsToken, {
      fetch: effects.fetch,
    });
    return discogsFetcher;
  };
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
      catalogueFailed: 0,
      catalogueResolved: 0,
      catalogueUnresolved: 0,
      configured: false,
      error: null as string | null,
      failed: 0,
      resolved: 0,
      skipped: 0,
      unresolved: 0,
    },
    checked: 0,
    deezer: {
      error: null as string | null,
      failed: 0,
      resolved: 0,
      throttled: false,
      unresolved: 0,
      unvouchable: 0,
    },
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
    const addDiscogsPass = (pass: DiscogsSummary): void => {
      summary.discogs.resolved += pass.resolvedCount ?? 0;
      summary.discogs.unresolved += pass.unresolvedCount ?? 0;
      summary.discogs.skipped += pass.skippedCount ?? 0;
      summary.discogs.throttled ||= pass.rateLimited === true && pass.rateLimitedBy === "discogs";
      summary.musicbrainz.throttled ||=
        pass.rateLimited === true && pass.rateLimitedBy === "musicbrainz";
      summary.ok &&= pass.ok !== false;
    };
    const common = {
      baseUrl: agentBaseUrl,
      fetch: effects.fetch,
      query: { boxFetch: true, limit: BATCH_LIMIT },
    };
    const prepared = await postDiscogsAgentOperation<DiscogsSummary>(
      "/admin/backfill/discogs",
      apiToken,
      common,
    );
    addDiscogsPass(prepared);
    const work = prepared.rateLimited ? [] : (prepared.discogsWork ?? []);

    if (work.length > 0) {
      const fetched = await getDiscogsFetcher().fetchReleaseCandidates(work);

      if (!fetched.ok) {
        summary.discogs.throttled = fetched.rateLimited;

        if (!fetched.rateLimited) {
          summary.ok = false;
          summary.errors += 1;
          summary.discogs.error = fetched.error;
        }
      } else {
        const decided = await postDiscogsAgentOperation<DiscogsSummary>(
          "/admin/backfill/discogs",
          apiToken,
          { ...common, body: { discogsCandidates: fetched.candidates } },
        );
        addDiscogsPass(decided);
      }
    }

    summary.checked += summary.discogs.resolved + summary.discogs.unresolved;
    summary.produced += summary.discogs.resolved;
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
    summary.beatport.catalogueResolved = beatport.catalogueResolvedCount ?? 0;
    summary.beatport.catalogueUnresolved = beatport.catalogueUnresolvedCount ?? 0;
    summary.beatport.catalogueFailed = beatport.catalogueFailedCount ?? 0;
    // The canonical counters cover BOTH tiers: a catalogue row scraped is a row checked and a link
    // won is a link produced, whichever side of the certification it sits on.
    summary.checked +=
      summary.beatport.resolved +
      summary.beatport.unresolved +
      summary.beatport.failed +
      summary.beatport.catalogueResolved +
      summary.beatport.catalogueUnresolved +
      summary.beatport.catalogueFailed;
    summary.produced += summary.beatport.resolved + summary.beatport.catalogueResolved;
    summary.failed += summary.beatport.failed + summary.beatport.catalogueFailed;

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
    const addFactsPass = (pass: DiscogsFactsSummary): void => {
      summary["discogs-facts"].configured ||= pass.configured ?? false;
      summary["discogs-facts"].resolved += pass.resolvedCount ?? 0;
      summary["discogs-facts"].none += pass.noneCount ?? 0;
      summary["discogs-facts"].failed += pass.failedCount ?? 0;
      summary["discogs-facts"].throttled ||= pass.rateLimited ?? false;
    };
    const common = {
      baseUrl: agentBaseUrl,
      fetch: effects.fetch,
      query: { boxFetch: true, limit: DISCOGS_FACTS_BATCH_LIMIT },
    };
    const prepared = await postDiscogsAgentOperation<DiscogsFactsSummary>(
      "/admin/backfill/discogs-facts",
      apiToken,
      common,
    );
    addFactsPass(prepared);
    const work = prepared.rateLimited ? [] : (prepared.discogsWork ?? []);

    if (work.length > 0) {
      const fetched = await getDiscogsFetcher().fetchFactsCandidates(work);

      if (!fetched.ok) {
        summary["discogs-facts"].throttled = fetched.rateLimited;

        if (!fetched.rateLimited) {
          summary.ok = false;
          summary.errors += 1;
          summary["discogs-facts"].error = fetched.error;
        }
      } else {
        const decided = await postDiscogsAgentOperation<DiscogsFactsSummary>(
          "/admin/backfill/discogs-facts",
          apiToken,
          { ...common, body: { discogsCandidates: fetched.candidates } },
        );
        addFactsPass(decided);
      }
    }
  } catch (error) {
    summary.ok = false;
    summary.errors += 1;
    summary["discogs-facts"].error = error instanceof Error ? error.message : String(error);
    log(`discogs-facts backfill failed: ${summary["discogs-facts"].error}`);
  }

  // The Deezer forward-accretion leg, last because it is newest. It shares no budget with any leg
  // above — its own vendor, no key at all — and its failure is contained here like every other
  // leg's, so it can never abort the sweep.
  try {
    const deezer = fluncleJson<DeezerSummary>([
      "admin",
      "backfills",
      "deezer",
      "--limit",
      String(DEEZER_BATCH_LIMIT),
    ]);
    summary.deezer.resolved = deezer.resolvedCount ?? 0;
    summary.deezer.unresolved = deezer.unresolvedCount ?? 0;
    summary.deezer.unvouchable = deezer.unvouchableCount ?? 0;
    summary.deezer.failed = deezer.failedCount ?? 0;
    summary.deezer.throttled = deezer.rateLimited ?? false;
    // `unvouchable` is deliberately OUT of `checked`: Deezer answered, but nothing was concluded and
    // nothing was stamped, so counting it as a checked row would overstate the tick's real work.
    summary.checked += summary.deezer.resolved + summary.deezer.unresolved + summary.deezer.failed;
    summary.produced += summary.deezer.resolved;
    summary.failed += summary.deezer.failed;

    if (deezer.ok === false) {
      // A partial-failure batch (`ok: false`, exit 1): the counts above are the honest summary —
      // some resolved, some failed — distinct from the catch below, which is the whole leg erroring.
      log(`deezer backfill partial: ${summary.deezer.failed} row(s) failed this tick`);
    }

    if (summary.deezer.throttled) {
      log("deezer backfill yielded: Deezer answered its quota limit, nothing was stamped");
    }
  } catch (error) {
    summary.errors += 1;
    summary.deezer.error = error instanceof Error ? error.message : String(error);
    log(`deezer backfill failed: ${summary.deezer.error}`);
  }

  return summary;
}

export function backfillSweepExitCode(summary: { ok: boolean }): 0 | 1 {
  return summary.ok ? 0 : 1;
}

// The cron runs this file directly; the guard keeps importing `fluncleJson` and
// `runBackfillSweep` for the tests (backfill-sweep.test.ts) side-effect free.
if (import.meta.main) {
  const summary = await runBackfillSweep();
  console.log(JSON.stringify(summary));
  process.exitCode = backfillSweepExitCode(summary);
}
