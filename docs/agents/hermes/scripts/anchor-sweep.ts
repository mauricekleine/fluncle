#!/usr/bin/env bun
// anchor-sweep.ts — the bun orchestrator behind the CATALOGUE SPOTIFY-ANCHOR cron (`fluncle-anchor`),
// scheduled by a rave-02 HOST systemd timer (../anchor-timer/).
//
// WHY THIS EXISTS. A catalogue track (a `tracks` row with no `findings` row) is resolved from
// MusicBrainz, so it may land with no Spotify presence — the nullable `spotify_uri`/`spotify_url`.
// Filling that anchor used to run IN THE WORKER against the official dev-mode Spotify app, and at
// catalogue scale it starved under sustained 429s (the official app must stay for user-facing paths
// — adds, publish, the Frontier playlist mints). So ALL catalogue anchor-filling moved onto THIS
// box sweep, driven by an Apify actor that has its own Spotify budget. See docs/catalogue-crawler.md
// § the anchor.
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
//   (b) RUN the Apify actor once per chunk of queries (`run-sync-get-dataset-items`), each query a
//       keyword search returning up to `searchKeywordLimit` candidates.
//   (c) GROUP the actor's flat result array by `target` (the query string) and map each to a
//       candidate ({ spotifyTrackId, isrc, durationMs, title, artists, albumImageUrl }).
//   (d) POST each row's candidates to `anchor_track`. The WORKER re-runs the full verification
//       (the box's own match is NEVER trusted) and, on a hit, writes the anchor. Every attempt
//       stamps the row's re-ask backoff, so a missed row is not re-asked (or re-billed) for weeks.
//
// THE BOX DEPENDS ON NO NEW CLI COMMAND. The baked `fluncle` CLI is a PINNED release, so this
// sweep calls the oRPC HTTP endpoints DIRECTLY with the agent token (the verify-captures.ts
// precedent), never a `fluncle admin …` subcommand that a pin might not carry.
//
// COST. ~$0.005 per Apify result item → ~$0.015/row at searchKeywordLimit 3. The default pace
// (15 rows/tick, hourly) is ~360 rows/day ≈ $5-6/day while the backlog drains. Pause = stop the
// timer. Attended burn = `--limit N`. Full cost math: ../anchor-timer/README.md.
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

export type AnchorVerdict = { anchored: boolean; verifiedBy: "isrc" | "search" | null };

/** One tick's honest tally — the JSON summary line. */
export type AnchorSummary = {
  anchoredByIsrc: number;
  anchoredBySearch: number;
  error: null | string;
  /** Rows POSTed that verified nothing (a clean miss — stamped, backed off). */
  missed: number;
  ok: boolean;
  /** Rows this tick could not settle (a bad worklist row, or an anchor POST that threw). */
  skipped: number;
};

/** The injected effects — so the tick's mapping + routing are provable with stubs (no network). */
export type AnchorDeps = {
  fetchQueue: (limit: number) => Promise<AnchorWorkItem[]>;
  log: (message: string) => void;
  report: (trackId: string, candidates: AnchorCandidatePayload[]) => Promise<AnchorVerdict>;
  runActor: (queries: string[]) => Promise<ApifyResultItem[]>;
};

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
    anchoredBySearch: 0,
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

  // Run the actor in bounded chunks so a big `--limit` burn never one-shots a giant run-sync call.
  for (const batch of chunk(rows, APIFY_QUERY_CHUNK)) {
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
    report: reportAnchor,
    runActor: runApifyActor,
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
