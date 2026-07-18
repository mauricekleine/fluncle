// The client-safe half of the shared tool registry — every field of a tool EXCEPT its
// server-side `execute`.
//
// ── WHY THIS IS SPLIT OUT ────────────────────────────────────────────────────────────
// The in-page WebMCP surface (lib/webmcp.ts) is bundled into the BROWSER. It needs each
// shared tool's name + description + JSON-Schema, but it must NOT drag the server-only
// `execute` closures (which import Turso, the audio pipeline, etc.) into the client bundle.
// So the tool SPEC (name/title/description/input/tier/access/effect/transports/project) lives
// here with zero server imports, and the server `execute` + adapters live in ./registry.ts,
// which imports these specs and attaches an `execute` to each. WebMCP imports only from this
// file; the MCP server and ChatDnB import the full ToolDefs from ./registry.ts.

import { z } from "zod";

// ── Shared types ─────────────────────────────────────────────────────────────────────

/** Where a tool may appear. `chat` is ChatDnB's AI-SDK tool set; `mcp`/`webmcp` the two MCPs. */
export type Transport = "mcp" | "chat" | "webmcp";

/** The grounding class a tool belongs to (Unit A taxonomy). */
export type ToolTier = "lore-canon" | "catalogue" | "system";

/**
 * The CLOSED set of output shapes a tool projects to — not a free-form per-tool function, so
 * divergence stays reviewable. `publicRecord` = the MCP full public record; `compactCard` =
 * ChatDnB's compact finding card; `twoBucket` = the (findings, catalogue) split (PR-4); and
 * `identity` = a status summary. The tag names WHICH shape a transport realizes; the server
 * `execute` produces it (switching on `ctx.transport`).
 */
export type Projection = "publicRecord" | "compactCard" | "twoBucket" | "identity";

/** Whether a tool needs a session. AUTHORED INDEPENDENTLY of `transports` (the auth cross-check). */
export type ToolAccess = "public" | "session";

/** A read never mutates; a write receives `ctx.request` and mutates user-owned state. */
export type ToolEffect = "read" | "write";

/**
 * Retain a spec's CONCRETE input-schema type (so ChatDnB's `tool()` keeps precise arg typing)
 * while type-checking every field against {@link ToolSpec}. `: ToolSpec` would erase the schema
 * to the base `z.ZodType`, which `ai`'s `tool()` rejects; `satisfies` alone would widen the
 * `transports`/`project` string literals, so this contextual-typing helper does both jobs.
 */
export function defineSpec<In extends z.ZodType>(spec: ToolSpec<In>): ToolSpec<In> {
  return spec;
}

/** One archive verb's transport-independent spec — everything but its server `execute`. */
export type ToolSpec<In extends z.ZodType = z.ZodType> = {
  /** verb_noun — the cross-surface identity (docs/naming-conventions.md, Convention B). */
  name: string;
  /** The MCP `title` (a short human label). */
  title: string;
  /** The shared, model-facing description. */
  description: string;
  /** The ONE canonical Zod input schema — the source of truth for every transport's schema. */
  input: In;
  /** The grounding class. */
  tier: ToolTier;
  /** public | session — authored independently of `transports`. */
  access: ToolAccess;
  /** read | write. */
  effect: ToolEffect;
  /** Where this tool may appear. */
  transports: Transport[];
  /** The output shape each transport realizes (a closed, reviewable set). */
  project: Partial<Record<Transport, Projection>>;
};

// ── The five overlapping tool specs ──────────────────────────────────────────────────
//
// One name/title/description/input, single-sourced. INPUT decisions (resolved by the operator):
// `get_track`'s canonical arg is `idOrLogId`; `list_fresh` caps at 100 everywhere; `list_tracks`'
// limit is an integer.

/** The recent-window list cap (1..48, default 10) — MCP + chat already agreed here. */
export const MAX_RECENT_LIMIT = 48;

/**
 * The fresh-list cap. Mirrors ./fresh.ts's `FRESH_TRACKS_MAX` (a server-only module, so the value
 * is duplicated here for the client bundle; the registry test asserts the two stay equal).
 */
export const FRESH_LIMIT_MAX = 100;

export const listTracksSpec = defineSpec({
  access: "public",
  description:
    "List the most recent findings and mixtapes in Fluncle's drum & bass archive, newest first. Dates mark when each was found or published into the spine.",
  effect: "read",
  input: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_RECENT_LIMIT)
      .optional()
      .describe("How many tracks to return (1 to 48, default 10)."),
  }),
  name: "list_tracks",
  project: { chat: "compactCard", mcp: "publicRecord", webmcp: "publicRecord" },
  tier: "lore-canon",
  title: "Recent findings",
  transports: ["mcp", "chat", "webmcp"],
});

export const listFreshSpec = defineSpec({
  access: "public",
  description:
    "List the newest drum & bass RELEASES across Fluncle's archive: every track that came OUT in the trailing 30-day window, freshest release first. These are ordered by RELEASE date (when a track landed), not by when Fluncle found it, so do not say Fluncle found them, only that they just came out. Certified findings carry a Log ID coordinate and cover art; the quieter uncertified rows carry neither.",
  effect: "read",
  input: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(FRESH_LIMIT_MAX)
      .optional()
      .describe(`How many releases to return (1 to ${FRESH_LIMIT_MAX}).`),
  }),
  name: "list_fresh",
  project: { chat: "compactCard", mcp: "publicRecord", webmcp: "publicRecord" },
  tier: "lore-canon",
  title: "Fresh releases",
  transports: ["mcp", "chat", "webmcp"],
});

export const getTrackSpec = defineSpec({
  access: "public",
  description:
    "Read one finding (or mixtape) in full by its Log ID coordinate or Spotify track id. Returns the same public record its /log page shows: artist, title, Found date, note, BPM, key, links, galaxy, and the recovered observation transcript. The resource form is fluncle://finding/<logId>.",
  effect: "read",
  input: z.object({
    idOrLogId: z
      .string()
      .describe("A Log ID coordinate (e.g. 012.8.0A) or a Spotify track id / URL."),
  }),
  name: "get_track",
  project: { chat: "compactCard", mcp: "publicRecord", webmcp: "publicRecord" },
  tier: "lore-canon",
  title: "Read one finding",
  transports: ["mcp", "chat", "webmcp"],
});

export const getRandomTrackSpec = defineSpec({
  access: "public",
  description: "Pull one random certified track from Fluncle's archive.",
  effect: "read",
  input: z.object({}),
  name: "get_random_track",
  project: { chat: "compactCard", mcp: "publicRecord", webmcp: "publicRecord" },
  tier: "lore-canon",
  title: "Random finding",
  transports: ["mcp", "chat", "webmcp"],
});

export const getStatusSpec = defineSpec({
  access: "public",
  description:
    "Check whether all of Fluncle's systems are operational. Returns an overall ok flag, a one-line headline, and the current status of each service (the website, the API, the media zone, the SSH terminal, the DNS zone, the Tor mirror, the render box, and the on-box prober). Read-only; the same health the public /status page shows.",
  effect: "read",
  input: z.object({}),
  name: "get_status",
  // Codified OFF WebMCP: the browser read path is get_track. MCP + chat only.
  project: { chat: "identity", mcp: "identity" },
  tier: "system",
  title: "Are all systems up?",
  transports: ["mcp", "chat"],
});

/** The five overlapping tool specs. Order: `list_tracks` first (the MCP/WebMCP alias clones it). */
export const SHARED_TOOL_SPECS: ToolSpec[] = [
  listTracksSpec,
  listFreshSpec,
  getTrackSpec,
  getRandomTrackSpec,
  getStatusSpec,
];

// ── The JSON-Schema bridge + the WebMCP adapter (client-safe) ─────────────────────────

/**
 * The advertised JSON Schema for a tool's input. `unrepresentable: "any"` degrades a future
 * exotic type to `{}` rather than throwing the whole tools/list; the explicit-opts form
 * deliberately omits `additionalProperties: false` (RFC Unit A).
 */
export function toInputJsonSchema(spec: ToolSpec): Record<string, unknown> {
  return z.toJSONSchema(spec.input, {
    io: "input",
    target: "draft-2020-12",
    unrepresentable: "any",
  }) as Record<string, unknown>;
}

/** The WebMCP tool shape (mirrors lib/webmcp.ts's `WebMcpTool`). */
export type WebMcpToolDescriptor = {
  description: string;
  execute: (input: Record<string, unknown>) => Promise<{
    content: Array<{ text: string; type: "text" }>;
  }>;
  inputSchema: Record<string, unknown>;
  name: string;
};

/**
 * Project a tool spec onto the in-page WebMCP surface. The browser has no in-process server
 * functions, so it keeps its own hand-written HTTP `execute` (`httpExecute`); only the shared
 * name + description + JSON-Schema come from the registry.
 */
export function toWebMcpTool(
  spec: ToolSpec,
  httpExecute: WebMcpToolDescriptor["execute"],
): WebMcpToolDescriptor {
  return {
    description: spec.description,
    execute: httpExecute,
    inputSchema: toInputJsonSchema(spec),
    name: spec.name,
  };
}
