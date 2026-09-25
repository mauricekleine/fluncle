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

const LIST_DEFAULT_LIMIT = 16;
const LIST_MAX_LIMIT = 48;

const SIMILAR_DEFAULT_LIMIT = 6;
const SIMILAR_MAX_LIMIT = 24;

const MIXABLE_DEFAULT_LIMIT = 12;
const MIXABLE_MAX_LIMIT = 32;

const IDENTITY_PATH_PLACEHOLDER = "-";

const IDENTITY_MAX_BATCH_KEYS = 20;

function splitBatchKey(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

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
    const parts = splitBatchKey(isrc);

    if (parts.length > IDENTITY_MAX_BATCH_KEYS) {
      throw new ApiError(
        "invalid_isrc",
        `That's ${parts.length} ISRCs. ${IDENTITY_MAX_BATCH_KEYS} at a time.`,
        422,
      );
    }

    const normalized = parts.map((part) => normalizeIsrcKey(part));

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
    throw new ApiError(
      "invalid_key",
      "Pass a Log ID, a track id, an ISRC, an MBID, or a Spotify or Deezer link.",
      422,
    );
  }

  return input.identity?.trim() ? { idOrLogId: path, kind: "idOrLogId" } : undefined;
}

function identityReadUnits(key: IdentityKey): number {
  return key.kind === "isrc" ? key.isrcs.length : 1;
}

function parseTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function tracksHandlers(os: Implementer) {
  const getTrack = os.get_track.handler(async ({ context, input }) => {
    try {
      const identityKey = identityKeyFor(input);

      if (identityKey) {
        await assertIdentityReadAllowed(context.request, { units: identityReadUnits(identityKey) });

        const identity = await readIdentity(identityKey);

        if (!identity) {
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
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  const listFindingsHandler = os.list_findings.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
      const cursor = decodeTrackCursor(input.cursor ?? null);
      const since = parseTimestamp(input.since);
      const until = parseTimestamp(input.until);

      const page = await listTracks({
        countTotal: cursor === undefined,
        cursor,
        includeMixtapes: since === undefined && until === undefined,

        lean: true,
        limit,
        since,
        until,
      });

      return { ...page, tracks: page.tracks.map(toPublicTrackListItem) };
    } catch (error) {
      throw apiFault(error);
    }
  });

  const listTracksHandler = os.list_tracks.handler(async ({ input }) => {
    try {
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
      if (error instanceof CatalogueHubPageOutOfRangeError) {
        throw new ORPCError("NOT_FOUND", { message: `No page ${input.page ?? 1} of tracks` });
      }

      throw apiFault(error);
    }
  });

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

  const listSimilarTracksHandler = os.list_similar_tracks.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, SIMILAR_DEFAULT_LIMIT, SIMILAR_MAX_LIMIT);
      const findings = await getSimilarFindings(input.idOrLogId, limit);

      return { findings: findings.map(toPublicTrackListItem), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  const listMixableTracksHandler = os.list_mixable_tracks.handler(async ({ input }) => {
    try {
      const limit = parseLimit(input.limit, MIXABLE_DEFAULT_LIMIT, MIXABLE_MAX_LIMIT);

      const findings = await getMixableTracks(input.idOrLogId, {
        exclude: parseSetParam(input.exclude),
        limit,
      });

      return { findings, ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

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
