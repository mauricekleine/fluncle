import { type MixCandidate } from "@fluncle/contracts";
import { liveSurfaces } from "@fluncle/registry";
import { tool } from "ai";
import { type z } from "zod";
import { logPageUrl } from "../../fluncle-links";
import { isLogId, isMixtapeLogId } from "../../log-id";
import { MAX_SET_LENGTH, mixReasonLabel, serializeSet, setToken } from "../../mix-set";
import { type MixtapeDTO, mixtapeDisplayTitle } from "../../mixtapes";
import { albumSlug, getAlbumBySlug, listAlbumsBrowsePage } from "../albums";
import { getArtistNeighbours } from "../artist-dossier";
import {
  countArtistFindings,
  getPublicArtistBySlug,
  getPublicArtistSocials,
  listArtistsBrowsePage,
  toArtistSlug,
} from "../artists";
import {
  CATALOGUE_SORT_DEFAULT,
  CataloguePageOutOfRangeError,
  listArtistCatalogue,
  listLabelCatalogue,
} from "../catalogue-groups";
import { type FreshRecord, type FreshTrack, listFreshTracks } from "../fresh";
import { hasPublicGraphTracks } from "../hub-counts";
import {
  type CatalogueBrowsePage,
  CatalogueHubPageOutOfRangeError,
  getConfirmedAliasNames,
  getLabelBySlug,
  labelSlug,
  listLabelsBrowsePage,
} from "../labels";
import { listTracksHubPage, toCatalogueTrackListItem } from "../tracks-hub";
import { resolveLogPageTarget } from "../log-resolver";
import { subscribeToNewsletter } from "../newsletter";
import { chargeRateLimit } from "../rate-limit";
import { searchArchive } from "../search";
import { ApiError, searchTrackCandidates } from "../spotify";
import { getServiceStatuses, type ServiceHealthStatus } from "../status";
import { createSubmission } from "../submissions";
import {
  type CatalogueTrackItem,
  getFindingsByArtist,
  getFindingsByLabel,
  getMixableTracks,
  getMixChainDepth,
  getRandomTrack,
  getTracksByLogIds,
  listCatalogueTracksByAlbum,
  listTracks,
  type TrackListItem,
  toPublicTrackListItem,
} from "../tracks";
import {
  FRESH_LIMIT_MAX,
  getRandomTrackSpec,
  getStatusSpec,
  getTrackSpec,
  listFindingsSpec,
  listFreshSpec,
  listSimilarArtistsSpec,
  listTracksSpec,
  MAX_RECENT_LIMIT,
  SHARED_TOOL_SPECS,
  SIMILAR_ARTISTS_DEFAULT,
  SIMILAR_ARTISTS_MAX,
  buildSetSpec,
  getArtistSpec,
  getLabelSpec,
  listAlbumCatalogueSpec,
  listAlbumsSpec,
  listArtistCatalogueSpec,
  listArtistsSpec,
  listLabelCatalogueSpec,
  listLabelsSpec,
  searchArchiveSpec,
  submitTrackSpec,
  subscribeNewsletterSpec,
  type ToolSpec,
  toInputJsonSchema,
  type Transport,
  toWebMcpTool,
} from "../../tool-specs";

export type {
  Projection,
  ToolAccess,
  ToolEffect,
  ToolSpec,
  ToolTier,
  Transport,
  WebMcpToolDescriptor,
} from "../../tool-specs";
export { SHARED_TOOL_SPECS, toInputJsonSchema, toWebMcpTool };

export { ApiError };

export type ToolCtx = { request?: Request; signal?: AbortSignal; transport: Transport };

export type ToolDef = ToolSpec & {
  execute: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const DEFAULT_RECENT_LIMIT = 10;

function clampRecentLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return DEFAULT_RECENT_LIMIT;
  }

  return Math.min(value, MAX_RECENT_LIMIT);
}

function clampInt(value: unknown, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return fallback;
  }

  return Math.min(value, max);
}

function clampPage(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}

function normalizeFreshView(value: unknown): "albums" | "all" | "tracks" {
  return value === "albums" || value === "tracks" ? value : "all";
}

const RESOURCE_SCHEME = "fluncle://";

export function resourceUri(
  kind: "finding" | "mixtape",
  logId: string | undefined,
): string | undefined {
  return logId ? `${RESOURCE_SCHEME}${kind}/${logId}` : undefined;
}

function compactRecord<T extends Record<string, unknown>>(record: T): Partial<T> {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);

  return Object.fromEntries(entries) as Partial<T>;
}

function observationRecord(track: TrackListItem) {
  if (!track.observationAudioUrl) {
    return undefined;
  }

  const transcript = track.observationAlignment?.words
    .map((word) => word.text)
    .join(" ")
    .trim();

  return compactRecord({
    audioUrl: track.observationAudioUrl,
    durationMs: track.observationDurationMs,
    transcript: transcript ? transcript : undefined,
  });
}

export function publicFindingRecord(item: TrackListItem) {
  const track = toPublicTrackListItem(item);

  return compactRecord({
    album: track.album,
    artists: track.artists,
    bpm: track.bpm === undefined ? undefined : Math.round(track.bpm),
    coordinate: track.logId,
    durationMs: track.durationMs,
    found: track.addedAt,
    galaxy: track.galaxy?.name,
    isrc: track.isrc,
    key: track.key,
    label: track.label,
    links: compactRecord({
      log: track.logPageUrl,
      spotify: track.spotifyUrl,
      tiktok: track.tiktokUrl,
      video: track.videoUrl,
      youtube: track.youtubeUrl,
    }),
    note: track.note,
    observation: observationRecord(track),
    title: track.title,
    type: "finding",
    uri: resourceUri("finding", track.logId),
  });
}

export function publicMixtapeRecord(mixtape: MixtapeDTO) {
  return compactRecord({
    bangerCount: mixtape.memberCount,
    by: "Fluncle",
    coordinate: mixtape.logId,
    links: compactRecord({
      log: mixtape.logId ? logPageUrl(mixtape.logId) : undefined,
      mixcloud: mixtape.externalUrls.mixcloud,
      soundcloud: mixtape.externalUrls.soundcloud,
      youtube: mixtape.externalUrls.youtube,
    }),
    note: mixtape.note ?? undefined,
    recorded: mixtape.recordedAt,
    runtimeMs: mixtape.durationMs,
    title: mixtapeDisplayTitle(mixtape.title),
    tracklist: mixtape.members
      .filter((member) => member.logId)
      .map((member, index) =>
        compactRecord({
          artists: member.artists,
          coordinate: member.logId,
          position: index + 1,
          startMs: member.startMs,
          title: member.title,
        }),
      ),
    type: "mixtape",
    uri: resourceUri("mixtape", mixtape.logId),
  });
}

export type ResolvedRecord =
  | { kind: "finding"; record: ReturnType<typeof publicFindingRecord> }
  | { kind: "mixtape"; record: ReturnType<typeof publicMixtapeRecord> };

export async function readCoordinate(idOrLogId: string): Promise<ResolvedRecord | undefined> {
  const target = await resolveLogPageTarget(idOrLogId);

  if (!target) {
    return undefined;
  }

  return target.kind === "mixtape"
    ? { kind: "mixtape", record: publicMixtapeRecord(target.mixtape) }
    : { kind: "finding", record: publicFindingRecord(target.track) };
}

export function dropEmpty<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => {
      if (value === undefined || value === null) {
        return false;
      }

      return Array.isArray(value) ? value.length > 0 : true;
    }),
  ) as Partial<T>;
}

export function compactFinding(item: TrackListItem) {
  const track = toPublicTrackListItem(item);

  return dropEmpty({
    album: track.album,
    albumImageUrl: track.albumImageUrl,
    artists: track.artists,
    bpm: track.bpm === undefined ? undefined : Math.round(track.bpm),
    coordinate: track.logId,
    durationMs: track.durationMs,
    found: track.addedAt,
    galaxy: track.galaxy?.name,
    hasPreview: Boolean(track.previewUrl),
    key: track.key,
    label: track.label,
    note: track.note,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
  });
}

function compactMixtape(mixtape: {
  durationMs?: number;
  logId?: string;
  memberCount?: number;
  note?: string | null;
  title: string;
}) {
  return dropEmpty({
    bangerCount: mixtape.memberCount,
    coordinate: mixtape.logId,
    note: mixtape.note ?? undefined,
    runtimeMs: mixtape.durationMs,
    title: mixtape.title,
  });
}

function freshTrackToFinding(track: FreshTrack) {
  return dropEmpty({
    albumImageUrl: track.coverImageUrl,
    artists: track.artists,
    bpm: track.bpm === undefined ? undefined : Math.round(track.bpm),
    coordinate: track.logId,
    durationMs: track.durationMs,
    hasPreview: false,
    key: track.key,
    releaseDate: track.releaseDate,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
  });
}

function freshTrackToCatalogue(track: FreshTrack) {
  return {
    artists: track.artists,
    title: track.title,
    ...dropEmpty({ releaseDate: track.releaseDate, spotifyUrl: track.spotifyUrl }),
  };
}

function freshAlbumToCatalogue(album: FreshRecord) {
  return { artists: album.artists, title: album.name };
}

function searchHitToCatalogue(hit: {
  album?: string;
  artists: string[];
  label?: string;
  spotifyUrl?: string;
  title: string;
}) {
  return {
    artists: hit.artists,
    title: hit.title,
    ...dropEmpty({ label: hit.label, release: hit.album, spotifyUrl: hit.spotifyUrl }),
  };
}

const CATALOGUE_BROWSE_LIMIT = 24;

function catalogueItemToChat(
  item: CatalogueTrackItem,
  context: { label?: string; release?: string } = {},
) {
  return {
    artists: item.artists,
    title: item.title,
    ...dropEmpty({ label: context.label, release: context.release, spotifyUrl: item.spotifyUrl }),
  };
}

type BrowsePagination = { page: number; pageCount: number; total: number };

function projectCatalogueBrowse(
  catalogue: ReturnType<typeof catalogueItemToChat>[],
  pagination: BrowsePagination,
  ctx: ToolCtx,
) {
  if (ctx.transport === "chat") {
    return {
      catalogue,
      findings: [],
      ok: true as const,
      page: pagination.page,
      pageCount: pagination.pageCount,
    };
  }

  return {
    catalogue: catalogue.map((row) => ({ certified: false as const, ...row })),
    ok: true as const,
    page: pagination.page,
    pageCount: pagination.pageCount,
    total: pagination.total,
  };
}

async function pagedGroupedCatalogue<
  TPage extends { page: number; pageCount: number; totalTracks: number },
>(
  read: () => Promise<TPage>,
  flatten: (page: TPage) => ReturnType<typeof catalogueItemToChat>[],
  page: number,
): Promise<{ pagination: BrowsePagination; rows: ReturnType<typeof catalogueItemToChat>[] }> {
  try {
    const loaded = await read();

    return {
      pagination: { page: loaded.page, pageCount: loaded.pageCount, total: loaded.totalTracks },
      rows: flatten(loaded),
    };
  } catch (error) {
    if (error instanceof CataloguePageOutOfRangeError) {
      return { pagination: { page, pageCount: page, total: 0 }, rows: [] };
    }

    throw error;
  }
}

function projectBrowseIndex(page: CatalogueBrowsePage) {
  return {
    items: page.items,
    ok: true as const,
    page: page.page,
    pageCount: page.pageCount,
    total: page.total,
  };
}

const MAX_SEARCH = 12;

const MIX_CHAIN_LIMIT = 7;

const MAX_ENTITY_FINDINGS = 6;

const SEARCH_ARCHIVE_RL_LIMIT = 30;
const SEARCH_ARCHIVE_RL_WINDOW_MS = 60 * 1000;

function compactCertifiedFindings(items: TrackListItem[]) {
  return items.map(compactFinding).filter((finding) => finding.coordinate);
}

function searchHitToFinding(hit: {
  album?: string;
  albumImageUrl?: string;
  artists: string[];
  bpm?: number;
  galaxy?: string;
  key?: string;
  label?: string;
  logId?: string;
  title: string;
}) {
  return dropEmpty({
    album: hit.album,
    albumImageUrl: hit.albumImageUrl,
    artists: hit.artists,
    bpm: hit.bpm === undefined ? undefined : Math.round(hit.bpm),
    coordinate: hit.logId,
    galaxy: hit.galaxy,
    key: hit.key,
    label: hit.label,
    title: hit.title,
  });
}

function mixTrackToFinding(candidate: MixCandidate) {
  return dropEmpty({
    albumImageUrl: candidate.albumImageUrl,
    artists: candidate.artists,
    bpm: candidate.bpm === undefined ? undefined : Math.round(candidate.bpm),
    coordinate: candidate.logId,
    durationMs: candidate.durationMs,
    hasPreview: false,
    key: candidate.key,
    spotifyUrl: candidate.spotifyUrl,
    title: candidate.title,
  });
}

async function resolveSeedTrack(seed: string): Promise<TrackListItem | undefined> {
  if (!seed) {
    return undefined;
  }

  if (isLogId(seed) || isMixtapeLogId(seed)) {
    const target = await resolveLogPageTarget(seed);

    return target?.kind === "track" ? target.track : undefined;
  }

  const result = await searchArchive({ limit: MAX_SEARCH, q: seed });
  const hit = result.results.find((row) => row.certified && row.logId);

  if (!hit?.logId) {
    return undefined;
  }

  return (await getTracksByLogIds([hit.logId]))[hit.logId];
}

type StatusService = {
  label: string;
  message: string | null;
  name: string;
  status: ServiceHealthStatus;
};

const SERVICE_PROBE_MARKER = /service `([a-z0-9-]+)`/i;
const registryServiceLabels: Record<string, string> = (() => {
  const labels: Record<string, string> = {
    hermes: "the on-box prober (rave-02 healthcheck)",
    "render-box": "the scale-to-zero render box's reachability",
  };

  for (const surface of liveSurfaces()) {
    const serviceId = surface.operatorNotes?.match(SERVICE_PROBE_MARKER)?.[1];
    const label = surface.exposedContent[0];

    if (serviceId && label && !(serviceId in labels)) {
      labels[serviceId] = label;
    }
  }

  return labels;
})();

function statusHeadline(total: number, down: StatusService[], degraded: StatusService[]): string {
  if (down.length === 0 && degraded.length === 0) {
    return `All ${total} Fluncle systems are operational.`;
  }

  const parts: string[] = [];

  if (down.length > 0) {
    parts.push(`${listNames(down)} down`);
  }

  if (degraded.length > 0) {
    parts.push(`${listNames(degraded)} degraded`);
  }

  return `Not all systems are up: ${parts.join("; ")}.`;
}

function listNames(services: StatusService[]): string {
  return services.map((service) => service.name).join(", ");
}

async function summarizeStatusMcp(): Promise<{
  headline: string;
  ok: boolean;
  services: StatusService[];
}> {
  const rows = await getServiceStatuses();
  const services: StatusService[] = rows.map((row) => ({
    label: registryServiceLabels[row.service] ?? row.service,
    message: row.message,
    name: row.service,
    status: row.status,
  }));
  const reportedServices = services.filter((_, index) => rows[index]?.checked_at !== null);

  if (reportedServices.length === 0) {
    return { headline: "No service has reported its health yet.", ok: false, services };
  }

  const down = reportedServices.filter((service) => service.status === "down");
  const degraded = reportedServices.filter((service) => service.status === "degraded");
  const ok = down.length === 0 && degraded.length === 0;

  return { headline: statusHeadline(reportedServices.length, down, degraded), ok, services };
}

async function summarizeStatusChat(): Promise<{ headline: string; ok: boolean }> {
  const rows = await getServiceStatuses();
  const reportedRows = rows.filter((row) => row.checked_at !== null);

  if (reportedRows.length === 0) {
    return { headline: "No system has reported in yet.", ok: false };
  }

  const down = reportedRows.filter((row) => row.status === "down").map((row) => row.service);
  const degraded = reportedRows
    .filter((row) => row.status === "degraded")
    .map((row) => row.service);

  if (down.length === 0 && degraded.length === 0) {
    return { headline: `All ${reportedRows.length} systems are up.`, ok: true };
  }

  const parts = [
    down.length > 0 ? `${down.join(", ")} down` : "",
    degraded.length > 0 ? `${degraded.join(", ")} degraded` : "",
  ].filter(Boolean);

  return { headline: `Not all systems up: ${parts.join("; ")}.`, ok: false };
}

const listFindingsTool = {
  ...listFindingsSpec,
  execute: async (args, ctx) => {
    const limit = clampRecentLimit((args as { limit?: unknown }).limit);

    if (ctx.transport === "chat") {
      const page = await listTracks({ limit });

      return { findings: page.tracks.map(compactFinding), ok: true };
    }

    const page = await listTracks({ includeMixtapes: true, limit });

    return { ...page, tracks: page.tracks.map(toPublicTrackListItem) };
  },
} satisfies ToolDef;

const listTracksTool = {
  ...listTracksSpec,
  execute: async (args) => {
    const certifiedArg = (args as { certified?: unknown }).certified;
    const certified = typeof certifiedArg === "boolean" ? certifiedArg : undefined;
    const pageArg = Math.trunc(Number((args as { page?: unknown }).page));
    const page = Number.isFinite(pageArg) && pageArg >= 1 ? pageArg : 1;

    try {
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
        return { ok: true as const, page, pageCount: page, total: 0, tracks: [] };
      }

      throw error;
    }
  },
} satisfies ToolDef;

const listFreshTool = {
  ...listFreshSpec,
  execute: async (args, ctx) => {
    const rawLimit = (args as { limit?: unknown }).limit;

    const view = normalizeFreshView((args as { view?: unknown }).view);
    const showTracks = view !== "albums";
    const showAlbums = view !== "tracks";

    if (ctx.transport === "chat") {
      const fresh = await listFreshTracks({ limit: clampInt(rawLimit, FRESH_LIMIT_MAX, 12) });

      const certified = showTracks
        ? fresh.tracks.filter((track) => track.certified && track.logId)
        : [];
      const trackCatalogue = showTracks
        ? fresh.tracks.filter((track) => !track.certified).map(freshTrackToCatalogue)
        : [];

      const albumCatalogue = showAlbums ? fresh.albums.map(freshAlbumToCatalogue) : [];

      const hydrated = await getTracksByLogIds(
        certified.flatMap((track) => (track.logId ? [track.logId] : [])),
      );
      const findings = certified.map((track) => {
        const item = track.logId ? hydrated[track.logId] : undefined;

        return item
          ? { ...compactFinding(item), releaseDate: track.releaseDate }
          : freshTrackToFinding(track);
      });

      return dropEmpty({
        catalogue: [...trackCatalogue, ...albumCatalogue],
        findings,
        ok: true as const,
      });
    }

    const limit = typeof rawLimit === "number" ? rawLimit : undefined;
    const fresh = await listFreshTracks({ limit });

    return {
      albums: showAlbums ? fresh.albums : [],
      tracks: showTracks ? fresh.tracks : [],
      windowDays: fresh.windowDays,
    };
  },
} satisfies ToolDef;

const getTrackTool = {
  ...getTrackSpec,
  execute: async (args, ctx) => {
    const idOrLogId = asTrimmedString((args as { idOrLogId?: unknown }).idOrLogId);

    if (ctx.transport === "chat") {
      const target = idOrLogId ? await resolveLogPageTarget(idOrLogId) : undefined;

      if (!target) {
        return { found: false, ok: true };
      }

      return target.kind === "mixtape"
        ? { mixtape: compactMixtape(target.mixtape), ok: true }
        : { finding: compactFinding(target.track), ok: true };
    }

    if (!idOrLogId) {
      throw new ApiError("invalid_query", "A Log ID or Spotify track id is required", 400);
    }

    const resolved = await readCoordinate(idOrLogId);

    if (!resolved) {
      throw new ApiError("track_not_found", `No finding found for ${idOrLogId}`, 404);
    }

    return resolved.kind === "mixtape"
      ? { mixtape: resolved.record, ok: true }
      : { ok: true, track: resolved.record };
  },
} satisfies ToolDef;

const getRandomTrackTool = {
  ...getRandomTrackSpec,
  execute: async (_args, ctx) => {
    const track = await getRandomTrack();

    if (ctx.transport === "chat") {
      return track ? { finding: compactFinding(track), ok: true } : { found: false, ok: true };
    }

    return track
      ? { ok: true, track: toPublicTrackListItem(track) }
      : { code: "track_not_found", message: "No tracks found", ok: false };
  },
} satisfies ToolDef;

const getStatusTool = {
  ...getStatusSpec,
  execute: async (_args, ctx) =>
    ctx.transport === "chat" ? summarizeStatusChat() : summarizeStatusMcp(),
} satisfies ToolDef;

const searchArchiveTool = {
  ...searchArchiveSpec,
  execute: async (args, ctx) => {
    const query = asTrimmedString((args as { query?: unknown }).query);

    if (ctx.transport === "chat") {
      const result = await searchArchive({ limit: MAX_SEARCH, q: query });
      const certifiedHits = result.results.filter((hit) => hit.certified && hit.logId);
      const catalogue = result.results
        .filter((hit) => !(hit.certified && hit.logId))
        .map(searchHitToCatalogue);
      const hydrated = await getTracksByLogIds(
        certifiedHits.flatMap((hit) => (hit.logId ? [hit.logId] : [])),
      );
      const findings = certifiedHits.map((hit) => {
        const item = hit.logId ? hydrated[hit.logId] : undefined;

        return item ? compactFinding(item) : searchHitToFinding(hit);
      });

      return dropEmpty({
        anchor: result.anchor?.certified ? searchHitToFinding(result.anchor) : undefined,
        catalogue,
        findings,
        how: result.kind,
        ok: true as const,
      });
    }

    const charge = ctx.request
      ? await chargeRateLimit({
          action: "search_archive",
          limit: SEARCH_ARCHIVE_RL_LIMIT,
          request: ctx.request,
          windowMs: SEARCH_ARCHIVE_RL_WINDOW_MS,
        })
      : undefined;
    const result = await searchArchive({
      beforeModel: charge?.requireAllowed,
      beforeVector: charge?.requireAllowed,
      limit: MAX_SEARCH,
      q: query,
    });

    charge?.throwIfLimited();

    return { ok: true as const, ...result };
  },
} satisfies ToolDef;

const getArtistTool = {
  ...getArtistSpec,
  execute: async (args) => {
    const name = asTrimmedString((args as { name?: unknown }).name);
    const slug = name ? toArtistSlug(name) : "";
    const artist = slug ? await getPublicArtistBySlug(slug) : undefined;

    if (!artist) {
      return { found: false, ok: true };
    }

    const [findingCount, findingItems, socials] = await Promise.all([
      countArtistFindings(artist.id),
      getFindingsByArtist(artist.id, artist.name),
      getPublicArtistSocials(artist.id),
    ]);
    const certified = compactCertifiedFindings(findingItems);

    if (findingCount === 0 && certified.length === 0) {
      const page = await listArtistCatalogue(artist.id, CATALOGUE_SORT_DEFAULT, 1);
      const catalogue = page.groups
        .flatMap((record) =>
          record.tracks.map((item) => catalogueItemToChat(item, { release: record.name })),
        )
        .slice(0, CATALOGUE_BROWSE_LIMIT);

      return {
        artist: dropEmpty({
          bio: artist.bio,
          catalogue,
          findings: [],
          name: artist.name,
          slug: artist.slug,
          socials,
          spotifyUrl: artist.spotifyUrl,
        }),
        ok: true,
      };
    }

    const findings = certified.slice(0, MAX_ENTITY_FINDINGS);

    return {
      artist: dropEmpty({
        avatarUrl: findings[0]?.albumImageUrl,
        bio: artist.bio,
        findingCount,
        findings,
        name: artist.name,
        slug: artist.slug,
        socials,
        spotifyUrl: artist.spotifyUrl,
      }),
      ok: true,
    };
  },
} satisfies ToolDef;

const getLabelTool = {
  ...getLabelSpec,
  execute: async (args) => {
    const name = asTrimmedString((args as { name?: unknown }).name);
    const slug = name ? labelSlug(name) : undefined;
    const label = slug ? await getLabelBySlug(slug) : undefined;

    if (!label || !(await hasPublicGraphTracks("labels", label.id))) {
      return { found: false, ok: true };
    }

    const [certifiedFindings, aliases] = await Promise.all([
      getFindingsByLabel(label.id),
      getConfirmedAliasNames(label.id),
    ]);
    const certified = compactCertifiedFindings(certifiedFindings);

    if (certified.length === 0) {
      const page = await listLabelCatalogue(label.id, CATALOGUE_SORT_DEFAULT, 1);
      const catalogue = page.groups
        .flatMap((group) =>
          group.records.flatMap((record) =>
            record.tracks.map((item) => catalogueItemToChat(item, { release: record.name })),
          ),
        )
        .slice(0, CATALOGUE_BROWSE_LIMIT);

      return {
        label: dropEmpty({
          aliases,
          bio: label.bio,
          catalogue,
          findings: [],
          logoUrl: label.logoImageUrl,
          name: label.name,
          slug: label.slug,
        }),
        ok: true,
      };
    }

    return {
      label: dropEmpty({
        aliases,
        bio: label.bio,
        findingCount: certified.length,
        findings: certified.slice(0, MAX_ENTITY_FINDINGS),
        logoUrl: label.logoImageUrl,
        name: label.name,
        slug: label.slug,
      }),
      ok: true,
    };
  },
} satisfies ToolDef;

const buildSetTool = {
  ...buildSetSpec,
  execute: async (args) => {
    const seedTrack = await resolveSeedTrack(asTrimmedString((args as { seed?: unknown }).seed));

    if (!seedTrack) {
      return { found: false, ok: true };
    }

    const seedFinding = compactFinding(seedTrack);
    const candidates = await getMixableTracks(seedTrack.logId ?? seedTrack.trackId, {
      limit: MIX_CHAIN_LIMIT,
    });

    const steps = candidates.map((candidate) =>
      candidate.certified ? candidate : { ...candidate, logId: undefined },
    );

    if (steps.length === 0) {
      const depth = await getMixChainDepth();

      return {
        ok: true,
        set: dropEmpty({ seed: seedFinding, steps: [], thin: depth.open ? undefined : true }),
      };
    }

    const hydrated = await getTracksByLogIds(
      steps.flatMap((step) => (step.logId ? [step.logId] : [])),
    );
    const chain = steps.map((candidate) => {
      const item = candidate.logId ? hydrated[candidate.logId] : undefined;
      const base = item ? compactFinding(item) : mixTrackToFinding(candidate);

      return { ...base, reason: mixReasonLabel(candidate.reason) };
    });

    const tokens = [setToken(seedTrack), ...steps.map((step) => setToken(step))].slice(
      0,
      MAX_SET_LENGTH,
    );

    return {
      ok: true,
      set: dropEmpty({
        seed: seedFinding,
        setUrl: `/mix?set=${serializeSet(tokens)}`,
        steps: chain,
      }),
    };
  },
} satisfies ToolDef;

const listSimilarArtistsTool = {
  ...listSimilarArtistsSpec,
  execute: async (args) => {
    const source = args as { limit?: unknown; name?: unknown };
    const name = asTrimmedString(source.name);
    const slug = name ? toArtistSlug(name) : "";
    const artist = slug ? await getPublicArtistBySlug(slug) : undefined;

    if (!artist) {
      return { found: false, ok: true };
    }

    const limit = clampInt(source.limit, SIMILAR_ARTISTS_MAX, SIMILAR_ARTISTS_DEFAULT);
    const similar = await getArtistNeighbours(artist.id, limit);

    return { of: dropEmpty({ name: artist.name, slug: artist.slug }), ok: true, similar };
  },
} satisfies ToolDef;

const listAlbumCatalogueTool = {
  ...listAlbumCatalogueSpec,
  execute: async (args, ctx) => {
    const name = asTrimmedString((args as { name?: unknown }).name);
    const page = clampPage((args as { page?: unknown }).page);
    const slug = name ? albumSlug(name) : undefined;
    const album = slug ? await getAlbumBySlug(slug) : undefined;

    if (!album || !(await hasPublicGraphTracks("albums", album.id))) {
      return projectCatalogueBrowse([], { page, pageCount: 1, total: 0 }, ctx);
    }

    const slice = await listCatalogueTracksByAlbum(album.id);
    const pageCount = Math.max(Math.ceil(slice.tracks.length / CATALOGUE_BROWSE_LIMIT), 1);
    const start = (page - 1) * CATALOGUE_BROWSE_LIMIT;
    const catalogue = slice.tracks
      .slice(start, start + CATALOGUE_BROWSE_LIMIT)
      .map((item) => catalogueItemToChat(item, { release: album.name }));

    return projectCatalogueBrowse(catalogue, { page, pageCount, total: slice.total }, ctx);
  },
} satisfies ToolDef;

const listArtistCatalogueTool = {
  ...listArtistCatalogueSpec,
  execute: async (args, ctx) => {
    const name = asTrimmedString((args as { name?: unknown }).name);
    const page = clampPage((args as { page?: unknown }).page);
    const slug = name ? toArtistSlug(name) : "";
    const artist = slug ? await getPublicArtistBySlug(slug) : undefined;

    if (!artist) {
      return projectCatalogueBrowse([], { page, pageCount: 1, total: 0 }, ctx);
    }

    const { pagination, rows } = await pagedGroupedCatalogue(
      () => listArtistCatalogue(artist.id, CATALOGUE_SORT_DEFAULT, page),
      (loaded) =>
        loaded.groups.flatMap((record) =>
          record.tracks.map((item) => catalogueItemToChat(item, { release: record.name })),
        ),
      page,
    );

    return projectCatalogueBrowse(rows, pagination, ctx);
  },
} satisfies ToolDef;

const listLabelCatalogueTool = {
  ...listLabelCatalogueSpec,
  execute: async (args, ctx) => {
    const name = asTrimmedString((args as { name?: unknown }).name);
    const page = clampPage((args as { page?: unknown }).page);
    const slug = name ? labelSlug(name) : undefined;
    const label = slug ? await getLabelBySlug(slug) : undefined;

    if (!label || !(await hasPublicGraphTracks("labels", label.id))) {
      return projectCatalogueBrowse([], { page, pageCount: 1, total: 0 }, ctx);
    }

    const { pagination, rows } = await pagedGroupedCatalogue(
      () => listLabelCatalogue(label.id, CATALOGUE_SORT_DEFAULT, page),
      (loaded) =>
        loaded.groups.flatMap((group) =>
          group.records.flatMap((record) =>
            record.tracks.map((item) =>
              catalogueItemToChat(item, { label: label.name, release: record.name }),
            ),
          ),
        ),
      page,
    );

    return projectCatalogueBrowse(rows, pagination, ctx);
  },
} satisfies ToolDef;

const listArtistsTool = {
  ...listArtistsSpec,
  execute: async (args) =>
    projectBrowseIndex(await listArtistsBrowsePage(clampPage((args as { page?: unknown }).page))),
} satisfies ToolDef;

const listAlbumsTool = {
  ...listAlbumsSpec,
  execute: async (args) =>
    projectBrowseIndex(await listAlbumsBrowsePage(clampPage((args as { page?: unknown }).page))),
} satisfies ToolDef;

const listLabelsTool = {
  ...listLabelsSpec,
  execute: async (args) =>
    projectBrowseIndex(await listLabelsBrowsePage(clampPage((args as { page?: unknown }).page))),
} satisfies ToolDef;

const submitTrackTool = {
  ...submitTrackSpec,
  execute: async (args, ctx) => {
    if (!ctx.request) {
      throw new ApiError("invalid_query", "A request context is required to submit", 400);
    }

    const source = args as { contact?: unknown; note?: unknown; spotifyUrl?: unknown };
    const spotifyUrl = asTrimmedString(source.spotifyUrl);

    if (!spotifyUrl) {
      throw new ApiError("invalid_query", "A Spotify track URL is required", 400);
    }

    const candidate = (await searchTrackCandidates(spotifyUrl))[0];

    if (!candidate) {
      throw new ApiError("track_not_found", "No track matched that Spotify URL", 404);
    }

    const submission = await createSubmission(
      {
        album: candidate.album,
        artists: candidate.artists,
        artworkUrl: candidate.artworkUrl,
        contact: optionalString(source.contact),
        note: optionalString(source.note),
        source: "web",
        spotifyTrackId: candidate.id,
        spotifyUrl: candidate.spotifyUrl,
        title: candidate.title,
      },
      ctx.request,
    );

    return { ok: true, submission };
  },
} satisfies ToolDef;

const subscribeNewsletterTool = {
  ...subscribeNewsletterSpec,
  execute: async (args, ctx) => {
    if (!ctx.request) {
      throw new ApiError("invalid_query", "A request context is required to subscribe", 400);
    }

    await subscribeToNewsletter(
      { email: asTrimmedString((args as { email?: unknown }).email) },
      ctx.request,
    );

    return { ok: true };
  },
} satisfies ToolDef;

export const SHARED_TOOLS: ToolDef[] = [
  listFindingsTool,
  listTracksTool,
  listFreshTool,
  getTrackTool,
  getRandomTrackTool,
  getStatusTool,
  searchArchiveTool,
  getArtistTool,
  getLabelTool,
  buildSetTool,
  listSimilarArtistsTool,
  listAlbumCatalogueTool,
  listArtistCatalogueTool,
  listLabelCatalogueTool,
  listArtistsTool,
  listAlbumsTool,
  listLabelsTool,
  submitTrackTool,
  subscribeNewsletterTool,
];

export type McpToolDescriptor = {
  description: string;
  execute: (args: Record<string, unknown>, request: Request) => Promise<unknown>;
  inputSchema: Record<string, unknown>;
  name: string;
  title: string;
};

export function toMcpTool(def: ToolDef): McpToolDescriptor {
  return {
    description: def.description,
    execute: (args, request) => def.execute(args, { request, transport: "mcp" }),
    inputSchema: toInputJsonSchema(def),
    name: def.name,
    title: def.title,
  };
}

export function toAiSdkTool<In extends z.ZodType>(
  def: {
    description: string;
    execute: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>;
    input: In;
  },
  request?: Request,
) {
  return tool({
    description: def.description,
    execute: async (args: z.infer<In>, options: { abortSignal?: AbortSignal }) =>
      def.execute(args as Record<string, unknown>, {
        request,
        signal: options?.abortSignal,
        transport: "chat",
      }),
    inputSchema: def.input,
  });
}

export function sharedChatTools(request?: Request) {
  return {
    build_set: toAiSdkTool(buildSetTool, request),
    get_artist: toAiSdkTool(getArtistTool, request),
    get_label: toAiSdkTool(getLabelTool, request),
    get_random_track: toAiSdkTool(getRandomTrackTool, request),
    get_status: toAiSdkTool(getStatusTool, request),
    get_track: toAiSdkTool(getTrackTool, request),
    list_album_catalogue: toAiSdkTool(listAlbumCatalogueTool, request),
    list_albums: toAiSdkTool(listAlbumsTool, request),
    list_artist_catalogue: toAiSdkTool(listArtistCatalogueTool, request),
    list_artists: toAiSdkTool(listArtistsTool, request),
    list_findings: toAiSdkTool(listFindingsTool, request),
    list_fresh: toAiSdkTool(listFreshTool, request),
    list_label_catalogue: toAiSdkTool(listLabelCatalogueTool, request),
    list_labels: toAiSdkTool(listLabelsTool, request),
    list_similar_artists: toAiSdkTool(listSimilarArtistsTool, request),
    list_tracks: toAiSdkTool(listTracksTool, request),
    search_archive: toAiSdkTool(searchArchiveTool, request),
    submit_track: toAiSdkTool(submitTrackTool, request),
    subscribe_newsletter: toAiSdkTool(subscribeNewsletterTool, request),
  };
}
