// Worker-safe (HTTP-only) enrichment from Deezer, keyed by ISRC for determinism.
//
// Deezer's track-by-ISRC endpoint returns the album id and a 30s preview; the
// album endpoint then exposes the record label that Spotify's track API omits.
// Best-effort: any failure resolves to an empty result so it never blocks a
// publish. The backfill can retry later.
//
// ── WHAT WE KEEP (operator ruling 2026-07-30) ────────────────────────────────────────────────────
// All three of this file's Deezer reads have always come back carrying Deezer's own TRACK ID, and
// all three used to drop it on the floor. They keep it now (`tracks.deezer_track_id`, schema.ts), so
// `/identity` can serve `https://www.deezer.com/track/<id>` and Deezer joins the covered set. This
// costs no extra request anywhere: the id was already in the response that was already being read.
// Every one of them is GATED — an id is only ever handed back off an answer that passed a match
// check, because an unverified id becomes a wrong link on a public page under a recording's name.
//
// ── THE ISRC-RECOVERY RUNG (`searchDeezerCandidates`, verified live 2026-07-22) ──────────────────
// Deezer is a FREE, no-auth ISRC ORACLE. Its `GET /search/track?q=…` returns each hit already
// carrying the recording's real `isrc`, its `duration`, its `title`, and its billed `artist.name` —
// so ONE search request recovers the ISRC our own row lacks (the crawler's ISRC comes from
// MusicBrainz, whose ISRC coverage of underground DnB is sparse, so ~60% of catalogue rows arrive
// ISRC-less even though the track genuinely HAS one). No second by-id read is needed: the search hit
// is the whole answer. Deezer's search is FUZZY (it will happily return a remix for the original), so
// the CALLER re-verifies every hit against the row to the SAME bar the anchor gate uses — the folded
// artist-set + base-title identity (`matchKey`) AND a duration within the ratified ±3s window — before
// it trusts an ISRC (`anchor.ts`, the recovery step). A wrong ISRC seeds a wrong exact-ISRC anchor, so
// a miss is always preferred to a guess: this client just fetches and normalizes; anchor.ts rules.
//
// ── WHO RUNS THE SEARCH: THE BOX, NOT THE EDGE ───────────────────────────────────────────────────
// Deezer's public search takes no token, so its quota is purely PER-IP — and the Worker egresses from
// Cloudflare's SHARED edge IPs, where that quota is spent by the whole platform rather than by Fluncle.
// Measured in production: the recovery rung recovered 0 ISRCs out of 5,133 ISRC-less rows over 3 days,
// while the SAME code answered 25/25 clean from the rave-02 box on its own dedicated IP. So the anchor
// sweep now runs the FETCH on the box (docs/agents/hermes/scripts/anchor-sweep.ts) and POSTs the hits
// to `resolve_anchor`; the VERIFICATION and the ISRC write never moved — they are still `anchor.ts`'s,
// exactly as they were, which is the Apify precedent (the box fetches, the Worker rules).
//
// This client stays, and stays the ONE spelling of the query ({@link deezerSearchQuery}, which the
// anchor worklist hands the box so the sweep never invents one). It still serves the two callers that
// have no box in front of them: the certify path's ISRC pre-flight (`publish.ts`) and any
// `resolve_anchor` call that supplies no box-fetched hits.

import { DEEZER_CANDIDATE_LIMIT } from "@fluncle/contracts/orpc";

import { logEvent } from "./log";
import { canonicalizeSearchTitle } from "./track-match";

type DeezerTrack = {
  album?: { id?: number };
  /** Deezer bills a track's length in SECONDS — the guard below promotes it to ms to compare. */
  duration?: number;
  error?: unknown;
  id?: number;
  preview?: string;
  title?: string;
};

type DeezerAlbum = {
  error?: unknown;
  label?: string;
};

export type DeezerEnrichment = {
  /**
   * Deezer's own track id for this ISRC — kept ONLY when the returned track's duration confirms it
   * (see {@link enrichFromDeezer}). Absent when the caller supplied no duration to check against or
   * the check failed: `/track/isrc:` PICKS a recording, with a measured ~7% silent title mismatch,
   * and an unconfirmed id would become a link on a public page. Nothing is the honest answer.
   */
  deezerTrackId?: string;
  label?: string;
  previewUrl?: string;
};

type DeezerSearchTrack = {
  artist?: { name?: string };
  duration?: number;
  id?: number;
  isrc?: string;
  title?: string;
};

type DeezerSearchResult = {
  data?: DeezerSearchTrack[];
  error?: unknown;
};

/**
 * One Deezer search hit, normalized to exactly the fields the anchor recovery step verifies against
 * a catalogue row. `artistName` is Deezer's BILLED string (e.g. `"Fred V & Grafix"`) — the caller
 * folds it into an artist SET via `matchKey`, so a combined billing splits correctly. `durationMs`
 * is Deezer's seconds promoted to ms so the ±3s anchor window compares in the same unit. `isrc` is
 * guaranteed non-blank (a hit without one is dropped).
 */
export type DeezerIsrcCandidate = {
  artistName: string;
  /**
   * Deezer's own track id for the hit, when it carried one. OPTIONAL on purpose: it is NOT part of
   * the ISRC-recovery gate, and a hit without it still recovers its ISRC exactly as before. It rides
   * along so the verified hit's id can be kept (`tracks.deezer_track_id`) instead of thrown away,
   * and so a box running a build that predates the field degrades to "no id kept", never to a
   * refused recovery.
   */
  deezerTrackId?: string;
  durationMs: number;
  isrc: string;
  title: string;
};

/** The identifiable User-Agent Fluncle presents across the web — one honest identity. */
const DEEZER_USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

/**
 * Per-request wall-clock deadline. Deezer answers a title+artist search well under a second; anything
 * past this is a stalled socket, and a stall is just a miss (the row stays ISRC-less and falls to the
 * fuzzy anchor rung, exactly as before this rung existed). Bounded so the box sweep's per-row
 * `resolve_anchor` call can never wedge the tick.
 */
const DEEZER_TIMEOUT_MS = 10_000;

/**
 * How many search hits to consider. Deezer's fuzzy search can return a near-miss (a remix, a re-edit)
 * ahead of the exact recording, so we read a small handful and let the caller's fold+duration gate
 * pick the one that truly matches — never blindly the first.
 *
 * The number lives in the CONTRACT (`DEEZER_CANDIDATE_LIMIT`) because both ends must agree on it: it
 * is what this request asks Deezer for AND the cap `resolve_anchor` accepts back from the box, which
 * runs this same search from its own IP. One constant, so the ask and the wire cap cannot drift apart.
 */
const DEEZER_SEARCH_LIMIT = DEEZER_CANDIDATE_LIMIT;

/**
 * THE QUOTA TRAP (the reason this rung recovered NOTHING from 2026-07-22 to 2026-07-29). Deezer does
 * NOT signal a throttle with a 429, or with any non-2xx at all: it answers **HTTP 200** carrying an
 * ERROR BODY instead of a result set —
 * `{"error":{"type":"Exception","message":"Quota limit exceeded","code":4}}` — reproduced live by
 * bursting the real endpoint (120 requests: every one a 200, the 93rd onward quota errors).
 *
 * That shape walks straight past `response.ok`, parses as valid JSON, and lands on a `data` that is
 * simply absent — so a client that only asks "is `data` an array?" reads a THROTTLE as a clean MISS
 * and returns `[]`. Indistinguishable from "Deezer has never heard of this track", and silent. The
 * Worker egresses from Cloudflare's SHARED edge IPs, where Deezer's per-IP quota is saturated by the
 * whole platform rather than by Fluncle's own one-request-per-row cadence, so in production that
 * branch was taken on EVERY call while the same code recovers ~19% of ISRC-less rows off-edge.
 *
 * So the error body is now read FIRST and treated as a FAILURE, never as a miss — and a quota answer
 * is RETRIED against Deezer's short window rather than being written off. A miss stays a miss.
 */
const DEEZER_QUOTA_ERROR_CODE = 4;

/**
 * Backoff between quota retries. Deezer's quota window is a few seconds wide, so a short wait lands in
 * a FRESH window — the point is to outlast a neighbour's burst on the shared egress IP, not to grind.
 * Two retries, ≤4s added and ONLY on the throttled path: bounded well inside the box sweep's 30s
 * per-row `resolve_anchor` deadline, with the ListenBrainz and Spotify rungs still to run after it.
 */
const DEEZER_QUOTA_RETRY_DELAYS_MS = [1_200, 2_500];

/**
 * THE QUERY SPELLING — Deezer's precise field syntax (`artist:"<first artist>" track:"<title>"`), and
 * the ONE place it is written. It is NOT the `anchorQuery` the Spotify rungs ask with (that one is the
 * row's artists joined onto its title, `anchorSearchQuery` in ./anchor.ts): Deezer indexes by field,
 * and a plain free-text ask returns a different, looser result set.
 *
 * The title is canonicalized (`canonicalizeSearchTitle` in ./track-match: `rmx` → `Remix`, a redundant
 * trailing `mix` dropped — the retrieval twin of the `canonicalizeDescriptor` fold the CALLER verifies
 * with, kept in lockstep there). Deezer's index carries the canonical spelling, so a row asking in its
 * own returns nothing at all and can never recover its ISRC. The caller still verifies against the
 * row's RAW title. Quotes are stripped from both parts — they would close the field syntax's own.
 *
 * ONE owner, every rung: this is what {@link searchDeezerCandidates} sends, and what `list_track_work`
 * hands the box's anchor sweep as an ISRC-less row's ready-made `deezerQuery` (the sweep never builds
 * one). `undefined` when the row has no usable artist or title to ask with.
 */
export function deezerSearchQuery(artists: string[], title: string): string | undefined {
  const artist = artists[0]?.replaceAll('"', " ").trim();
  const canonical = canonicalizeSearchTitle(title.replaceAll('"', " ")).trim();

  if (!artist || !canonical) {
    return undefined;
  }

  return `artist:"${artist}" track:"${canonical}"`;
}

/** One attempt's outcome: candidates, or the reason there are none (so the caller can retry a throttle). */
type DeezerSearchAttempt =
  | { candidates: DeezerIsrcCandidate[]; outcome: "ok" }
  | { outcome: "quota" }
  | { outcome: "failed" };

/**
 * Recover ISRC CANDIDATES for a catalogue row from Deezer's free search — the pre-anchor ISRC-recovery
 * rung (`anchor.ts`), from WHEREVER this code is running. On the shared Cloudflare edge that is now the
 * fallback path only (see the header): the anchor sweep runs this same search from the box's own IP and
 * hands `resolve_anchor` the hits, so the Worker fetches nothing for those rows. It still runs here for
 * the certify path's ISRC pre-flight and for any `resolve_anchor` call that supplies no hits.
 *
 * Queries Deezer's precise field syntax ({@link deezerSearchQuery}) and returns each
 * hit that carries a usable `isrc` + numeric `duration` + `title` + `artist.name`, normalized to
 * {@link DeezerIsrcCandidate}. It VERIFIES NOTHING — the caller re-runs the row against the same fold +
 * ±3s duration gate the anchor uses, and trusts an ISRC only on a hard match (a wrong ISRC would seed a
 * wrong exact-ISRC anchor). Best-effort and NEVER throws: a bad artist/title, a network error, a
 * timeout, a non-2xx, an error body, or a malformed shape all resolve to `[]`.
 *
 * An empty list is a first-class "no recovery, fall to fuzzy" — but it is no longer SILENT. Every way
 * of arriving at `[]` OTHER than a genuine empty result set now logs, because the failure this client
 * shipped with was invisible precisely for want of one log line (see {@link DEEZER_QUOTA_ERROR_CODE}).
 *
 * Politeness: IDENTIFIED (the honest Fluncle User-Agent) and BOUNDED (a per-request deadline). Like the
 * sibling ListenBrainz rung it carries NO module-level pacing gate: the anchor waterfall makes exactly
 * ONE Deezer search per `resolve_anchor` request and the box sweep issues those one-at-a-time down its
 * worklist, so the request cadence — never a burst — is what keeps us under Deezer's own limit. The
 * retries exist for the SHARED egress IP, where the quota is not ours to pace.
 *
 * `retryDelaysMs` is injected for deterministic tests; production uses the calibrated backoff.
 */
export async function searchDeezerCandidates(
  input: {
    artists: string[];
    title: string;
  },
  retryDelaysMs: number[] = DEEZER_QUOTA_RETRY_DELAYS_MS,
): Promise<DeezerIsrcCandidate[]> {
  const query = deezerSearchQuery(input.artists, input.title);

  if (!query) {
    return [];
  }

  for (let attempt = 0; ; attempt += 1) {
    const result = await attemptDeezerSearch(query);

    if (result.outcome === "ok") {
      return result.candidates;
    }

    const delay = result.outcome === "quota" ? retryDelaysMs[attempt] : undefined;

    // A hard failure never retries (it is not going to un-fail), and a quota retry stops once the
    // bounded budget is spent — at which point we say so, loudly: a persistent quota on the egress IP
    // is an infrastructure fact the operator must see, not a per-row miss to shrug off.
    if (delay === undefined) {
      if (result.outcome === "quota") {
        logEvent("warn", "deezer.search-quota-exhausted", { attempts: attempt + 1, query });
      }

      return [];
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/** ONE Deezer search request, mapped to {@link DeezerSearchAttempt}. Never throws. */
async function attemptDeezerSearch(query: string): Promise<DeezerSearchAttempt> {
  let response: Response;

  try {
    response = await fetch(
      `https://api.deezer.com/search/track?q=${encodeURIComponent(query)}&limit=${DEEZER_SEARCH_LIMIT}`,
      {
        headers: { "User-Agent": DEEZER_USER_AGENT },
        signal: AbortSignal.timeout(DEEZER_TIMEOUT_MS),
      },
    );
  } catch (error) {
    // A network error OR a timeout abort — both mean this lookup yielded nothing.
    logEvent("warn", "deezer.search-threw", { error });

    return { outcome: "failed" };
  }

  if (!response.ok) {
    logEvent("warn", "deezer.search-http-error", { status: response.status });

    return { outcome: "failed" };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch (error) {
    logEvent("warn", "deezer.search-malformed-body", { error });

    return { outcome: "failed" };
  }

  // THE ERROR BODY, read BEFORE `data` — a 200 is not a result. A quota answer is transient and gets
  // its retry; any other Deezer-side exception is a hard failure for this row.
  const error = (body as DeezerSearchResult).error;

  if (error) {
    const code = (error as { code?: unknown }).code;

    if (code === DEEZER_QUOTA_ERROR_CODE) {
      return { outcome: "quota" };
    }

    logEvent("warn", "deezer.search-api-error", { error });

    return { outcome: "failed" };
  }

  const data = (body as DeezerSearchResult).data;

  if (!Array.isArray(data)) {
    logEvent("warn", "deezer.search-unexpected-shape", {});

    return { outcome: "failed" };
  }

  const candidates: DeezerIsrcCandidate[] = [];

  for (const hit of data) {
    const isrc = hit.isrc?.trim() ?? "";
    const hitTitle = hit.title?.trim() ?? "";
    const artistName = hit.artist?.name?.trim() ?? "";

    if (
      !isrc ||
      !hitTitle ||
      !artistName ||
      typeof hit.duration !== "number" ||
      hit.duration <= 0
    ) {
      continue;
    }

    candidates.push({
      artistName,
      // Kept, not required: a hit with no id is still a perfectly good ISRC recovery, so the id
      // rides along as evidence for the id-write and never as a reason to drop the hit.
      ...(typeof hit.id === "number" ? { deezerTrackId: String(hit.id) } : {}),
      durationMs: Math.round(hit.duration * 1000),
      isrc,
      title: hitTitle,
    });
  }

  return { candidates, outcome: "ok" };
}

type DeezerTrackDetail = {
  error?: unknown;
  isrc?: string;
};

// Accept a Deezer answer as "the same recording" only when its duration agrees
// with the row's within a few seconds; a wrong ISRC would seed a wrong (and
// permanent) Log ID, so a miss is better than a guess. The same window guards
// the id kept off the by-ISRC endpoint, whose pick is right about 93% of the time.
const DURATION_TOLERANCE_S = 4;

/**
 * Look up a recording's ISRC on Deezer when Spotify omits it (the track-add
 * ISRC fallback): search by artist + title, take the first
 * duration-confirmed hit, and read the ISRC from its track detail. Best-effort:
 * any failure resolves to undefined and the Log ID falls back to the Spotify id.
 *
 * RETURNS THE WHOLE HIT, not just the ISRC — the ISRC behaviour is unchanged (read `.isrc`), and
 * the rest is what the caller needs to decide whether the hit's Deezer id is worth KEEPING. This
 * function's own bar is a ±{@link DURATION_TOLERANCE_S}s duration confirm, which is the right bar
 * for an ISRC that then gets re-verified downstream by ISRC EQUALITY; a public link is a stronger
 * claim, so `publish.ts` runs the hit through the anchor's full identity fold before persisting the
 * id, and records which rung cleared. A hit whose billing or title Deezer withheld comes back with
 * those fields empty, which simply fails that fold — the ISRC still lands.
 */
export async function lookupIsrcFromDeezer(input: {
  artists: string[];
  durationMs: number;
  title: string;
}): Promise<DeezerIsrcCandidate | undefined> {
  const artist = input.artists[0]?.trim();

  if (!artist || !input.title.trim()) {
    return undefined;
  }

  try {
    const query = `artist:"${artist}" track:"${input.title.trim()}"`;
    const searchResponse = await fetch(
      `https://api.deezer.com/search/track?q=${encodeURIComponent(query)}`,
    );

    if (!searchResponse.ok) {
      return undefined;
    }

    const search = (await searchResponse.json()) as DeezerSearchResult;

    if (search.error || !Array.isArray(search.data)) {
      return undefined;
    }

    const expectedSeconds = input.durationMs / 1000;
    const match = search.data.find(
      (candidate) =>
        typeof candidate.id === "number" &&
        typeof candidate.duration === "number" &&
        Math.abs(candidate.duration - expectedSeconds) <= DURATION_TOLERANCE_S,
    );

    if (!match?.id) {
      return undefined;
    }

    const trackResponse = await fetch(`https://api.deezer.com/track/${match.id}`);

    if (!trackResponse.ok) {
      return undefined;
    }

    const detail = (await trackResponse.json()) as DeezerTrackDetail;

    if (detail.error || !detail.isrc?.trim()) {
      return undefined;
    }

    return {
      artistName: match.artist?.name?.trim() ?? "",
      deezerTrackId: String(match.id),
      durationMs: Math.round((match.duration ?? 0) * 1000),
      isrc: detail.isrc.trim(),
      title: match.title?.trim() ?? "",
    };
  } catch {
    return undefined;
  }
}

/**
 * The label + preview enrichment, keyed by ISRC — and, when the caller can vouch for it, the Deezer
 * track id that read was already standing on.
 *
 * THE ID GUARD. `/track/isrc:<isrc>` does not answer "here are the recordings under this ISRC"; it
 * PICKS one, and it picks wrong about 7% of the time (measured — the same vendor behaviour the
 * identity envelope's `ambiguous` relation exists to not repeat). The label and the preview have
 * always ridden that pick, and a mismatched 30s clip is a small wrong; a Deezer LINK rendered on a
 * public page under a recording's name is a bigger one. So the id is kept only when
 * `expectedDurationMs` is supplied AND Deezer's returned duration agrees within
 * {@link DURATION_TOLERANCE_S}s — the same window the sibling by-name lookup above confirms with.
 * No duration to check against, or a disagreement, and no id comes back. The label and preview are
 * untouched by the guard: their behaviour is exactly what it was.
 */
export async function enrichFromDeezer(
  isrc: string | null | undefined,
  expectedDurationMs?: number,
): Promise<DeezerEnrichment> {
  if (!isrc?.trim()) {
    return {};
  }

  try {
    const trackResponse = await fetch(
      `https://api.deezer.com/track/isrc:${encodeURIComponent(isrc.trim())}`,
    );

    if (!trackResponse.ok) {
      return {};
    }

    const track = (await trackResponse.json()) as DeezerTrack;

    if (track.error || !track.id) {
      return {};
    }

    const previewUrl = track.preview?.trim() ? track.preview : undefined;
    const durationConfirmed =
      typeof expectedDurationMs === "number" &&
      expectedDurationMs > 0 &&
      typeof track.duration === "number" &&
      Math.abs(track.duration - expectedDurationMs / 1000) <= DURATION_TOLERANCE_S;
    let label: string | undefined;

    if (track.album?.id) {
      const albumResponse = await fetch(`https://api.deezer.com/album/${track.album.id}`);

      if (albumResponse.ok) {
        const album = (await albumResponse.json()) as DeezerAlbum;

        if (!album.error && album.label?.trim()) {
          label = album.label.trim();
        }
      }
    }

    return { ...(durationConfirmed ? { deezerTrackId: String(track.id) } : {}), label, previewUrl };
  } catch {
    return {};
  }
}
