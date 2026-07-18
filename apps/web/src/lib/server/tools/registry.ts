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

import { liveSurfaces } from "@fluncle/registry";
import { tool } from "ai";
import { type z } from "zod";
import { logPageUrl } from "../../fluncle-links";
import { type MixtapeDTO, mixtapeDisplayTitle } from "../../mixtapes";
import { type FreshTrack, listFreshTracks } from "../fresh";
import { resolveLogPageTarget } from "../log-resolver";
import { ApiError } from "../spotify";
import { getServiceStatuses, type ServiceHealthStatus } from "../status";
import {
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

/** The five overlapping tools, single-sourced. Order: `list_tracks` first (the MCP alias clones it). */
export const SHARED_TOOLS: ToolDef[] = [
  listTracksTool,
  listFreshTool,
  getTrackTool,
  getRandomTrackTool,
  getStatusTool,
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
 * SDK's `abortSignal` maps to `ctx.signal`; `ctx.transport` is "chat".
 */
export function toAiSdkTool<In extends z.ZodType>(def: {
  description: string;
  execute: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>;
  input: In;
}) {
  return tool({
    description: def.description,
    execute: async (args: z.infer<In>, options: { abortSignal?: AbortSignal }) =>
      def.execute(args as Record<string, unknown>, {
        signal: options?.abortSignal,
        transport: "chat",
      }),
    inputSchema: def.input,
  });
}

/**
 * The five shared tools projected onto ChatDnB, as a literal-keyed object so `InferUITools` keeps
 * each tool's precise types when chat.ts spreads it alongside its chat-only tools.
 */
export function sharedChatTools() {
  return {
    get_random_track: toAiSdkTool(getRandomTrackTool),
    get_status: toAiSdkTool(getStatusTool),
    get_track: toAiSdkTool(getTrackTool),
    list_fresh: toAiSdkTool(listFreshTool),
    list_tracks: toAiSdkTool(listTracksTool),
  };
}
