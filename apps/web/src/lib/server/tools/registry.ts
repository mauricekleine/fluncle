// The server half of the shared tool registry — one `execute` per archive verb, and the three
// transport adapters.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────
// Fluncle exposes the same drum & bass archive as agent-callable TOOLS on three surfaces: the
// public MCP server (lib/server/mcp.ts), ChatDnB's AI-SDK tools (lib/server/chat.ts), and the
// in-page WebMCP surface (lib/webmcp.ts). Those three used to hand-maintain their own copies of
// every overlapping tool's name, description, and input schema — so the same verb could drift
// into three subtly different answers (the `list_fresh` empty-in-chat bug that kicked off this
// work). The tool SPECS (name + title + description + Zod input schema, client-safe) live in
// ./specs.ts; this module attaches the server-side `execute` to each and PROJECTS it onto each
// transport through a thin adapter. Change a tool here (or its spec) and all three surfaces move
// together.
//
// ── WHAT IS AND ISN'T SHARED (the honest divergence) ─────────────────────────────────
// The overlapping tools intentionally diverge in OUTPUT per transport — the MCP world-serves the
// fuller public record (`publicFindingRecord` / `toPublicTrackListItem`), ChatDnB serves the
// compact card (`compactFinding`), and `get_status` carries the full service list on MCP but only
// a one-line summary in chat. Two of the five also diverge in the QUERY they issue: `list_tracks`
// includes mixtapes on MCP but is findings-only in chat. A single transport-agnostic `execute`
// returning one raw shape therefore cannot be byte-identical across transports. So each tool keeps
// ONE `execute` that reads `ctx.transport` and lifts today's per-transport wiring verbatim into
// each branch; the closed `project` map (on the spec) names the projection each transport realizes
// (the four sanctioned output shapes), and the tool-set parity + output-shape tests assert
// `execute` honours it. Divergence stays constrained to the four named shapes.

import { type MixCandidate } from "@fluncle/contracts";
import { liveSurfaces } from "@fluncle/registry";
import { tool } from "ai";
import { type z } from "zod";
import { logPageUrl } from "../../fluncle-links";
import { isLogId, isMixtapeLogId } from "../../log-id";
import { MAX_SET_LENGTH, mixReasonLabel, serializeSet, setToken } from "../../mix-set";
import { type MixtapeDTO, mixtapeDisplayTitle } from "../../mixtapes";
import { getArtistNeighbours } from "../artist-dossier";
import {
  countArtistFindings,
  getArtistBySlug,
  getPublicArtistSocials,
  toArtistSlug,
} from "../artists";
import { type FreshTrack, listFreshTracks } from "../fresh";
import { getConfirmedAliasNames, getLabelBySlug, labelSlug } from "../labels";
import { resolveLogPageTarget } from "../log-resolver";
import { subscribeToNewsletter } from "../newsletter";
import { assertRateLimit } from "../rate-limit";
import { searchArchive } from "../search";
import { ApiError, searchTrackCandidates } from "../spotify";
import { getServiceStatuses, type ServiceHealthStatus } from "../status";
import { createSubmission } from "../submissions";
import {
  getFindingsByArtist,
  getFindingsByLabel,
  getMixableTracks,
  getMixChainDepth,
  getRandomTrack,
  getTracksByLogIds,
  listTracks,
  type TrackListItem,
  toPublicTrackListItem,
} from "../tracks";
import {
  FRESH_LIMIT_MAX,
  getRandomTrackSpec,
  getStatusSpec,
  getTrackSpec,
  listFreshSpec,
  listTracksSpec,
  MAX_RECENT_LIMIT,
  SHARED_TOOL_SPECS,
  SIMILAR_ARTISTS_DEFAULT,
  SIMILAR_ARTISTS_MAX,
  buildSetSpec,
  getArtistSpec,
  getLabelSpec,
  getSimilarArtistsSpec,
  searchArchiveSpec,
  submitTrackSpec,
  subscribeNewsletterSpec,
  type ToolSpec,
  toInputJsonSchema,
  type Transport,
  toWebMcpTool,
} from "./specs";

// The client-safe spec types, the spec list, and the WebMCP adapter are re-exported so a server
// consumer can reach the whole registry from one import. (WebMCP itself imports ./specs directly,
// so it never pulls this server module — and its Turso imports — into the browser bundle.)
export type {
  Projection,
  ToolAccess,
  ToolEffect,
  ToolSpec,
  ToolTier,
  Transport,
  WebMcpToolDescriptor,
} from "./specs";
export { SHARED_TOOL_SPECS, toInputJsonSchema, toWebMcpTool };
// The tool error carrier — re-exported so callers share the one `ApiError` in the server (the MCP
// dispatcher's `instanceof` check depends on it).
export { ApiError };

// ── The ToolDef shape ────────────────────────────────────────────────────────────────

/**
 * The per-call context. `request` carries the inbound `Request` to a write's server function (the
 * submitter hash, rate limits); `signal` maps an AI-SDK abort through to a server read; `transport`
 * is set by the adapter so a shared `execute` can lift each transport's exact wiring (see the module
 * header for why one agnostic `execute` cannot be byte-identical).
 */
export type ToolCtx = { request?: Request; signal?: AbortSignal; transport: Transport };

/** A tool spec (from ./specs) plus its canonical server `execute`. */
export type ToolDef = ToolSpec & {
  execute: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>;
};

// ── Small utilities ──────────────────────────────────────────────────────────────────

/** Trim a value to a string, or "" when it is not one (the tolerant coercion the MCP uses). */
function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Pass a string arg through untouched, or `undefined` when it is not a string (optional fields). */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The recent-window default (the cap `MAX_RECENT_LIMIT` lives in ./specs alongside the schema). */
const DEFAULT_RECENT_LIMIT = 10;

/** Clamp a recent-window limit into `[1, 48]`, defaulting to 10 — the shape `list_tracks` uses. */
function clampRecentLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return DEFAULT_RECENT_LIMIT;
  }

  return Math.min(value, MAX_RECENT_LIMIT);
}

/** Clamp an integer into `[1, max]`, defaulting to `fallback` — chat's tolerant list clamp. */
function clampInt(value: unknown, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return fallback;
  }

  return Math.min(value, max);
}

// ── The MCP `publicRecord` shapers (lifted verbatim from mcp.ts) ─────────────────────
//
// The archive's PUBLIC record — deliberately the same fields /log/<id> renders (plus the
// observation transcript /radio renders), never the private capture key or internal fields.
// Shared with mcp.ts's resources (resources/read serves the same record).

const RESOURCE_SCHEME = "fluncle://";

/** The resource URI for a coordinated item, typed by kind (fluncle://finding/012.8.0A). */
export function resourceUri(
  kind: "finding" | "mixtape",
  logId: string | undefined,
): string | undefined {
  return logId ? `${RESOURCE_SCHEME}${kind}/${logId}` : undefined;
}

/** Drop undefined values so the served JSON carries only present, public fields. */
function compactRecord<T extends Record<string, unknown>>(record: T): Partial<T> {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);

  return Object.fromEntries(entries) as Partial<T>;
}

/**
 * The recovered observation as a public sub-record: the audio URL (the /log audio element source)
 * plus, when aligned, the transcript /radio renders. Absent when there is none.
 */
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

/**
 * A finding's PUBLIC record — only the fields /log/<id> renders (plus the observation transcript).
 * `toPublicTrackListItem` strips the private full-song capture key first.
 */
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

/** A mixtape's PUBLIC record — the fields the /log mixtape plate renders (title, note, tracklist). */
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

/** The resolved public record for a coordinate — a finding or a mixtape (or undefined). */
export type ResolvedRecord =
  | { kind: "finding"; record: ReturnType<typeof publicFindingRecord> }
  | { kind: "mixtape"; record: ReturnType<typeof publicMixtapeRecord> };

/**
 * Resolve a coordinate (Log ID) or Spotify track id to its public record, reusing the same
 * resolver the /log page uses so the MCP read and the web read never drift. Shared with mcp.ts's
 * resources/read.
 */
export async function readCoordinate(idOrLogId: string): Promise<ResolvedRecord | undefined> {
  const target = await resolveLogPageTarget(idOrLogId);

  if (!target) {
    return undefined;
  }

  return target.kind === "mixtape"
    ? { kind: "mixtape", record: publicMixtapeRecord(target.mixtape) }
    : { kind: "finding", record: publicFindingRecord(target.track) };
}

// ── The chat `compactCard` shapers (lifted verbatim from chat.ts) ────────────────────

/** Drop undefined/null/empty so a tool result carries only present, real facts (never a null). */
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

/**
 * A finding as Fluncle needs to speak it AND as the card needs to show it. The card plays through
 * the live `/api/preview/<logId>` relay, so the raw `previewUrl` (an EXPIRING Deezer token) NEVER
 * rides a tool output — only the derived `hasPreview` boolean does.
 */
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

/** A mixtape reduced to what Fluncle speaks from — the checkpoint, not the full tracklist. */
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

/**
 * A fresh-release row reduced to the finding fields the card needs — the fallback for a certified
 * release the batch hydrator missed. A fresh row carries no previewUrl, so `hasPreview` is false;
 * its date is a RELEASE date (the Found Rule, echoed on the wire).
 */
function freshTrackToFinding(track: FreshTrack) {
  return dropEmpty({
    albumImageUrl: track.coverImageUrl,
    artists: track.artists,
    bpm: track.bpm === undefined ? undefined : Math.round(track.bpm),
    coordinate: track.logId,
    durationMs: track.durationMs,
    hasPreview: false,
    key: track.key,
    spotifyUrl: track.spotifyUrl,
    title: track.title,
  });
}

// ── The archive-read helpers (lifted verbatim from chat.ts) ──────────────────────────
//
// PR-2 moved search_archive / get_artist / get_label / build_set out of chat.ts into the shared
// registry. Their compact shapers + the seed resolver move with them, unchanged, so the MCP + chat
// executes read exactly what ChatDnB read before.

/** The archive-search cap handed to search_archive / the build_set seed resolver. */
const MAX_SEARCH = 12;

/**
 * How many mixable steps `build_set` chains off the seed — one full rail's worth of what mixes
 * in next, before the certified-only filter thins it (the seed leads; the card + `/mix` link are
 * at most this many rows plus the seed).
 */
const MIX_CHAIN_LIMIT = 7;

/**
 * How many of an entity's findings ride on a `get_artist`/`get_label` card — the recent/
 * representative ones. The card links to the full page for the rest, so a dossier reads as a
 * conversation, not a discography dump.
 */
const MAX_ENTITY_FINDINGS = 6;

// The MCP `search_archive`'s shared rate-limit budget — the SAME `action` + window as the public
// HTTP twin (orpc/search.ts), so the anonymous MCP and the public /api surface share one per-IP
// limiter (its tier-4 sonic + LLM path spends real money; the /mcp endpoint has no session).
const SEARCH_ARCHIVE_RL_LIMIT = 30;
const SEARCH_ARCHIVE_RL_WINDOW_MS = 60 * 1000;

/**
 * Compact an entity's findings for a card, CERTIFIED-ONLY. The resolvers already inner-join on a
 * coordinate, but the coordinate filter is the same wire-level grounding boundary search_archive
 * applies — a row without a coordinate is not something Fluncle speaks about, so it never reaches
 * the model even if a resolver's shape ever changed. Newest-first is preserved; the caller slices.
 */
function compactCertifiedFindings(items: TrackListItem[]) {
  return items.map(compactFinding).filter((finding) => finding.coordinate);
}

/** A search hit, reduced to the facts Fluncle speaks from (certified rows only reach here). */
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

/**
 * A mix candidate reduced to the finding fields the Chain Card needs, WITHOUT its `previewUrl`
 * (a mix candidate carries none anyway) — the fallback for a certified step the batch hydrator
 * missed. The reason chip is added by the caller as a human string; this never carries a score.
 */
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

/**
 * Resolve `build_set`'s seed to a CERTIFIED finding Fluncle can chain from, or `undefined`.
 * A coordinate resolves directly (a mixtape is not a mixable seed, so it is rejected); anything
 * else is a NAME — the top certified search hit is the start, hydrated to the full finding.
 */
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

// ── The `identity` (status) summarizers ──────────────────────────────────────────────

/** One service in the MCP get_status summary. */
type StatusService = {
  label: string;
  message: string | null;
  name: string;
  status: ServiceHealthStatus;
};

// A friendly label per `/status` service id, derived from the surfaces registry so the two never
// drift (mcp.ts's original derivation, lifted verbatim).
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

/** The MCP one-line verdict — names down/degraded services so an agent can relay specifics. */
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

/**
 * The MCP get_status summary — every service labelled from the registry, `ok` true only when all
 * are `ok`, an empty store reported as unknown (never a false all-clear).
 */
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

  if (services.length === 0) {
    return { headline: "No service has reported its health yet.", ok: false, services };
  }

  const down = services.filter((service) => service.status === "down");
  const degraded = services.filter((service) => service.status === "degraded");
  const ok = down.length === 0 && degraded.length === 0;

  return { headline: statusHeadline(services.length, down, degraded), ok, services };
}

/** The chat get_status summary — a one-line, model-facing headline + ok, nothing else. */
async function summarizeStatusChat(): Promise<{ headline: string; ok: boolean }> {
  const rows = await getServiceStatuses();

  if (rows.length === 0) {
    return { headline: "No system has reported in yet.", ok: false };
  }

  const down = rows.filter((row) => row.status === "down").map((row) => row.service);
  const degraded = rows.filter((row) => row.status === "degraded").map((row) => row.service);

  if (down.length === 0 && degraded.length === 0) {
    return { headline: `All ${rows.length} systems are up.`, ok: true };
  }

  const parts = [
    down.length > 0 ? `${down.join(", ")} down` : "",
    degraded.length > 0 ? `${degraded.join(", ")} degraded` : "",
  ].filter(Boolean);

  return { headline: `Not all systems up: ${parts.join("; ")}.`, ok: false };
}

// ── The five overlapping tools (spec + server execute) ────────────────────────────────

const listTracksTool = {
  ...listTracksSpec,
  execute: async (args, ctx) => {
    const limit = clampRecentLimit((args as { limit?: unknown }).limit);

    if (ctx.transport === "chat") {
      // Findings only (no mixtapes) — a mixtape is reached by its F-coordinate through get_track,
      // and keeping the list findings-only means every row is a TrackListItem.
      const page = await listTracks({ limit });

      return { findings: page.tracks.map(compactFinding), ok: true };
    }

    const page = await listTracks({ includeMixtapes: true, limit });

    // Strip the private capture key before the archive world-serves to the agent.
    return { ...page, tracks: page.tracks.map(toPublicTrackListItem) };
  },
} satisfies ToolDef;

const listFreshTool = {
  ...listFreshSpec,
  execute: async (args, ctx) => {
    const rawLimit = (args as { limit?: unknown }).limit;

    if (ctx.transport === "chat") {
      // Chat keeps its own default (12) and tolerant clamp; only the CAP unifies to 100.
      const fresh = await listFreshTracks({ limit: clampInt(rawLimit, FRESH_LIMIT_MAX, 12) });

      // THE GROUNDING BOUNDARY: only certified findings reach the model. An uncertified catalogue
      // row on the fresh list carries no coordinate and is never something Fluncle speaks about —
      // drop it before the hydrator is even asked (the Unlit Rule, at the wire).
      const certified = fresh.tracks.filter((track) => track.certified && track.logId);

      // Hydrate the certified logIds to full findings so each card shows its cover, chips, and a
      // play control. A logId the hydrator misses falls back to the fresh row's own fields.
      const hydrated = await getTracksByLogIds(
        certified.flatMap((track) => (track.logId ? [track.logId] : [])),
      );
      const findings = certified.map((track) => {
        const item = track.logId ? hydrated[track.logId] : undefined;

        return item ? compactFinding(item) : freshTrackToFinding(track);
      });

      return { findings, ok: true };
    }

    // MCP/WebMCP world-serve the whole flat fresh list (findings + uncertified rows) as-is —
    // listFreshTracks strips the private key and mints nothing for the uncertified rows.
    const limit = typeof rawLimit === "number" ? rawLimit : undefined;

    return listFreshTracks({ limit });
  },
} satisfies ToolDef;

const getTrackTool = {
  ...getTrackSpec,
  execute: async (args, ctx) => {
    const idOrLogId = asTrimmedString((args as { idOrLogId?: unknown }).idOrLogId);

    if (ctx.transport === "chat") {
      // Chat resolves and returns a compact card, or the honest "he has not found it".
      const target = idOrLogId ? await resolveLogPageTarget(idOrLogId) : undefined;

      if (!target) {
        return { found: false, ok: true };
      }

      return target.kind === "mixtape"
        ? { mixtape: compactMixtape(target.mixtape), ok: true }
        : { finding: compactFinding(target.track), ok: true };
    }

    // MCP/WebMCP world-serve the full public record; a missing/unknown coordinate is a tool error.
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

// ── The archive-read tools PR-2 lifted out of ChatDnB ────────────────────────────────

const searchArchiveTool = {
  ...searchArchiveSpec,
  execute: async (args, ctx) => {
    const query = asTrimmedString((args as { query?: unknown }).query);

    if (ctx.transport === "chat") {
      // CHAT keeps its findings-only projection (until PR-4): an uncertified catalogue row has no
      // coordinate and is never something Fluncle speaks about — strip it before the hydrator is
      // ever asked about it (the Unlit Rule, at the wire).
      const result = await searchArchive({ limit: MAX_SEARCH, q: query });
      const certifiedHits = result.results.filter((hit) => hit.certified && hit.logId);
      const hydrated = await getTracksByLogIds(
        certifiedHits.flatMap((hit) => (hit.logId ? [hit.logId] : [])),
      );
      const findings = certifiedHits.map((hit) => {
        const item = hit.logId ? hydrated[hit.logId] : undefined;

        return item ? compactFinding(item) : searchHitToFinding(hit);
      });

      return dropEmpty({
        anchor: result.anchor?.certified ? searchHitToFinding(result.anchor) : undefined,
        findings,
        how: result.kind,
        ok: true as const,
      });
    }

    // MCP world-serves the WHOLE SearchResult — both registers, each row certified-tagged (never
    // findings-filtered, exactly like list_fresh). First, the mandatory shared limiter: the
    // anonymous /mcp has no session, and this search's sonic + LLM tiers spend real money, so it
    // shares the public HTTP twin's per-IP budget (same `action`, same window ⇒ one limiter).
    if (ctx.request) {
      await assertRateLimit({
        action: "search_archive",
        limit: SEARCH_ARCHIVE_RL_LIMIT,
        request: ctx.request,
        windowMs: SEARCH_ARCHIVE_RL_WINDOW_MS,
      });
    }

    return { ok: true as const, ...(await searchArchive({ limit: MAX_SEARCH, q: query })) };
  },
} satisfies ToolDef;

const getArtistTool = {
  ...getArtistSpec,
  execute: async (args) => {
    const name = asTrimmedString((args as { name?: unknown }).name);
    const slug = name ? toArtistSlug(name) : "";
    const artist = slug ? await getArtistBySlug(slug) : undefined;

    if (!artist) {
      return { found: false, ok: true };
    }

    const [findingCount, findingItems, socials] = await Promise.all([
      countArtistFindings(artist.id),
      getFindingsByArtist(artist.id, artist.name),
      getPublicArtistSocials(artist.id),
    ]);
    const certified = compactCertifiedFindings(findingItems);

    // An artist Fluncle has never certified a finding from is not something he speaks about.
    if (findingCount === 0 && certified.length === 0) {
      return { found: false, ok: true };
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

    if (!label) {
      return { found: false, ok: true };
    }

    const certified = compactCertifiedFindings(await getFindingsByLabel(label.id));

    // A label Fluncle has no certified finding on is not something he speaks about.
    if (certified.length === 0) {
      return { found: false, ok: true };
    }

    const aliases = await getConfirmedAliasNames(label.id);

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

    // No certified finding to start from is the honest "he has not logged it".
    if (!seedTrack) {
      return { found: false, ok: true };
    }

    const seedFinding = compactFinding(seedTrack);
    const candidates = await getMixableTracks(seedTrack.logId ?? seedTrack.trackId, {
      limit: MIX_CHAIN_LIMIT,
    });

    // THE GROUNDING BOUNDARY (preserved until PR-4): only a certified, coordinate-bearing
    // candidate can be named or ride the `?set=` handoff.
    const steps = candidates.flatMap((candidate) =>
      candidate.certified && candidate.logId ? [candidate] : [],
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

const getSimilarArtistsTool = {
  ...getSimilarArtistsSpec,
  execute: async (args) => {
    const source = args as { limit?: unknown; name?: unknown };
    const name = asTrimmedString(source.name);
    const slug = name ? toArtistSlug(name) : "";
    const artist = slug ? await getArtistBySlug(slug) : undefined;

    // An unresolved name is the honest "he has not logged them" — same as get_artist.
    if (!artist) {
      return { found: false, ok: true };
    }

    // A thin pass-through of the artist page's neighbour read (getArtistNeighbours). The neighbour
    // MECHANISM is a separate operator workstream — this only resolves name→slug→id and relays what
    // it returns; if `ArtistNeighbour` later gains a register field it rides through unchanged.
    const limit = clampInt(source.limit, SIMILAR_ARTISTS_MAX, SIMILAR_ARTISTS_DEFAULT);
    const similar = await getArtistNeighbours(artist.id, limit);

    return { of: dropEmpty({ name: artist.name, slug: artist.slug }), ok: true, similar };
  },
} satisfies ToolDef;

// ── The write tools PR-2 lifted into the shared registry ─────────────────────────────
//
// They receive `ctx.request` (the submitter hash / rate limit). On the MCP it is the inbound
// JSON-RPC Request; on ChatDnB it is threaded from the gated /api/chat route (session-safe).

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

/**
 * Every shared tool, single-sourced. Order mirrors SHARED_TOOL_SPECS: `list_tracks` first (the MCP
 * alias clones it), the five overlapping reads, the reads lifted out of ChatDnB, then the writes.
 */
export const SHARED_TOOLS: ToolDef[] = [
  listTracksTool,
  listFreshTool,
  getTrackTool,
  getRandomTrackTool,
  getStatusTool,
  searchArchiveTool,
  getArtistTool,
  getLabelTool,
  buildSetTool,
  getSimilarArtistsTool,
  submitTrackTool,
  subscribeNewsletterTool,
];

// ── The server transport adapters ─────────────────────────────────────────────────────

/** The MCP tool shape (structurally compatible with mcp.ts's `McpTool`, minus its alias flag). */
export type McpToolDescriptor = {
  description: string;
  execute: (args: Record<string, unknown>, request: Request) => Promise<unknown>;
  inputSchema: Record<string, unknown>;
  name: string;
  title: string;
};

/**
 * Project a ToolDef onto the server MCP. Bridges the dispatcher's positional `(args, request)`
 * call to `execute(args, ctx)`. Args are passed through UN-validated — the MCP does not validate
 * today; the limit tools clamp inside `execute`, so a tolerant clamp is preserved (no throwing
 * parse). `ctx.transport` is "mcp".
 */
export function toMcpTool(def: ToolDef): McpToolDescriptor {
  return {
    description: def.description,
    execute: (args, request) => def.execute(args, { request, transport: "mcp" }),
    inputSchema: toInputJsonSchema(def),
    name: def.name,
    title: def.title,
  };
}

/**
 * Project a ToolDef onto ChatDnB's AI-SDK tool set. The Zod object goes STRAIGHT to `ai`'s
 * `tool({ inputSchema })` — never through JSON Schema, which erases the `z.infer` arg typing. The
 * SDK's `abortSignal` maps to `ctx.signal`; `ctx.transport` is "chat". `request` is threaded from
 * the gated /api/chat route so the WRITE tools have the submitter hash / rate-limit context the AI
 * SDK's `execute` options do not carry (the SDK gives no inbound `Request`).
 */
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

/**
 * Every shared chat tool, as a literal-keyed object so `InferUITools` keeps each tool's precise
 * types. `request` is threaded onto every tool's `ctx` (the writes need it; the reads ignore it),
 * so ChatDnB now exposes the full archive read set + the two writes from one source of truth.
 */
export function sharedChatTools(request?: Request) {
  return {
    build_set: toAiSdkTool(buildSetTool, request),
    get_artist: toAiSdkTool(getArtistTool, request),
    get_label: toAiSdkTool(getLabelTool, request),
    get_random_track: toAiSdkTool(getRandomTrackTool, request),
    get_similar_artists: toAiSdkTool(getSimilarArtistsTool, request),
    get_status: toAiSdkTool(getStatusTool, request),
    get_track: toAiSdkTool(getTrackTool, request),
    list_fresh: toAiSdkTool(listFreshTool, request),
    list_tracks: toAiSdkTool(listTracksTool, request),
    search_archive: toAiSdkTool(searchArchiveTool, request),
    submit_track: toAiSdkTool(submitTrackTool, request),
    subscribe_newsletter: toAiSdkTool(subscribeNewsletterTool, request),
  };
}
