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
 * divergence stays reviewable. The tag names WHICH shape a transport realizes; the server
 * `execute` produces it (branching on `ctx.transport` only where the shapes actually differ).
 *
 *   - `publicRecord`   — the MCP's full public record (a finding, or a whole `SearchResult` with
 *                        BOTH registers certified-tagged).
 *   - `compactCard`    — ChatDnB's compact finding card (list_tracks/list_fresh, and chat's
 *                        findings-only `search_archive` until PR-4).
 *   - `twoBucket`      — the (findings, catalogue) split (PR-4).
 *   - `identity`       — a status summary.
 *   - `entityCard`     — an artist/label dossier card (its findings + socials/aliases + slug).
 *   - `chainCard`      — a `build_set` mix chain (seed + ordered steps + the `/mix` setUrl).
 *   - `neighbourList`  — a `get_similar_artists` list of nearest artist entities.
 *   - `acknowledgement`— a write's `{ ok }` receipt (a submission id, a newsletter board).
 */
export type Projection =
  | "acknowledgement"
  | "chainCard"
  | "compactCard"
  | "entityCard"
  | "identity"
  | "neighbourList"
  | "publicRecord"
  | "twoBucket";

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
  // Chat splits the fresh list into two registers (PR-4): certified findings + the unlit catalogue
  // rows. The MCP world-serves the whole flat list, each row certified-tagged.
  project: { chat: "twoBucket", mcp: "publicRecord", webmcp: "publicRecord" },
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

// ── The archive-read tools that used to live only in ChatDnB ─────────────────────────
//
// PR-2 lifts these into the shared registry so the MCP (and, where a public HTTP twin exists,
// WebMCP) gains a real ARCHIVE search + the entity/dossier reads its Spotify-only `search_tracks`
// never had. The descriptions are shared, model-facing, and register-neutral — the certified /
// catalogue register discipline lives in ChatDnB's system prompt (the MCP has no model prose), not
// in the tool text, so nothing here teaches a tier (DESIGN.md Unlit Rule).

export const searchArchiveSpec = defineSpec({
  access: "public",
  description:
    "Search Fluncle's drum & bass archive. Handles a name, a label, a key or BPM ask, or 'sounds like <a real track>' (it anchors on a real finding and returns the sonically nearest). An empty result means nothing in the archive matched.",
  effect: "read",
  input: z.object({
    query: z
      .string()
      .min(2)
      .describe("What to dig for — a name, a label, a key/BPM, or 'sounds like <track>'."),
  }),
  name: "search_archive",
  // Chat splits the result into two registers (PR-4): certified findings + unlit catalogue rows.
  // The MCP world-serves the whole SearchResult, both registers certified-tagged; WebMCP reads the
  // public GET /api/v1/search/archive twin.
  project: { chat: "twoBucket", mcp: "publicRecord", webmcp: "publicRecord" },
  tier: "lore-canon",
  title: "Search the archive",
  transports: ["mcp", "chat", "webmcp"],
});

export const getArtistSpec = defineSpec({
  access: "public",
  description:
    "Look up one artist Fluncle has logged, BY NAME (e.g. Netsky). Returns his certified findings from that artist, plus their public socials and the slug of their page. Returns nothing — he has not logged them — when there is no certified finding from that name.",
  effect: "read",
  input: z.object({
    name: z.string().min(1).describe("The artist's name, as it reads on a finding (e.g. Netsky)."),
  }),
  name: "get_artist",
  // MCP + chat only. The public GET /api/v1/artists/{slug} twin takes a pre-computed SLUG (not the
  // tool's `name`) and returns a much thinner shape (no findings/socials); resolving name→slug in
  // the browser risks a stored-slug mismatch, and this PR adds no name-keyed public endpoint. A
  // codified asymmetry, like get_status off WebMCP.
  project: { chat: "entityCard", mcp: "entityCard" },
  tier: "lore-canon",
  title: "Look up an artist",
  transports: ["mcp", "chat"],
});

export const getLabelSpec = defineSpec({
  access: "public",
  description:
    "Look up one label Fluncle has logged, BY NAME (e.g. Hospital Records). Returns his certified findings on that label, plus any confirmed alternate spellings and the slug of its page. Returns nothing — he has found nothing on it — when there is no certified finding on that name.",
  effect: "read",
  input: z.object({
    name: z
      .string()
      .min(1)
      .describe("The label's name, as it reads on a finding (e.g. Hospital Records)."),
  }),
  name: "get_label",
  // MCP + chat only: there is no public GET /labels/{slug} JSON twin for WebMCP to call, and this
  // PR adds no new HTTP endpoint (a codified asymmetry, like get_status off WebMCP).
  project: { chat: "entityCard", mcp: "entityCard" },
  tier: "lore-canon",
  title: "Look up a label",
  transports: ["mcp", "chat"],
});

export const buildSetSpec = defineSpec({
  access: "public",
  description:
    "Chain a mixable set from one of Fluncle's findings. Give it a starting finding — a Log ID coordinate he has logged (e.g. 004.7.2I) or a track name — and it returns an ordered set of what mixes in cleanly after it, each step carrying the REASON it mixes (same key, next key over, tempo locked), never a number. It starts from a finding, and returns nothing when he has not logged a starting point.",
  effect: "read",
  input: z.object({
    seed: z
      .string()
      .min(1)
      .describe("A finding to start from — a Log ID coordinate (004.7.2I) or a track name."),
  }),
  name: "build_set",
  // MCP + chat only: build_set takes a name/coordinate and returns a reasoned set with a /mix
  // handoff — there is no single public HTTP endpoint that IS that operation (the mixable rail is a
  // different op, coordinate-in, no setUrl), and this PR adds none. A codified asymmetry.
  project: { chat: "chainCard", mcp: "chainCard" },
  tier: "lore-canon",
  title: "Build a mixable set",
  transports: ["mcp", "chat"],
});

/** How many nearest artists `get_similar_artists` returns by default / at most. */
export const SIMILAR_ARTISTS_DEFAULT = 4;
export const SIMILAR_ARTISTS_MAX = 12;

export const getSimilarArtistsSpec = defineSpec({
  access: "public",
  description:
    "Given an artist Fluncle has logged, BY NAME (e.g. Koven), return the artists whose sound sits nearest to theirs across his findings. Naming an artist is always allowed. Returns nothing when the name resolves to no artist he has logged, and an empty list when he has one but nothing near it yet.",
  effect: "read",
  input: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(SIMILAR_ARTISTS_MAX)
      .optional()
      .describe(`How many nearest artists to return (1 to ${SIMILAR_ARTISTS_MAX}, default 4).`),
    name: z.string().min(1).describe("The artist's name, as it reads on a finding (e.g. Koven)."),
  }),
  name: "get_similar_artists",
  // MCP + chat only: the neighbour read is not on a public HTTP op yet (only the artist-page
  // loader), and this PR adds none — the same codified asymmetry as get_status.
  project: { chat: "neighbourList", mcp: "neighbourList" },
  tier: "lore-canon",
  title: "Artists like this one",
  transports: ["mcp", "chat"],
});

// ── The catalogue browse tools (PR-5) ────────────────────────────────────────────────
//
// Three name→slug→id reads over the existing anti-join catalogue reads. Each returns an album's /
// artist's / label's records that Fluncle knows are out there but has never certified — a
// catalogue-only result BY CONSTRUCTION (the reads anti-join findings). Chat gets the catalogue-only
// two-bucket ({ findings: [], catalogue }), which renders bare/unheaded (the Unlit Rule); the MCP
// world-serves the flat catalogue list, each row certified-tagged (like list_fresh). MCP + chat
// only, like get_artist/get_label/build_set — there is no name-keyed public HTTP endpoint for these
// (the web reads take a pre-computed slug), and this PR adds none. A codified WebMCP asymmetry.
//
// `tier: "catalogue"` — unlike search_archive/list_fresh (both registers ⇒ lore-canon), a browse
// returns ONLY the catalogue register. The descriptions signal that register ("named and listed,
// never spoken as found") without naming a leakable tier-noun or any mechanism (the Flat Copy Test).

export const listAlbumCatalogueSpec = defineSpec({
  access: "public",
  description:
    "List the tracks on one album Fluncle knows, BY NAME (e.g. Colours). These are records he knows are out there but has never certified as a finding: named and listed only, never spoken as found. Each row carries its artists, its title, and a way to hear it, nothing more. Returns nothing when the name matches no album he knows.",
  effect: "read",
  input: z.object({
    name: z.string().min(1).describe("The album's title, as it reads on a record (e.g. Colours)."),
  }),
  name: "list_album_catalogue",
  project: { chat: "twoBucket", mcp: "publicRecord" },
  tier: "catalogue",
  title: "An album's catalogue",
  transports: ["mcp", "chat"],
});

export const listArtistCatalogueSpec = defineSpec({
  access: "public",
  description:
    "List one artist's tracks Fluncle knows but has never made a finding, BY NAME (e.g. Netsky). These are records of theirs he knows are out there but has never certified: named and listed only, never spoken as found. Each row carries the artists, the title, and a way to hear it, nothing more. Returns nothing when the name matches no artist he knows.",
  effect: "read",
  input: z.object({
    name: z.string().min(1).describe("The artist's name, as it reads on a finding (e.g. Netsky)."),
  }),
  name: "list_artist_catalogue",
  project: { chat: "twoBucket", mcp: "publicRecord" },
  tier: "catalogue",
  title: "An artist's catalogue",
  transports: ["mcp", "chat"],
});

export const listLabelCatalogueSpec = defineSpec({
  access: "public",
  description:
    "List the tracks on one label Fluncle knows but has never made a finding, BY NAME (e.g. Hospital Records). These are records on it he knows are out there but has never certified: named and listed only, never spoken as found. Each row carries the artists, the title, and a way to hear it, nothing more. Returns nothing when the name matches no label he knows.",
  effect: "read",
  input: z.object({
    name: z
      .string()
      .min(1)
      .describe("The label's name, as it reads on a finding (e.g. Hospital Records)."),
  }),
  name: "list_label_catalogue",
  project: { chat: "twoBucket", mcp: "publicRecord" },
  tier: "catalogue",
  title: "A label's catalogue",
  transports: ["mcp", "chat"],
});

// ── The write tools (public writes, gated per surface) ───────────────────────────────
//
// Anonymous on the MCP exactly as they were before this PR (the /mcp endpoint has no session);
// on ChatDnB they ride the gated route (session + verified email + CSRF + dual rate dials), which
// is strictly safer. `effect: "write"` marks that they receive `ctx.request` (the submitter hash /
// rate limit). `access: "public"` — they mutate no session-owned state; the auth cross-field test
// asserts no `access: "session"` tool is ever realized onto the MCP.

export const submitTrackSpec = defineSpec({
  access: "public",
  description:
    "Submit a track to Fluncle for review by Spotify track URL. Fluncle gives it a listen before anything publishes. Limited to 5 submissions per connection per hour.",
  effect: "write",
  input: z.object({
    contact: z
      .string()
      .max(120)
      .optional()
      .describe("Optional: where to reach the submitter (max 120 characters)."),
    note: z
      .string()
      .max(500)
      .optional()
      .describe("Optional: tell Fluncle why it's a banger (max 500 characters)."),
    spotifyUrl: z.string().describe("Spotify track URL, e.g. https://open.spotify.com/track/..."),
  }),
  name: "submit_track",
  project: { chat: "acknowledgement", mcp: "acknowledgement", webmcp: "acknowledgement" },
  tier: "system",
  title: "Submit a track",
  transports: ["mcp", "chat", "webmcp"],
});

export const subscribeNewsletterSpec = defineSpec({
  access: "public",
  description:
    "Subscribe an email address to Fluncle's newsletter. Fresh bangers, every Friday, from Fluncle.",
  effect: "write",
  input: z.object({
    email: z.email().describe("The email address boarding the mothership."),
  }),
  name: "subscribe_newsletter",
  project: { chat: "acknowledgement", mcp: "acknowledgement", webmcp: "acknowledgement" },
  tier: "system",
  title: "Subscribe to the newsletter",
  transports: ["mcp", "chat", "webmcp"],
});

/**
 * Every shared tool spec, single-sourced. Order: `list_tracks` first (the MCP/WebMCP alias clones
 * it). The five overlapping read tools, then the reads PR-2 lifted out of ChatDnB, then the PR-5
 * catalogue browse reads, then the writes.
 */
export const SHARED_TOOL_SPECS: ToolSpec[] = [
  listTracksSpec,
  listFreshSpec,
  getTrackSpec,
  getRandomTrackSpec,
  getStatusSpec,
  searchArchiveSpec,
  getArtistSpec,
  getLabelSpec,
  buildSetSpec,
  getSimilarArtistsSpec,
  listAlbumCatalogueSpec,
  listArtistCatalogueSpec,
  listLabelCatalogueSpec,
  submitTrackSpec,
  subscribeNewsletterSpec,
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
