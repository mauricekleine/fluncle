#!/usr/bin/env bun
// anchor-sweep.ts — the bun orchestrator behind the CATALOGUE SPOTIFY-ANCHOR cron (`fluncle-anchor`),
// scheduled by a rave-02 HOST systemd timer (../anchor-timer/).
//
// WHY THIS EXISTS. A catalogue track (a `tracks` row with no `findings` row) is resolved from
// MusicBrainz, so it may land with no Spotify presence — the nullable `spotify_uri`/`spotify_url`.
// Filling that anchor used to run IN THE WORKER against the official dev-mode Spotify app, and at
// catalogue scale it starved under sustained 429s (the official app must stay for user-facing paths
// — adds, publish, the Frontier playlist mints). So ALL catalogue anchor-filling moved onto THIS
// box sweep. See docs/catalogue-crawler.md § the anchor.
//
// THE RESOLVER WATERFALL (slices 1-2). Apify used to be the SOLE candidate source, so an Apify outage
// stopped anchoring dead. This sweep runs a waterfall per row, all resolved through ONE `resolve_anchor`
// call the box makes FIRST: the FREE ListenBrainz rung, then — when the server's dark flag
// `anchor_spotify_search_enabled` is on (slice 2) — the free Spotify SEARCH rungs (exact ISRC, then
// fuzzy), and the metered Apify search only as the LAST resort. Any earlier hit spends no Apify money,
// and when Apify is down the free rungs still anchor their share (graceful degradation). The Spotify
// rungs share the official app with user-facing mints, so the box PACES them under a 60/min ceiling
// (`spotifySearchPaceMs`); when the flag is off they never run and the sweep is exactly slice 1.
//
// LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (anchor-sweep.sh) the host timer
// docker-execs — see that file's header for the wire-up and ../anchor-timer/README.md for the
// operator runbook (and the cost math).
//
// ── THE LOOP, per tick ───────────────────────────────────────────────────────────────────────
//   (a) FETCH the anchor worklist from the Worker with the box's AGENT token
//       (`GET /api/admin/tracks/work?kind=anchor`). Each row carries a ready-made `anchorQuery`
//       (the row's artists + title) so this driver stays dumb and never builds the query.
//   (b) FREE RUNG first: POST each row's trackId to `resolve_anchor`. The WORKER resolves a
//       ListenBrainz candidate (recording MBID → Spotify ids, no auth) + one by-id Spotify metadata
//       read, verifies it against the SAME gate, and on a hit writes the anchor for free. A hit here
//       means this row NEVER reaches the paid Apify rung.
//   (c) APIFY FALLBACK, over the free-rung MISSES only: RUN the Apify actor once per chunk of
//       queries (`run-sync-get-dataset-items`), GROUP its flat result array by `target` (the query),
//       map each to a candidate, and POST each row's candidates to `anchor_track`.
//   The WORKER re-runs the full verification on BOTH rungs (no source's match is EVER trusted) and,
//   on a hit, writes the anchor. Every FULL attempt stamps the row's re-ask backoff (a free-rung
//   miss does NOT — it leaves the Apify rung its turn), so a missed row is not re-billed for weeks.
//
// THE BOX DEPENDS ON NO NEW CLI COMMAND. The baked `fluncle` CLI is a PINNED release, so this
// sweep calls the oRPC HTTP endpoints DIRECTLY with the agent token (the verify-captures.ts
// precedent), never a `fluncle admin …` subcommand that a pin might not carry. No new secret and no
// new timer: the free rung rides the same agent token, base URL, and host timer as the Apify rung.
//
// COST. ~$0.005 per Apify result item → ~$0.015/row at searchKeywordLimit 3 — but ONLY on the rows
// the free rung misses. ListenBrainz is free, so the ~30% of rows it resolves cost nothing (bar one
// cheap by-id Spotify read each, no search), cutting the Apify bill by roughly a third. Pause = stop
// the timer. Attended burn = `--limit N`. Full cost math: ../anchor-timer/README.md.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

// ── Config (env; the shared ~/.fluncle-secrets.env supplies the secrets on the box) ──

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

// The Apify token — the ONLY new secret this sweep needs. Referenced by ENV NAME only; the
// concrete op:// path lives in the private companion + the timer README's activation section.
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN ?? "";

// The working actor (verified live 2026-07-18). Overridable for a pinned/forked actor id.
const APIFY_ACTOR = process.env.FLUNCLE_ANCHOR_ACTOR ?? "musicae~spotify-extended-scraper";

/** Rows per tick. Small on purpose — each is a billed Apify search (~$0.015). `--limit` overrides it. */
const BATCH = Number(process.env.FLUNCLE_ANCHOR_BATCH ?? "15");

/** Queries per Apify run-sync call — chunked so a big `--limit` burn never one-shots a giant run. */
const APIFY_QUERY_CHUNK = Number(process.env.FLUNCLE_ANCHOR_APIFY_CHUNK ?? "15");

/** The actor's per-query candidate cap — the pilot-verified value; more candidates = more spend. */
const SEARCH_KEYWORD_LIMIT = Number(process.env.FLUNCLE_ANCHOR_KEYWORD_LIMIT ?? "3");

const log = (message: string) => console.error(`[anchor-sweep] ${message}`);

// ── Types ────────────────────────────────────────────────────────────────────

/** One row of the anchor worklist (only the fields this sweep consumes). */
export type AnchorWorkItem = {
  anchorQuery?: string;
  trackId?: string;
};

/** One credited artist on an Apify candidate. */
type ApifyArtist = { artist_id?: string; artist_name?: string };

/** One item in the actor's flat result array — one (query, rank) pair. */
export type ApifyResultItem = {
  albums?: { album_image?: string }[];
  artists?: ApifyArtist[];
  error?: null | string;
  success?: boolean;
  target?: string;
  tracks?: {
    track_duration_ms?: number;
    track_id?: string;
    track_image?: string;
    track_isrc?: string;
    track_name?: string;
    track_uri?: string;
    track_url?: string;
  }[];
};

/** One candidate in the `anchor_track` request body. */
export type AnchorCandidatePayload = {
  albumImageUrl?: null | string;
  artists: { id?: null | string; name: string }[];
  durationMs?: null | number;
  isrc?: null | string;
  spotifyTrackId: string;
  title: string;
};

export type AnchorVerdict = {
  anchored: boolean;
  /** Which free rung anchored (`resolve_anchor` only) — drives the per-rung tally. Null on the Apify path. */
  source?: "listenbrainz" | "spotify-isrc" | "spotify-search" | null;
  /** True iff `resolve_anchor` issued a Spotify SEARCH this call — the box's pacer signal (slice 2). */
  spotifySearchDone?: boolean;
  verifiedBy: "isrc" | "search" | null;
};

/** One tick's honest tally — the JSON summary line. */
export type AnchorSummary = {
  /** Rows anchored by the Apify FALLBACK via the exact-ISRC gate. */
  anchoredByIsrc: number;
  /** Rows anchored by the FREE ListenBrainz rung — the waterfall's cheapest win (no Apify spent). */
  anchoredByListenbrainz: number;
  /** Rows anchored by the Apify FALLBACK via the verified-search gate. */
  anchoredBySearch: number;
  /** Rows anchored by the DARK Spotify ISRC-search rung (slice 2 — free of Apify, flag-gated). */
  anchoredBySpotifyIsrc: number;
  /** Rows anchored by the DARK Spotify fuzzy-search rung (slice 2 — free of Apify, flag-gated). */
  anchoredBySpotifySearch: number;
  error: null | string;
  /** Rows that verified nothing on ANY rung (a clean full miss — stamped, backed off). */
  missed: number;
  ok: boolean;
  /** Rows this tick could not settle (a bad worklist row, or an anchor POST that threw). */
  skipped: number;
};

/** The injected effects — so the tick's mapping + routing are provable with stubs (no network). */
export type AnchorDeps = {
  fetchQueue: (limit: number) => Promise<AnchorWorkItem[]>;
  log: (message: string) => void;
  /** A monotonic clock (ms). Injected so the Spotify-search pacer is deterministic in tests. */
  now: () => number;
  report: (trackId: string, candidates: AnchorCandidatePayload[]) => Promise<AnchorVerdict>;
  /** The FREE first rung — the server resolves + verifies ListenBrainz + (dark) Spotify search for this row. */
  resolveFree: (trackId: string) => Promise<AnchorVerdict>;
  runActor: (queries: string[]) => Promise<ApifyResultItem[]>;
  /** Pause for `ms`. Injected so the Spotify-search pacer can be driven by a fake clock in tests. */
  sleep: (ms: number) => Promise<void>;
};

/**
 * THE 60/min SPOTIFY-SEARCH CEILING (slice 2). The dark Spotify search rungs share the ONE official
 * app that also serves user-facing mints/publish — the app that starved under 429s at catalogue scale
 * — so the box paces them well under Spotify's limit. `resolve_anchor` issues at most TWO searches per
 * row (exact ISRC, then fuzzy), so holding consecutive search-bearing calls ≥ 2s apart caps the rate
 * at ≤ 2 searches / 2s = 60/min. The existing Spotify 429/Retry-After backoff (apps/web spotify.ts) is
 * the second half: if we ever do approach the wall, anchor search backs off and yields the token, so a
 * mint always has headroom — the pacer keeps us far from the wall, the backoff guarantees priority.
 * The pacer only bites when a call actually SEARCHED (`spotifySearchDone`), so a flag-OFF sweep (LB +
 * Apify only) runs at full speed.
 */
export const SPOTIFY_SEARCH_MIN_INTERVAL_MS = 2000;

/**
 * How long to wait before the next `resolve_anchor` call so consecutive Spotify-search-bearing calls
 * stay ≥ `minIntervalMs` apart (start-to-start). `lastSearchStartMs` is null until the first call that
 * issued a Spotify search, so a sweep that never searches never waits. Pure, so the ceiling is proven
 * without real timers.
 */
export function spotifySearchPaceMs(
  lastSearchStartMs: null | number,
  nowMs: number,
  minIntervalMs: number = SPOTIFY_SEARCH_MIN_INTERVAL_MS,
): number {
  if (lastSearchStartMs === null) {
    return 0;
  }

  const elapsed = nowMs - lastSearchStartMs;

  return elapsed >= minIntervalMs ? 0 : minIntervalMs - elapsed;
}

// ── Pure mappers (unit-tested against the real pilot payloads) ────────────────

/** Split an array into fixed-size chunks. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    return [items];
  }

  const out: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }

  return out;
}

/** Map one Apify result item to a candidate, or null when it carries no usable Spotify track. */
export function itemToCandidate(item: ApifyResultItem): AnchorCandidatePayload | null {
  const track = item.tracks?.[0];
  const spotifyTrackId = track?.track_id?.trim();

  if (item.success === false || !track || !spotifyTrackId) {
    return null;
  }

  return {
    albumImageUrl: track.track_image ?? item.albums?.[0]?.album_image ?? null,
    artists: (item.artists ?? [])
      .filter((artist): artist is ApifyArtist & { artist_name: string } =>
        Boolean(artist.artist_name),
      )
      .map((artist) => ({ id: artist.artist_id ?? null, name: artist.artist_name })),
    durationMs: typeof track.track_duration_ms === "number" ? track.track_duration_ms : null,
    isrc: track.track_isrc ?? null,
    spotifyTrackId,
    title: track.track_name ?? "",
  };
}

/**
 * Group the actor's flat result array by `target` (the query string) and map each item to a
 * candidate. A row's candidates are then `byTarget.get(row.anchorQuery)`.
 */
export function groupCandidatesByTarget(
  items: ApifyResultItem[],
): Map<string, AnchorCandidatePayload[]> {
  const byTarget = new Map<string, AnchorCandidatePayload[]>();

  for (const item of items) {
    const target = item.target;

    if (typeof target !== "string") {
      continue;
    }

    const candidate = itemToCandidate(item);

    if (!candidate) {
      continue;
    }

    const bucket = byTarget.get(target);

    if (bucket) {
      bucket.push(candidate);
    } else {
      byTarget.set(target, [candidate]);
    }
  }

  return byTarget;
}

// ── One tick, with injected effects ──────────────────────────────────────────

export async function runAnchorTick(limit: number, deps: AnchorDeps): Promise<AnchorSummary> {
  const summary: AnchorSummary = {
    anchoredByIsrc: 0,
    anchoredByListenbrainz: 0,
    anchoredBySearch: 0,
    anchoredBySpotifyIsrc: 0,
    anchoredBySpotifySearch: 0,
    error: null,
    missed: 0,
    ok: true,
    skipped: 0,
  };

  let queue: AnchorWorkItem[];

  try {
    queue = await deps.fetchQueue(limit);
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.message : String(error);

    return summary;
  }

  // Only rows with both a trackId and a query are actionable; the rest are counted skipped.
  const rows = queue.filter(
    (row): row is { anchorQuery: string; trackId: string } =>
      Boolean(row.trackId) && Boolean(row.anchorQuery),
  );
  summary.skipped += queue.length - rows.length;

  if (rows.length === 0) {
    return summary;
  }

  // ── RUNG 1-3: THE FREE (non-Apify) RUNGS, per row, via ONE `resolve_anchor` call: the FREE
  // ListenBrainz rung, then the DARK Spotify search rungs (slice 2, server-gated behind the default-off
  // flag). A hit here anchors WITHOUT Apify money and this row NEVER reaches the metered Apify rung
  // below. Only the misses fall through to `apifyRows`. The free path failing (a Worker error, a
  // network blip) is treated exactly like a miss — the row still gets its paid turn — so a flaky free
  // path can never STARVE anchoring, only fail to save money on that row.
  //
  // PACING: when a call actually issued a Spotify search (`spotifySearchDone`), the next call waits so
  // consecutive search-bearing calls stay ≥ 2s apart — the 60/min ceiling on the shared official app
  // (see `spotifySearchPaceMs`). A flag-OFF sweep never searches, so it never waits.
  const apifyRows: { anchorQuery: string; trackId: string }[] = [];
  let lastSearchStartMs: null | number = null;

  for (const row of rows) {
    const waitMs = spotifySearchPaceMs(lastSearchStartMs, deps.now());

    if (waitMs > 0) {
      await deps.sleep(waitMs);
    }

    const startMs = deps.now();

    try {
      const verdict = await deps.resolveFree(row.trackId);

      if (verdict.spotifySearchDone) {
        lastSearchStartMs = startMs;
      }

      if (verdict.anchored) {
        if (verdict.source === "spotify-isrc") {
          summary.anchoredBySpotifyIsrc += 1;
        } else if (verdict.source === "spotify-search") {
          summary.anchoredBySpotifySearch += 1;
        } else {
          // "listenbrainz" (or a pre-slice-2 server that omits `source`) — the free ListenBrainz rung.
          summary.anchoredByListenbrainz += 1;
        }

        continue;
      }
    } catch (error) {
      deps.log(
        `free rung ${row.trackId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    apifyRows.push(row);
  }

  // Every row the free rung anchored is done; only the misses cost Apify money.
  if (apifyRows.length === 0) {
    return summary;
  }

  // ── RUNG 2: THE APIFY FALLBACK, over the free-rung misses only. Run the actor in bounded chunks so
  // a big `--limit` burn never one-shots a giant run-sync call.
  for (const batch of chunk(apifyRows, APIFY_QUERY_CHUNK)) {
    let byTarget: Map<string, AnchorCandidatePayload[]>;

    try {
      byTarget = groupCandidatesByTarget(await deps.runActor(batch.map((row) => row.anchorQuery)));
    } catch (error) {
      // A whole actor run failing is a chunk-level miss, not a tick abort — the next tick retries
      // (the worklist is derived + the un-attempted rows carry no stamp, so nothing is lost).
      deps.log(`actor run failed: ${error instanceof Error ? error.message : String(error)}`);
      summary.ok = false;
      summary.error = error instanceof Error ? error.message : String(error);
      summary.skipped += batch.length;
      continue;
    }

    for (const row of batch) {
      const candidates = byTarget.get(row.anchorQuery) ?? [];

      try {
        const verdict = await deps.report(row.trackId, candidates);

        if (verdict.anchored && verdict.verifiedBy === "isrc") {
          summary.anchoredByIsrc += 1;
        } else if (verdict.anchored) {
          summary.anchoredBySearch += 1;
        } else {
          summary.missed += 1;
        }
      } catch (error) {
        // One row's anchor POST failing never aborts the tick (the capture-sweep discipline).
        deps.log(`${row.trackId}: ${error instanceof Error ? error.message : String(error)}`);
        summary.skipped += 1;
      }
    }
  }

  return summary;
}

// ── The real (box-side) effects ───────────────────────────────────────────────

async function fetchAnchorQueue(limit: number): Promise<AnchorWorkItem[]> {
  const url = `${API_BASE_URL}/api/admin/tracks/work?kind=anchor&limit=${limit}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(
      `anchor queue read failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as { tracks?: AnchorWorkItem[] };

  return Array.isArray(body.tracks) ? body.tracks : [];
}

async function runApifyActor(queries: string[]): Promise<ApifyResultItem[]> {
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}`;
  const res = await fetch(url, {
    body: JSON.stringify({
      searchKeywordLimit: SEARCH_KEYWORD_LIMIT,
      tracks: queries,
      tracksIncludeAlbum: true,
      tracksIncludeArtists: true,
      tracksIncludeAudioFeatures: false,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    // Apify run-sync waits for the run to finish; a chunk of 15 keyword searches is well within
    // this, with headroom for a slow run.
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    throw new Error(`apify actor run failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  const body = (await res.json()) as unknown;

  return Array.isArray(body) ? (body as ApifyResultItem[]) : [];
}

async function reportAnchor(
  trackId: string,
  candidates: AnchorCandidatePayload[],
): Promise<AnchorVerdict> {
  const res = await fetch(`${API_BASE_URL}/api/admin/catalogue/anchor`, {
    body: JSON.stringify({ candidates, trackId }),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(
      `anchor_track ${trackId} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as AnchorVerdict;

  return { anchored: Boolean(body.anchored), verifiedBy: body.verifiedBy ?? null };
}

/**
 * The FREE (non-Apify) rungs — the SERVER resolves this row from ListenBrainz (recording MBID →
 * Spotify ids, no auth) + one by-id read and, when the dark flag is on, from the Spotify SEARCH rungs
 * (slice 2), verifies each against the same gate, and on a hit writes the anchor. The box supplies no
 * candidates; it just hands over the trackId. Only when ALL of these miss does the caller spend the
 * metered Apify search. `source` tells which rung anchored (for the tally); `spotifySearchDone` tells
 * whether a Spotify search was issued (for the pacer).
 */
async function resolveAnchorFree(trackId: string): Promise<AnchorVerdict> {
  const res = await fetch(`${API_BASE_URL}/api/admin/catalogue/anchor/resolve`, {
    body: JSON.stringify({ trackId }),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(
      `resolve_anchor ${trackId} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as AnchorVerdict;

  return {
    anchored: Boolean(body.anchored),
    source: body.source ?? null,
    spotifySearchDone: Boolean(body.spotifySearchDone),
    verifiedBy: body.verifiedBy ?? null,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

/** Parse `--limit N` (an attended backlog burn); default is the hourly `FLUNCLE_ANCHOR_BATCH`. */
export function parseLimitArg(argv: string[], fallback: number): number {
  const index = argv.indexOf("--limit");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

async function main(): Promise<void> {
  const started = Date.now();

  if (!API_TOKEN) {
    console.log(JSON.stringify({ ok: false, reason: "missing_api_token" }));
    process.exit(1);
  }

  if (!APIFY_API_TOKEN) {
    console.log(JSON.stringify({ ok: false, reason: "missing_apify_token" }));
    process.exit(1);
  }

  const limit = parseLimitArg(
    process.argv.slice(2),
    Number.isFinite(BATCH) && BATCH > 0 ? Math.trunc(BATCH) : 15,
  );

  const summary = await runAnchorTick(limit, {
    fetchQueue: fetchAnchorQueue,
    log,
    now: () => Date.now(),
    report: reportAnchor,
    resolveFree: resolveAnchorFree,
    runActor: runApifyActor,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  console.log(JSON.stringify({ ...summary, elapsedMs: Date.now() - started }));

  if (!summary.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`anchor-sweep failed: ${message}`);
    console.log(JSON.stringify({ error: message, ok: false, reason: "anchor_failed" }));
    process.exit(1);
  });
}
