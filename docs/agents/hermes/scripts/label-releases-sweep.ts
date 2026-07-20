#!/usr/bin/env bun
// label-releases-sweep.ts — the bun orchestrator behind the FRESHNESS TAP cron (`fluncle-label-releases`,
// D8), scheduled by a rave-02 HOST systemd timer (../label-releases-timer/).
//
// WHY THIS EXISTS. MusicBrainz WALKS the graph (the crawler), but its editorial database lags a
// release by ~2 weeks, so a Friday drop is invisible on /fresh until the volunteers enter it. Spotify
// has it day one. So this taps FRESHNESS: for each ENABLED seed label it finds the last-two-weeks
// releases and mints METADATA-ONLY catalogue rows with their real (day-one) dates.
//
// WHY THE APIFY ACTOR (the 2026-07-20 move — the anchor-sweep precedent). The first cut ran the
// Spotify reads IN THE WORKER against the official dev-mode Spotify app — the same app the user paths
// (adds, publish, the Frontier mints) depend on. That app is rate-limited to death at its tier
// (batch endpoints 403, search `limit` ≤ 10, sustained 429s), and its budget is shared with the user
// writes. So the tap moved OFF that budget onto the Apify actor `musicae~spotify-extended-scraper` —
// the SAME actor + box-runs-actor / Worker-verifies split the catalogue ANCHOR already uses. The box
// holds the Apify token; the Worker holds no Spotify identity on this path.
//
// LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (label-releases-sweep.sh) the host
// timer docker-execs — see that file's header for the wire-up and ../label-releases-timer/README.md.
//
// ── THE LOOP, per tick ───────────────────────────────────────────────────────────────────────
//   (a) FETCH the due seed labels from the Worker with the box's AGENT token
//       (`GET /api/admin/backfill/label-releases/work`). Each row is `{ slug, name }`.
//   (b) For each label RUN the Apify actor once (`albums:["label:\"<name>\" tag:new"]`), returning
//       ONE dataset item PER fresh album — its metadata NESTED in `item.albums[0]`, its `tracks[]`
//       (+ ISRCs) + `artists[]` at the item's top level.
//   (c) MAP each item to a candidate ({ albumId, albumName, albumLabel, albumCopyright, releaseDate,
//       artists, tracks }), reading the album fields from the nested `item.albums[0]`. An item with no
//       album metadata OR no release_date is DROPPED (a null release_date row can never show on
//       /fresh). `albumLabel`/`albumCopyright` come back NULL in this mode (measured live 2026-07-20)
//       — the Worker gates on artist-grounding there.
//   (d) POST the label's candidates to `backfill_label_releases`. The WORKER re-runs the FULL gate
//       (artist-grounding + label attribution + dedupe — the box's match is NEVER trusted) and mints
//       the survivors. Completing a label stamps its re-probe cadence, so an empty result is not
//       re-asked (or re-billed) that window.
//
// THE BOX DEPENDS ON NO NEW CLI COMMAND. The baked `fluncle` CLI is a PINNED release, so this sweep
// calls the oRPC HTTP endpoints DIRECTLY with the agent token (the anchor-sweep precedent), never a
// `fluncle admin …` subcommand a pin might not carry.
//
// COST. ~$0.005 per Apify result item → a handful of fresh albums per due label per day. With ~30
// enabled labels re-probed daily, tens of result items → a few cents a day. Pause = stop the timer.
// Attended burn = `--limit N`. Full cost math: ../label-releases-timer/README.md.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

// ── Config (env; the shared ~/.fluncle-secrets.env supplies the secrets on the box) ──

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

// The Apify token — referenced by ENV NAME only; the concrete op:// path lives in the private
// companion + the timer README's activation section. Already on the box for the anchor sweep — the
// tap reuses that SAME secret, so activating it needs no new provisioning.
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN ?? "";

// The working actor (the anchor sweep's, verified live 2026-07-20). Overridable for a pinned/forked id.
const APIFY_ACTOR = process.env.FLUNCLE_LABEL_RELEASES_ACTOR ?? "musicae~spotify-extended-scraper";

/** Enabled seed labels probed per tick — small on purpose (each is a billed Apify album search).
 *  `--limit` overrides it for an attended backlog burn. */
const BATCH = Number(process.env.FLUNCLE_LABEL_RELEASES_LABELS ?? "5");

/** The actor's per-label fresh-album cap. `tag:new` spans two weeks; even a busy seed label ships
 *  fewer fresh records than this, so 10 is plenty (more candidates = more spend). */
const SEARCH_KEYWORD_LIMIT = Number(process.env.FLUNCLE_LABEL_RELEASES_KEYWORD_LIMIT ?? "10");

const log = (message: string) => console.error(`[label-releases-sweep] ${message}`);

// ── Types ────────────────────────────────────────────────────────────────────

/** One row of the freshness-tap worklist (the identity the actor query + POST-back read). */
export type LabelWorkItem = { name?: string; slug?: string };

/** One credited artist on an actor result album. */
type ApifyArtist = { artist_id?: string; artist_name?: string };

/** One inline track on an actor result album. */
type ApifyTrack = {
  track_duration_ms?: number;
  track_id?: string;
  track_isrc?: string;
  track_name?: string;
  track_uri?: string;
  track_url?: string;
};

/** The album metadata — the actor NESTS it in `item.albums[0]`, NOT at the item's top level. */
type ApifyAlbum = {
  album_copyright?: null | string;
  album_id?: string;
  album_label?: null | string;
  album_name?: string;
  album_release_date?: string;
  album_total_tracks?: number;
  album_upc?: string;
};

/**
 * One item in the actor's `albums`-search result array = ONE album. Its metadata is NESTED under
 * `albums[0]` (verified live), while its `tracks[]` + `artists[]` sit at the item's top level. The
 * earlier flat shape read `item.album_*` and always got `undefined` — the null-release_date bug that
 * minted /fresh-invisible rows. `target`/`result`/`type`/`mode` are the actor's per-item metadata.
 */
export type ApifyAlbumItem = {
  albums?: ApifyAlbum[];
  artists?: ApifyArtist[];
  error?: null | string;
  mode?: string;
  result?: string;
  success?: boolean;
  target?: string;
  tracks?: ApifyTrack[];
  type?: string;
};

/** One credited artist in the verify+mint request body. */
export type LabelReleaseArtistPayload = { id?: null | string; name: string };

/** One track in the verify+mint request body. */
export type LabelReleaseTrackPayload = {
  durationMs?: null | number;
  isrc?: null | string;
  spotifyTrackId: string;
  title: string;
  uri?: null | string;
  url?: null | string;
};

/** One candidate album in the `backfill_label_releases` request body. */
export type LabelReleaseAlbumPayload = {
  albumCopyright?: null | string;
  albumId?: null | string;
  albumLabel?: null | string;
  albumName?: null | string;
  artists: LabelReleaseArtistPayload[];
  releaseDate?: null | string;
  tracks: LabelReleaseTrackPayload[];
};

/** The verify+mint op's per-label verdict (only the fields this sweep tallies). */
export type MintVerdict = {
  albumsMatched: number;
  albumsSeen: number;
  found: boolean;
  newRows: number;
  skippedKnown: number;
  skippedUnattributed: number;
  skippedUngrounded: number;
};

/** One tick's honest tally — the JSON summary line. */
export type LabelReleasesSummary = {
  albumsMatched: number;
  albumsSeen: number;
  error: null | string;
  /** Labels whose Apify actor run THREW this tick (retried next tick — nothing stamped). */
  failedLabels: number;
  /** Enabled seed labels the actor ran + POSTed for this tick. */
  labelsProbed: number;
  newRows: number;
  ok: boolean;
  /** Rows this tick could not settle (a bad worklist row, or a POST that threw). */
  skipped: number;
  skippedKnown: number;
  skippedUnattributed: number;
  skippedUngrounded: number;
};

/** The injected effects — so the tick's mapping + routing are provable with stubs (no network). */
export type LabelReleasesDeps = {
  fetchQueue: (limit: number) => Promise<LabelWorkItem[]>;
  log: (message: string) => void;
  report: (labelSlug: string, candidates: LabelReleaseAlbumPayload[]) => Promise<MintVerdict>;
  runActor: (labelName: string) => Promise<ApifyAlbumItem[]>;
};

// ── Pure mappers (unit-tested against the real actor payload shape) ────────────

/**
 * Map one actor result album to a candidate, or null when it is unusable. The album metadata is read
 * from the NESTED `item.albums[0]` (the tracks + artists stay at item level). A candidate is dropped
 * when it has no album metadata OR no `album_release_date`: a catalogue row with a null release_date
 * can never surface on /fresh (the /fresh window filters on it), so minting it is a silent no-op.
 */
export function albumItemToCandidate(item: ApifyAlbumItem): LabelReleaseAlbumPayload | null {
  if (item.success === false) {
    return null;
  }

  const albumMeta = item.albums?.[0];

  // No album metadata, or no day-one date → the row could never show on /fresh, so never mint it.
  if (!albumMeta || !albumMeta.album_release_date) {
    return null;
  }

  const tracks: LabelReleaseTrackPayload[] = (item.tracks ?? [])
    .map((track): LabelReleaseTrackPayload | null => {
      const spotifyTrackId = track.track_id?.trim();

      if (!spotifyTrackId || !track.track_name) {
        return null;
      }

      return {
        durationMs: typeof track.track_duration_ms === "number" ? track.track_duration_ms : null,
        isrc: track.track_isrc ?? null,
        spotifyTrackId,
        title: track.track_name,
        uri: track.track_uri ?? null,
        url: track.track_url ?? null,
      };
    })
    .filter((track): track is LabelReleaseTrackPayload => track !== null);

  if (tracks.length === 0) {
    return null;
  }

  return {
    albumCopyright: albumMeta.album_copyright ?? null,
    albumId: albumMeta.album_id ?? null,
    albumLabel: albumMeta.album_label ?? null,
    albumName: albumMeta.album_name ?? null,
    artists: (item.artists ?? [])
      .filter((artist): artist is ApifyArtist & { artist_name: string } =>
        Boolean(artist.artist_name),
      )
      .map((artist) => ({ id: artist.artist_id ?? null, name: artist.artist_name })),
    releaseDate: albumMeta.album_release_date,
    tracks,
  };
}

/** Map the actor's result array to candidate albums, dropping the trackless ones. */
export function mapAlbumItems(items: ApifyAlbumItem[]): LabelReleaseAlbumPayload[] {
  return items
    .map((item) => albumItemToCandidate(item))
    .filter((candidate): candidate is LabelReleaseAlbumPayload => candidate !== null);
}

/** Parse `--limit N` (an attended backlog burn); default is the tick's `FLUNCLE_LABEL_RELEASES_LABELS`. */
export function parseLimitArg(argv: string[], fallback: number): number {
  const index = argv.indexOf("--limit");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

// ── One tick, with injected effects ──────────────────────────────────────────

export async function runLabelReleasesTick(
  limit: number,
  deps: LabelReleasesDeps,
): Promise<LabelReleasesSummary> {
  const summary: LabelReleasesSummary = {
    albumsMatched: 0,
    albumsSeen: 0,
    error: null,
    failedLabels: 0,
    labelsProbed: 0,
    newRows: 0,
    ok: true,
    skipped: 0,
    skippedKnown: 0,
    skippedUnattributed: 0,
    skippedUngrounded: 0,
  };

  let queue: LabelWorkItem[];

  try {
    queue = await deps.fetchQueue(limit);
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.message : String(error);

    return summary;
  }

  // Only rows carrying both a slug and a name are actionable; the rest are counted skipped.
  const rows = queue.filter(
    (row): row is { name: string; slug: string } => Boolean(row.slug) && Boolean(row.name),
  );
  summary.skipped += queue.length - rows.length;

  for (const row of rows) {
    let candidates: LabelReleaseAlbumPayload[];

    try {
      candidates = mapAlbumItems(await deps.runActor(row.name));
    } catch (error) {
      // A label's actor run failing is a per-label miss, not a tick abort — the next tick retries
      // (the label is unstamped, so it is still due). Report it but keep draining the rest.
      deps.log(
        `actor run failed for ${row.slug}: ${error instanceof Error ? error.message : String(error)}`,
      );
      summary.failedLabels += 1;
      summary.ok = false;
      summary.error = error instanceof Error ? error.message : String(error);
      continue;
    }

    try {
      const verdict = await deps.report(row.slug, candidates);
      summary.labelsProbed += 1;
      summary.albumsSeen += verdict.albumsSeen;
      summary.albumsMatched += verdict.albumsMatched;
      summary.newRows += verdict.newRows;
      summary.skippedKnown += verdict.skippedKnown;
      summary.skippedUngrounded += verdict.skippedUngrounded;
      summary.skippedUnattributed += verdict.skippedUnattributed;
    } catch (error) {
      // One label's POST failing never aborts the tick (the capture-sweep discipline).
      deps.log(`${row.slug}: ${error instanceof Error ? error.message : String(error)}`);
      summary.skipped += 1;
    }
  }

  return summary;
}

// ── The real (box-side) effects ───────────────────────────────────────────────

async function fetchLabelQueue(limit: number): Promise<LabelWorkItem[]> {
  const url = `${API_BASE_URL}/api/admin/backfill/label-releases/work?limit=${limit}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(
      `label-releases queue read failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as { labels?: LabelWorkItem[] };

  return Array.isArray(body.labels) ? body.labels : [];
}

async function runApifyActor(labelName: string): Promise<ApifyAlbumItem[]> {
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}`;
  const res = await fetch(url, {
    body: JSON.stringify({
      albums: [`label:"${labelName}" tag:new`],
      searchKeywordLimit: SEARCH_KEYWORD_LIMIT,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    // Apify run-sync waits for the run to finish; one album search is well within this, with headroom.
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    throw new Error(`apify actor run failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  const body = (await res.json()) as unknown;

  return Array.isArray(body) ? (body as ApifyAlbumItem[]) : [];
}

async function reportLabelReleases(
  labelSlug: string,
  candidates: LabelReleaseAlbumPayload[],
): Promise<MintVerdict> {
  const res = await fetch(`${API_BASE_URL}/api/admin/backfill/label-releases`, {
    body: JSON.stringify({ candidates, labelSlug }),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(
      `backfill_label_releases ${labelSlug} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as MintVerdict;

  return {
    albumsMatched: Number(body.albumsMatched ?? 0),
    albumsSeen: Number(body.albumsSeen ?? 0),
    found: Boolean(body.found),
    newRows: Number(body.newRows ?? 0),
    skippedKnown: Number(body.skippedKnown ?? 0),
    skippedUnattributed: Number(body.skippedUnattributed ?? 0),
    skippedUngrounded: Number(body.skippedUngrounded ?? 0),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

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
    Number.isFinite(BATCH) && BATCH > 0 ? Math.trunc(BATCH) : 5,
  );

  const summary = await runLabelReleasesTick(limit, {
    fetchQueue: fetchLabelQueue,
    log,
    report: reportLabelReleases,
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
    log(`label-releases-sweep failed: ${message}`);
    console.log(JSON.stringify({ error: message, ok: false, reason: "label_releases_failed" }));
    process.exit(1);
  });
}
