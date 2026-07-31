// The `tracks` domain router module. Implements the track-read contract ops off
// the shared implementer the root (../orpc.ts) hands in. A future wave adds an
// op here and one spread line in the root — no other domain's file is touched.

import { ORPCError } from "@orpc/server";
import { parseSetParam } from "../../mix-set";
import { clampFreshLimit, listFreshTracks } from "../fresh";
import { CatalogueHubPageOutOfRangeError } from "../labels";
import { listTracksHubPage, toCatalogueTrackListItem } from "../tracks-hub";
import {
  decodeTrackCursor,
  getMixableTracks,
  getRandomTrack,
  getSimilarFindings,
  listTracks,
  toPublicTrackListItem,
} from "../tracks";
import { resolveLogPageTarget } from "../log-resolver";
import {
  type IdentityKey,
  normalizeDeezerKey,
  normalizeIsrcKey,
  normalizeMbidKey,
  normalizeSpotifyKey,
  readIdentity,
} from "../identity-envelope";
import { assertIdentityReadAllowed } from "../identity-dials";
import { ApiError } from "../spotify";
import { apiFault, type Implementer, parseLimit } from "./_shared";

// Feed page-size bounds, ported verbatim from the live feed route.
const LIST_DEFAULT_LIMIT = 16;
const LIST_MAX_LIMIT = 48;

// "More like this" row bounds — a small default (matches the `/log` row) with a
// modest ceiling; the op parses the limit tolerantly like the `list_findings` feed.
const SIMILAR_DEFAULT_LIMIT = 6;
const SIMILAR_MAX_LIMIT = 24;

// `/mix` rail bounds — a fuller default than "more like this" (the crew builds a set
// off it), still modestly capped; parsed tolerantly like the `list_findings` feed.
const MIXABLE_DEFAULT_LIMIT = 12;
const MIXABLE_MAX_LIMIT = 32;

/**
 * THE PATH PLACEHOLDER. `GET /tracks/{idOrLogId}` needs a path segment, and `/tracks` itself is the
 * archive enumerator, so a caller keying on an ISRC or an MBID passes a single `-` and puts the key
 * in the query. It is the one spelling that keeps the key EXCLUSIVE: without it a request could
 * carry a path id and a query ISRC that name different recordings, and the op would have to pick.
 */
const IDENTITY_PATH_PLACEHOLDER = "-";

/**
 * HOW MANY ISRCs ONE REQUEST MAY CARRY.
 *
 * The batch exists because the caller who needs this surface most — someone re-pointing a library
 * off a resolver that shut down — holds ISRCs by the thousand, and a request each is a round trip
 * each. Twenty is a deliberate ceiling rather than a technical one: it stays comfortably under the
 * 30-a-minute burst dial, so one honest batch always clears, and it keeps the widest possible
 * answer inside a Worker's response budget. Past it the answer is a 422 that says the number, not a
 * silent truncation that would hand back an incomplete answer wearing a complete answer's shape.
 */
const IDENTITY_MAX_BATCH_KEYS = 20;

/**
 * Split a batch key on commas. Empty segments are dropped, so a trailing comma or a doubled one is
 * read as the typo it is rather than counted as a key against the caller's allowance.
 */
function splitBatchKey(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * Decide which identity key (if any) this request carries, and refuse the malformed ones.
 *
 * `undefined` ⇒ no identity projection was asked for and the plain finding read runs, byte-for-byte
 * as before. Every refusal is an in-handler `ApiError` at 422, on the `search_tracks` precedent:
 * the contract's input stays tolerant optional strings, because oRPC's own schema rejection emits a
 * 400 and 422 is the honest status for a well-formed request carrying an unusable value.
 */
function identityKeyFor(input: {
  deezer?: string;
  identity?: string;
  idOrLogId: string;
  isrc?: string;
  mbid?: string;
  spotify?: string;
}): IdentityKey | undefined {
  const isrc = input.isrc?.trim();
  const mbid = input.mbid?.trim();
  const spotify = input.spotify?.trim();
  const deezer = input.deezer?.trim();
  const path = input.idOrLogId.trim();
  const pathIsKey = path !== "" && path !== IDENTITY_PATH_PLACEHOLDER;

  const supplied = [
    pathIsKey,
    Boolean(isrc),
    Boolean(mbid),
    Boolean(spotify),
    Boolean(deezer),
  ].filter(Boolean).length;

  if (supplied > 1) {
    throw new ApiError(
      "invalid_key",
      `One key at a time. Pass "${IDENTITY_PATH_PLACEHOLDER}" in the path when the key is a query parameter.`,
      422,
    );
  }

  if (isrc) {
    // ONE KEY OR TWENTY, one code path: a bare ISRC is a one-element batch, so the single-key
    // request cannot drift away from the batch as either changes.
    const parts = splitBatchKey(isrc);

    if (parts.length > IDENTITY_MAX_BATCH_KEYS) {
      throw new ApiError(
        "invalid_isrc",
        `That's ${parts.length} ISRCs. ${IDENTITY_MAX_BATCH_KEYS} at a time.`,
        422,
      );
    }

    const normalized = parts.map((part) => normalizeIsrcKey(part));

    // The WHOLE batch is refused when any one key is malformed, rather than the bad keys being
    // dropped quietly: a caller who mistyped one ISRC in twenty needs to be told, not handed
    // nineteen answers that look like twenty.
    if (normalized.length === 0 || normalized.some((value) => value === undefined)) {
      throw new ApiError("invalid_isrc", "That's not a well-formed ISRC.", 422);
    }

    return { isrcs: normalized.filter((value) => value !== undefined), kind: "isrc" };
  }

  if (mbid) {
    const normalized = normalizeMbidKey(mbid);

    if (!normalized) {
      throw new ApiError("invalid_mbid", "That's not a well-formed MusicBrainz recording id.", 422);
    }

    return { kind: "mbid", mbid: normalized };
  }

  if (spotify) {
    const normalized = normalizeSpotifyKey(spotify);

    if (!normalized) {
      throw new ApiError("invalid_spotify", "That's not a well-formed Spotify track link.", 422);
    }

    return { kind: "spotify", spotifyId: normalized };
  }

  if (deezer) {
    const normalized = normalizeDeezerKey(deezer);

    if (!normalized) {
      throw new ApiError("invalid_deezer", "That's not a well-formed Deezer track link.", 422);
    }

    return { deezerId: normalized, kind: "deezer" };
  }

  if (!pathIsKey) {
    // No usable key anywhere: the placeholder was passed with nothing to look up.
    throw new ApiError(
      "invalid_key",
      "Pass a Log ID, a track id, an ISRC, an MBID, or a Spotify or Deezer link.",
      422,
    );
  }

  // The projection is opt-in on the path key: a bare read keeps serving the finding DTO every
  // existing caller depends on. Any non-empty value turns it on, the tolerant-parse habit.
  return input.identity?.trim() ? { idOrLogId: path, kind: "idOrLogId" } : undefined;
}

/**
 * What one identity read COSTS on the dials: one unit per key it answers. A batch is a saved round
 * trip, never a cheaper read (identity-dials.ts holds the argument).
 */
function identityReadUnits(key: IdentityKey): number {
  return key.kind === "isrc" ? key.isrcs.length : 1;
}

/**
 * Normalize a discovery-window bound exactly as the live route's `parseTimestamp`
 * did: an invalid value is ignored (degrades to the unwindowed list), a valid one
 * is normalized to ISO so string comparison against the stored `added_at` holds.
 */
function parseTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Build the `tracks` domain's handlers — direct ports of the live route logic,
 * each preserving the success body byte-for-byte (these feed the CLI, MCP, the
 * web app, and the external newsletter agent). Errors are converted through the
 * shared `apiFault` so the rails encoder reproduces the legacy `jsonError` body.
 */
export function tracksHandlers(os: Implementer) {
  // `get_track` — public read of one finding (or mixtape) by Spotify trackId or
  // Log ID. Port of /api/tracks/{idOrLogId} GET: resolve, 404 via ORPCError when
  // absent, else the `{ ok: true } & ({ track } | { mixtape })` envelope.
  const getTrack = os.get_track.handler(async ({ context, input }) => {
    try {
      const identityKey = identityKeyFor(input);

      if (identityKey) {
        // METERED (identity-dials.ts): this is the read whose value to a harvester is the
        // aggregate rather than the row. The plain read below stays unmetered. Charged per KEY,
        // so a 20-ISRC batch spends 20 and the published dial keeps meaning what it says.
        await assertIdentityReadAllowed(context.request, { units: identityReadUnits(identityKey) });

        const identity = await readIdentity(identityKey);

        if (!identity) {
          // No submission affordance in the message, deliberately: a machine caller must never be
          // pointed at the crew's triage queue.
          throw new ORPCError("NOT_FOUND", { message: "No recording for that key" });
        }

        return { identity, ok: true } as const;
      }

      const target = await resolveLogPageTarget(input.idOrLogId);

      if (!target) {
        throw new ORPCError("NOT_FOUND", { message: `No finding for "${input.idOrLogId}"` });
      }

      return target.kind === "mixtape"
        ? ({ mixtape: target.mixtape, ok: true } as const)
        : ({ ok: true, track: toPublicTrackListItem(target.track) } as const);
    } catch (error) {
      // Re-throw oRPC's own errors (the 404 above) so the rails encoder shapes
      // the response; anything else is an unexpected fault.
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  // `list_findings` — the public merged FEED (findings + published mixtapes, newest
  // FOUND first). Port of the feed route GET: clamp the limit, decode the cursor,
  // normalize the discovery window, and drop mixtapes when a window is present. The
  // response is the FeedListPage itself — no `ok` envelope.
  const listFindingsHandler = os.list_findings.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
      const cursor = decodeTrackCursor(input.cursor ?? null);
      const since = parseTimestamp(input.since);
      const until = parseTimestamp(input.until);

      const page = await listTracks({
        // Skip the redundant `count(*)` companion on cursor pages: the archive total is
        // invariant across a scroll, so only page 1 (no cursor) pays for it. Page 2+
        // falls back to its own row count, which no consumer reads — the home feed and
        // the CLI `recent` pager both take the total off page 1 now (stable across the
        // scroll). That drops a growing findings⋈tracks scan from every "load more".
        countTotal: cursor === undefined,
        cursor,
        includeMixtapes: since === undefined && until === undefined,
        // The public feed reads the lean list projection (Finding B4): no list surface
        // renders the heavy caption/feature/reasoning fields, and they stay optional on
        // the `list_findings` contract, so their absence here is additive (get_track still
        // serves the fat single-finding shape for anyone who needs them).
        lean: true,
        limit,
        since,
        until,
      });

      // Strip the private capture key from every item before it world-serves.
      return { ...page, tracks: page.tracks.map(toPublicTrackListItem) };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // `list_tracks` — the whole-archive ENUMERATOR (every track Fluncle holds, newest
  // RELEASE first, numbered pages). The machine twin of the web `/tracks` page: it
  // reads the SAME hosted-proven `listTracksHubPage` hub, so the two never disagree
  // and no new scan over the growing table is invented here. The ONE filter is the
  // tri-state `certified` (findings only / uncertified only / all), folded into the
  // hub's compiled clause set (one gate). A page past the end 404s (never clamps to
  // page 1). Each row is the LEAN `CatalogueTrackListItem` — a finding carries its
  // coordinate + cover, an uncertified row carries neither (the Unlit Rule, structural
  // in the mapper), and the heavy DTO never crosses this boundary.
  const listTracksHandler = os.list_tracks.handler(async ({ input }) => {
    try {
      // Tolerant page parse (mirrors the web route's `pageParam`): junk / absent / < 1
      // folds to page 1, rather than 400-ing.
      const parsedPage = Math.trunc(Number(input.page));
      const page = Number.isFinite(parsedPage) && parsedPage >= 1 ? parsedPage : 1;
      const certified = input.certified === undefined ? undefined : input.certified === "true";

      const result = await listTracksHubPage({ certified }, page);

      return {
        ok: true as const,
        page: result.page,
        pageCount: result.pageCount,
        total: result.total,
        tracks: result.items.map(toCatalogueTrackListItem),
      };
    } catch (error) {
      // A page past the end is a 404 (never a clamp to page 1 — that would be a second
      // URL for page 1's rows), exactly like the web route.
      if (error instanceof CatalogueHubPageOutOfRangeError) {
        throw new ORPCError("NOT_FOUND", { message: `No page ${input.page ?? 1} of tracks` });
      }

      throw apiFault(error);
    }
  });

  // `get_random_track` — one random certified finding. Port of /api/tracks/random
  // GET: the `{ ok: true, track }` envelope, or a 404 with the custom
  // `track_not_found` code/message (carried as fault data so the rails encoder
  // reproduces the exact legacy `jsonError` body, not the generic `not_found`).
  const getRandomTrackHandler = os.get_random_track.handler(async () => {
    try {
      const track = await getRandomTrack();

      if (!track) {
        throw new ORPCError("NOT_FOUND", {
          data: { apiCode: "track_not_found", apiMessage: "No tracks found" },
          message: "No tracks found",
        });
      }

      return { ok: true, track: toPublicTrackListItem(track) } as const;
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  // `list_similar_tracks` — the N sonically-nearest findings (the "more like this"
  // cluster). Cosine-ranks the target's MuQ embedding against every other
  // coordinate-bearing finding's, self excluded, similarity order. An unknown
  // coordinate / an un-embedded finding / an empty archive all resolve to
  // `{ ok: true, findings: [] }` (a quiet empty row, never a fault). The limit is
  // parsed tolerantly like the feed's, degrading to the default rather than 400-ing.
  const listSimilarTracksHandler = os.list_similar_tracks.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, SIMILAR_DEFAULT_LIMIT, SIMILAR_MAX_LIMIT);
      const findings = await getSimilarFindings(input.idOrLogId, limit);

      return { findings: findings.map(toPublicTrackListItem), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  // `list_mixable_tracks` — the tracks that mix cleanly out of the given one (the `/mix`
  // rail). Ranks the WHOLE archive by the mixability engine (a catalogue track is rankable
  // the moment it has a key, so it competes with the findings on the same terms), excludes
  // the already-chained tracks server-side, and returns each candidate with its reason chip,
  // its `certified` register bit, and NO numeric score. The limit parses tolerantly like the
  // feed's. An unknown coordinate / a keyless target / an empty archive all resolve to
  // `{ findings: [] }`.
  //
  // `taste` IS ACCEPTED AND NO LONGER RANKS THE RAIL. Under the ratified single-probe-on-last
  // model the rail's taste probe is the chain's LAST track — which is `idOrLogId` itself — so an
  // artist seed has nothing left to say about what follows it. The parameter stays on the wire
  // (a live `/mix` link carries `?taste=`, and web + mobile both send it) and is simply not read
  // here; the seed still does its real job on `list_mix_openers`, which picks what a set OPENS
  // with. Removing it from the contract would 404 nothing and break every shared set link.
  //
  // NOTHING TO STRIP. The payload is `MixTrackSchema`, which carries no private field to
  // leak (no `sourceAudioKey`, no provenance) — and no finding-only field to leak into the
  // unlit register either. The old `toPublicTrackListItem` pass is gone with the fat DTO it
  // was cleaning up after.
  //
  // RATE LIMIT: accept-risk, no limiter (Decision 2). One key-pre-filtered archive scan,
  // comparable to the existing uncached `list_similar_tracks`. Revisit at archive growth —
  // this is now a PUBLIC page's hot path rather than an admin-gated one.
  const listMixableTracksHandler = os.list_mixable_tracks.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, MIXABLE_DEFAULT_LIMIT, MIXABLE_MAX_LIMIT);
      // Reuse the canonical `/mix` codec parser (mix-set) rather than an ad-hoc splitter:
      // `exclude` is a set of chain tokens capped at MAX_SET_LENGTH (32, token-validated).
      // This is a public unauth read with no rate limiter, so bounding the NOT-IN placeholder
      // list here keeps a huge query string from inflating the whole-archive vector scan. The
      // web client already enforces the cap, so nothing valid is rejected.
      const findings = await getMixableTracks(input.idOrLogId, {
        exclude: parseSetParam(input.exclude),
        limit,
      });

      return { findings, ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  // `list_fresh` — WHAT JUST CAME OUT: the flat, capped list of newest RELEASES over the trailing
  // 30-day window (the release-date axis, the opposite of `list_findings`' found-date feed). The lib
  // read returns the unlit-safe shape verbatim (an uncertified row carries no logId/cover), so this
  // is a thin pass-through; the tolerant `limit` string is clamped to [1, 100] (default 50).
  const listFreshHandler = os.list_fresh.handler(async ({ input }) => {
    try {
      const limit = clampFreshLimit(input.limit === undefined ? undefined : Number(input.limit));
      return await listFreshTracks({ limit });
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    get_random_track: getRandomTrackHandler,
    get_track: getTrack,
    list_findings: listFindingsHandler,
    list_fresh: listFreshHandler,
    list_mixable_tracks: listMixableTracksHandler,
    list_similar_tracks: listSimilarTracksHandler,
    list_tracks: listTracksHandler,
  };
}
