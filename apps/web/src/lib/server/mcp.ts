import { liveSurfaces } from "@fluncle/registry";
import { logPageUrl, siteUrl, twitchUrl } from "../fluncle-links";
import { fluncleDescription } from "../identity";
import { type FeedItem, type MixtapeDTO, mixtapeDisplayTitle } from "../mixtapes";
import { getLiveState, type LiveState } from "./live";
import { resolveMusicTarget } from "./log-resolver";
import { subscribeToNewsletter } from "./newsletter";
import { ApiError, searchTrackCandidates } from "./spotify";
import { getServiceStatuses, type ServiceHealthStatus } from "./status";
import { createSubmission } from "./submissions";
import { getRandomTrack, listTracks, type TrackListItem, toPublicTrackListItem } from "./tracks";

// A small, stateless Model Context Protocol server: the same drum & bass
// archive the public API exposes, handed to agents over the Streamable HTTP
// transport (a single JSON-RPC endpoint at /mcp). No sessions, no Durable
// Objects — every request is self-contained, so it runs anywhere the Worker
// does. It speaks the full protocol, not just tools:
//   - TOOLS (tools/list, tools/call): the archive as verbs — list, read one,
//     pull a random one, check systems, search Spotify, submit, subscribe. A
//     thin layer over the internal functions the /api routes already use, so
//     behaviour (validation, rate limits, the submitter hash) stays identical.
//   - RESOURCES (resources/list, resources/read): the archive as a readable
//     CORPUS — each finding/mixtape addressable at its coordinate
//     (fluncle://finding/<logId>, fluncle://mixtape/<logId>), returning only
//     the PUBLIC record its /log page shows.
//   - PROMPTS (prompts/list, prompts/get): Fluncle-voiced starting points an
//     agent can run against the tools + resources above.
// The matching MCP Server Card (SEP-2127) is served at
// /.well-known/mcp/server-card.json for agent discovery.
//
// The browser-side WebMCP surface (lib/webmcp.ts) mirrors this TOOL set for
// agent-driving browsers; keep the two in step when the tools change. Resources
// and prompts have no navigator.modelContext primitive, so they are server-MCP
// only (webmcp.ts documents the asymmetry) — the browser read path is the
// mirrored get_track tool.

const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
// Reverse-DNS server name (SEP-2127 requires exactly one "/"); the short
// identifier matches the published fluncle-api agent skill.
const SERVER_NAME = "com.fluncle/fluncle-api";
const SERVER_VERSION = "1.0.0";
const MCP_ENDPOINT = `${siteUrl}/mcp`;

const defaultRecentLimit = 10;
const maxRecentLimit = 48;
const minQueryLength = 2;
// How many recent findings/mixtapes resources/list advertises — the same window
// as the RSS feed and the markdown homepage, newest first.
const resourceListLimit = 25;

type JsonRpcId = number | string | null;

type JsonRpcSuccess = { id: JsonRpcId; jsonrpc: "2.0"; result: unknown };

type JsonRpcFailure = {
  error: { code: number; data?: unknown; message: string };
  id: JsonRpcId;
  jsonrpc: "2.0";
};

type JsonRpcResponse = JsonRpcFailure | JsonRpcSuccess;

type ToolResult = {
  content: Array<{ text: string; type: "text" }>;
  isError: boolean;
};

type McpTool = {
  // A deprecated alias kept in tools/list for a deprecation window. Convention B
  // renamed `get_recent_tracks` → `list_tracks`;
  // existing agents still calling the old name resolve to the same execute.
  deprecated?: boolean;
  description: string;
  execute: (args: Record<string, unknown>, request: Request) => Promise<unknown>;
  inputSchema: Record<string, unknown>;
  name: string;
  title: string;
};

const tools: McpTool[] = [
  {
    description:
      "List the most recent findings and mixtapes in Fluncle's drum & bass archive, newest first. Dates mark when each was found or published into the spine.",
    execute: async (args) => {
      const page = await listTracks({ includeMixtapes: true, limit: clampLimit(args.limit) });

      // Strip the private capture key before the archive world-serves to the agent.
      return { ...page, tracks: page.tracks.map(toPublicTrackListItem) };
    },
    inputSchema: {
      properties: {
        limit: {
          description: "How many tracks to return (1 to 48, default 10).",
          maximum: maxRecentLimit,
          minimum: 1,
          type: "number",
        },
      },
      type: "object",
    },
    name: "list_tracks",
    title: "Recent findings",
  },
  {
    description:
      "Read one finding (or mixtape) in full by its Log ID coordinate or Spotify track id. Returns the same public record its /log page shows: artist, title, Found date, note, BPM, key, links, galaxy, and the recovered observation transcript. The resource form is fluncle://finding/<logId>.",
    execute: async (args) => {
      const idOrLogId = asTrimmedString(args.idOrLogId);

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
    inputSchema: {
      properties: {
        idOrLogId: {
          description: "A Log ID coordinate (e.g. 012.8.0A) or a Spotify track id / URL.",
          type: "string",
        },
      },
      required: ["idOrLogId"],
      type: "object",
    },
    name: "get_track",
    title: "Read one finding",
  },
  {
    description: "Pull one random certified track from Fluncle's archive.",
    execute: async () => {
      const track = await getRandomTrack();

      return track
        ? { ok: true, track: toPublicTrackListItem(track) }
        : { code: "track_not_found", message: "No tracks found", ok: false };
    },
    inputSchema: { properties: {}, type: "object" },
    name: "get_random_track",
    title: "Random finding",
  },
  {
    description:
      "Check whether all of Fluncle's systems are operational. Returns an overall ok flag, a one-line headline, and the current status of each service (the website, the API, the media zone, the SSH terminal, the DNS zone, the Tor mirror, the render box, and the on-box prober). Read-only; the same health the public /status page shows.",
    execute: async () => summarizeStatus(),
    inputSchema: { properties: {}, type: "object" },
    name: "get_status",
    title: "Are all systems up?",
  },
  {
    description:
      "Search Spotify for track candidates by name or Spotify track URL. Use a result's id and spotifyUrl with submit_track.",
    execute: async (args) => {
      const query = asTrimmedString(args.query);

      if (query.length < minQueryLength) {
        throw new ApiError("invalid_query", "Search query must be at least 2 characters", 400);
      }

      return { ok: true, results: await searchTrackCandidates(query) };
    },
    inputSchema: {
      properties: {
        query: {
          description: "Track search query or Spotify track URL, minimum 2 characters.",
          minLength: minQueryLength,
          type: "string",
        },
      },
      required: ["query"],
      type: "object",
    },
    name: "search_tracks",
    title: "Search tracks",
  },
  {
    description:
      "Submit a track to Fluncle for review by Spotify track URL. Fluncle gives it a listen before anything publishes. Limited to 5 submissions per connection per hour.",
    execute: async (args, request) => {
      const spotifyUrl = asTrimmedString(args.spotifyUrl);

      if (!spotifyUrl) {
        throw new ApiError("invalid_query", "A Spotify track URL is required", 400);
      }

      const results = await searchTrackCandidates(spotifyUrl);
      const candidate = results[0];

      if (!candidate) {
        throw new ApiError("track_not_found", "No track matched that Spotify URL", 404);
      }

      const submission = await createSubmission(
        {
          album: candidate.album,
          artists: candidate.artists,
          artworkUrl: candidate.artworkUrl,
          contact: optionalString(args.contact),
          note: optionalString(args.note),
          source: "web",
          spotifyTrackId: candidate.id,
          spotifyUrl: candidate.spotifyUrl,
          title: candidate.title,
        },
        request,
      );

      return { ok: true, submission };
    },
    inputSchema: {
      properties: {
        contact: {
          description: "Optional: where to reach the submitter (max 120 characters).",
          maxLength: 120,
          type: "string",
        },
        note: {
          description: "Optional: tell Fluncle why it's a banger (max 500 characters).",
          maxLength: 500,
          type: "string",
        },
        spotifyUrl: {
          description: "Spotify track URL, e.g. https://open.spotify.com/track/...",
          type: "string",
        },
      },
      required: ["spotifyUrl"],
      type: "object",
    },
    name: "submit_track",
    title: "Submit a track",
  },
  {
    description:
      "Subscribe an email address to Fluncle's newsletter. Fresh bangers, every Friday, from Fluncle.",
    execute: async (args, request) => {
      await subscribeToNewsletter({ email: asTrimmedString(args.email) }, request);

      return { ok: true };
    },
    inputSchema: {
      properties: {
        email: {
          description: "The email address boarding the mothership.",
          format: "email",
          type: "string",
        },
      },
      required: ["email"],
      type: "object",
    },
    name: "subscribe_newsletter",
    title: "Subscribe to the newsletter",
  },
];

// `get_recent_tracks` deprecation alias of `list_tracks` (Convention B §4). Shares
// the canonical tool's execute + schema so the two never drift; kept in tools/list
// for a deprecation window so agents pinned to the old name keep working.
const listTracksTool = tools[0];

if (!listTracksTool) {
  throw new Error("list_tracks tool missing from the MCP tool list");
}

tools.push({
  ...listTracksTool,
  deprecated: true,
  description: `[Deprecated: use list_tracks] ${listTracksTool.description}`,
  name: "get_recent_tracks",
});

// ── Resources: the archive as a readable corpus ────────────────────────────
//
// Every finding/mixtape with a coordinate is addressable at its own MCP resource
// URI. resources/list advertises the recent window; resources/read returns the
// PUBLIC record — deliberately the same fields /log/<id> renders (and, for the
// observation, the transcript /radio renders), never the private capture key,
// the internal enrichment/video fields, or the raw vibe coordinates. The typed
// URIs (fluncle://finding/…, fluncle://mixtape/…) let an agent see the kind
// before reading; the read also accepts the bare fluncle://<logId> display form.

const RESOURCE_SCHEME = "fluncle://";

type ResolvedRecord =
  | { kind: "finding"; record: ReturnType<typeof publicFindingRecord> }
  | { kind: "mixtape"; record: ReturnType<typeof publicMixtapeRecord> };

// Resolve a coordinate (Log ID) or Spotify track id to its public MUSIC record, reusing
// the same music resolver the /log page reads through, so MCP and the web never drift.
async function readCoordinate(idOrLogId: string): Promise<ResolvedRecord | undefined> {
  const target = await resolveMusicTarget(idOrLogId);

  if (!target) {
    return undefined;
  }

  return target.kind === "mixtape"
    ? { kind: "mixtape", record: publicMixtapeRecord(target.mixtape) }
    : { kind: "finding", record: publicFindingRecord(target.track) };
}

// The resource URI for a coordinated item, typed by kind so an agent reads intent
// off the URI (fluncle://finding/012.8.0A). Mixtapes carry an F-marked Log ID.
function resourceUri(kind: "finding" | "mixtape", logId: string | undefined): string | undefined {
  return logId ? `${RESOURCE_SCHEME}${kind}/${logId}` : undefined;
}

// Pull the Log ID out of a resource URI. Accepts the typed forms
// (fluncle://finding/<id>, fluncle://mixtape/<id>) and the bare display form
// (fluncle://<id>); the kind prefix is advisory since the resolver dispatches on
// the coordinate itself. Returns undefined for anything not on the fluncle scheme.
function coordinateFromUri(uri: string): string | undefined {
  if (!uri.startsWith(RESOURCE_SCHEME)) {
    return undefined;
  }

  const path = uri.slice(RESOURCE_SCHEME.length);
  const typed = /^(?:finding|mixtape)\/(.+)$/.exec(path);
  const coordinate = (typed?.[1] ?? path).trim();

  return coordinate.length > 0 ? coordinate : undefined;
}

// The list-descriptor for one coordinated item: name is "Artist — Title" (a
// mixtape reads "Fluncle — <title>"), description is the note's first line.
function resourceDescriptor(item: FeedItem): {
  description?: string;
  mimeType: string;
  name: string;
  uri: string;
} {
  const isMixtape = item.type === "mixtape";
  const uri = resourceUri(isMixtape ? "mixtape" : "finding", item.logId);

  if (!uri) {
    throw new Error("resourceDescriptor called with an uncoordinated item");
  }

  const name = isMixtape
    ? `Fluncle — ${mixtapeDisplayTitle(item.title)}`
    : `${item.artists.join(", ")} — ${item.title}`;
  const description = firstLine(item.note);

  return { mimeType: "application/json", name, uri, ...(description ? { description } : {}) };
}

// A finding's PUBLIC record — only the fields /log/<id> renders (plus the
// observation transcript, which /radio renders as visible + screen-reader text).
// toPublicTrackListItem strips the private full-song capture key first; the raw
// vibe coordinates, enrichment status, and internal video fields are never included.
function publicFindingRecord(item: TrackListItem) {
  const track = toPublicTrackListItem(item);

  return compact({
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
    links: compact({
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

// The recovered observation as a public sub-record: the audio URL (the /log audio
// element source) plus, when aligned, the transcript /radio renders. Absent when
// the finding has no observation.
function observationRecord(track: TrackListItem) {
  if (!track.observationAudioUrl) {
    return undefined;
  }

  const transcript = track.observationAlignment?.words
    .map((word) => word.text)
    .join(" ")
    .trim();

  return compact({
    audioUrl: track.observationAudioUrl,
    durationMs: track.observationDurationMs,
    transcript: transcript ? transcript : undefined,
  });
}

// A mixtape's PUBLIC record — the fields the /log mixtape plate renders: the
// checkpoint title, note, runtime, and the ordered tracklist of coordinated members.
function publicMixtapeRecord(mixtape: MixtapeDTO) {
  return compact({
    bangerCount: mixtape.memberCount,
    by: "Fluncle",
    coordinate: mixtape.logId,
    links: compact({
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
        compact({
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

// ── Prompts: Fluncle-voiced starting points ────────────────────────────────
//
// Each prompt expands to a single user message that tells the agent to work the
// tools + resources above and answer in Fluncle's voice (the recovered narrator —
// the warmth lives in what the agent PRODUCES, not in the machine-facing
// description, VOICE.md narrator rule). Named verb_noun like the tools.

type McpPrompt = {
  arguments: Array<{ description: string; name: string; required: boolean }>;
  build: (args: Record<string, unknown>) => string;
  description: string;
  name: string;
  title: string;
};

const prompts: McpPrompt[] = [
  {
    arguments: [
      {
        description:
          'The mood, moment, or feeling to match, e.g. "3am, still driving" or "euphoric".',
        name: "mood",
        required: true,
      },
    ],
    build: (args) => {
      const mood = asTrimmedString(args.mood) || "whatever you're feeling";

      return `A crew member wants a drum & bass tune for this mood: "${mood}".

Dig through Fluncle's archive to answer. Call list_tracks and get_random_track to range over it, read the contenders with get_track (or their fluncle://finding/<coordinate> resources), and lean on each finding's note, BPM, key, and galaxy. Pick the ONE that lands the mood best. Reply in a single warm line, the way Fluncle would text it to the crew: name the artist and title, drop its Log ID coordinate, and say in a breath why it's the one. No lists, no preamble.`;
    },
    description: "Match a mood to one finding from the archive, handed over in Fluncle's voice.",
    name: "recommend_finding",
    title: "Recommend a finding for a mood",
  },
  {
    arguments: [
      {
        description: "How many recent findings to walk (default 5).",
        name: "count",
        required: false,
      },
    ],
    build: (args) => {
      const count = clampPromptCount(args.count);

      return `Walk me through Fluncle's ${count} most recent findings, like a late-night dig.

Call list_tracks with limit ${count} to pull them, then read each one with get_track (or its fluncle://finding/<coordinate> resource). Go newest to oldest. For each, give one warm line in Fluncle's voice: the artist and title, its Log ID coordinate, and the one thing that made it worth logging. Keep the whole thing moving; end on where the night leaves you.`;
    },
    description: "Walk the most recent findings, one warm line each, in Fluncle's voice.",
    name: "walk_recent_night",
    title: "Walk a recent night's findings",
  },
  {
    arguments: [
      {
        description: "A Log ID coordinate, e.g. 012.8.0A or fluncle://012.8.0A.",
        name: "coordinate",
        required: true,
      },
    ],
    build: (args) => {
      const coordinate = asTrimmedString(args.coordinate) || "the one you're pointed at";

      return `Read the Fluncle finding at coordinate ${coordinate} and explain it to someone new.

Fetch it with get_track (or the fluncle://finding/<coordinate> resource). Then, in a few plain sentences in Fluncle's voice: what the tune is (artist, title), when he found it, why it's certified (use the note), and how to read the Log ID itself: the sector counts the days since the 2026-05-30 epoch, the tail is a stable signature of the recording, minted once and never changed. Keep it warm and short.`;
    },
    description: "Read the finding at a Log ID coordinate and explain the coordinate.",
    name: "decode_coordinate",
    title: "Decode a Log ID",
  },
];

// The recent-window count for walk_recent_night: a positive integer, clamped to the
// recent-list cap, defaulting to five when unset or unparseable.
function clampPromptCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(asTrimmedString(value), 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return 5;
  }

  return Math.min(parsed, maxRecentLimit);
}

// The first non-empty line of a note (the resource description). Undefined when the
// note is empty or absent, so the descriptor omits the field entirely.
function firstLine(note: string | undefined): string | undefined {
  const line = note
    ?.split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);

  return line && line.length > 0 ? line : undefined;
}

// Drop undefined values (and, at the top level, empty link/tracklist containers)
// so the served JSON carries only present, public fields.
function compact<T extends Record<string, unknown>>(record: T): Partial<T> {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);

  return Object.fromEntries(entries) as Partial<T>;
}

// The capabilities this server advertises — tools, resources, and prompts, none
// of which push list-changed notifications (the archive is polled, not subscribed).
// Shared by the initialize response and the server card so the two never drift.
const MCP_CAPABILITIES = {
  prompts: { listChanged: false },
  resources: { listChanged: false },
  tools: { listChanged: false },
} as const;

// The MCP Server Card (SEP-2127). Carries the canonical shape (top-level name,
// remotes, capabilities object) plus the looser serverInfo/transport fields
// some validators still expect, so one document satisfies both readings.
function serverCard() {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    capabilities: MCP_CAPABILITIES,
    description: fluncleDescription,
    icons: [{ mimeType: "image/png", sizes: ["1180x1180"], src: `${siteUrl}/fluncle.png` }],
    name: SERVER_NAME,
    remotes: [
      {
        authentication: { required: false },
        supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
        type: "streamable-http",
        url: MCP_ENDPOINT,
      },
    ],
    repository: { source: "github", url: "https://github.com/mauricekleine/fluncle" },
    serverInfo: {
      description: fluncleDescription,
      name: "fluncle-api",
      title: "Fluncle",
      version: SERVER_VERSION,
    },
    title: "Fluncle",
    transport: { endpoint: MCP_ENDPOINT, type: "streamable-http" },
    version: SERVER_VERSION,
    websiteUrl: siteUrl,
  };
}

// Entry point, mounted ahead of the router in server.ts. Returns a Response for
// the MCP endpoint and the server card, or undefined for any other path.
export async function handleMcp(request: Request): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);

  if (pathname === "/.well-known/mcp/server-card.json") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET");
    }

    return new Response(JSON.stringify(serverCard(), null, 2), {
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Content-Type": "application/json",
        ...corsHeaders(),
      },
    });
  }

  if (pathname !== "/mcp") {
    return undefined;
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(), status: 204 });
  }

  // We don't offer a server-initiated SSE stream; tools speak over POST only.
  if (request.method !== "POST") {
    return methodNotAllowed("POST, OPTIONS");
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return jsonRpcResponse(failure(null, -32700, "Parse error"), 400);
  }

  // JSON-RPC batches were dropped in 2025-06-18, but older clients may still
  // send them; handle an array as a courtesy, a single message otherwise.
  if (Array.isArray(payload)) {
    const responses = (
      await Promise.all(payload.map((message) => dispatch(message, request)))
    ).filter((response): response is JsonRpcResponse => response !== undefined);

    return responses.length === 0
      ? new Response(null, { headers: corsHeaders(), status: 202 })
      : jsonRpcResponse(responses);
  }

  const response = await dispatch(payload, request);

  // Notifications get no body, just an acknowledgement.
  return response === undefined
    ? new Response(null, { headers: corsHeaders(), status: 202 })
    : jsonRpcResponse(response);
}

async function dispatch(message: unknown, request: Request): Promise<JsonRpcResponse | undefined> {
  if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return failure(idOf(message), -32600, "Invalid Request");
  }

  const { method } = message;
  const params = isObject(message.params) ? message.params : undefined;
  const id = idOf(message);

  // Notifications (notifications/initialized, …) are acknowledged, not answered.
  if (method.startsWith("notifications/")) {
    return undefined;
  }

  switch (method) {
    case "initialize": {
      const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";

      return success(id, {
        capabilities: MCP_CAPABILITIES,
        instructions:
          "Fluncle's drum & bass archive over MCP. TOOLS: list recent findings, read one in full by coordinate, pull a random one, check whether all of Fluncle's systems are operational, search Spotify candidates, submit a track for review, or board the newsletter. RESOURCES: read the archive as a corpus, each finding/mixtape at fluncle://finding/<logId> or fluncle://mixtape/<logId>, its public record. PROMPTS: Fluncle-voiced starting points (recommend a finding for a mood, walk a recent night, decode a Log ID). A submission is a recommendation, not a publish; Fluncle listens before anything goes out.",
        protocolVersion: requested || PROTOCOL_VERSION,
        serverInfo: { name: SERVER_NAME, title: "Fluncle", version: SERVER_VERSION },
      });
    }
    case "ping":
      return success(id, {});
    case "tools/list":
      return success(id, {
        tools: tools.map((tool) => ({
          description: tool.description,
          inputSchema: tool.inputSchema,
          name: tool.name,
          title: tool.title,
        })),
      });
    case "resources/list": {
      const page = await listTracks({ includeMixtapes: true, limit: resourceListLimit });
      const resources = page.tracks
        .filter((item) => item.logId)
        .map((item) => resourceDescriptor(item));

      return success(id, { resources });
    }
    case "resources/read": {
      const uri = typeof params?.uri === "string" ? params.uri : "";
      const coordinate = coordinateFromUri(uri);

      if (!coordinate) {
        return failure(id, -32602, `Not a Fluncle resource URI: ${uri || "(missing)"}`);
      }

      const resolved = await readCoordinate(coordinate);

      if (!resolved) {
        // MCP's resource-not-found code, so a client can tell "no such coordinate"
        // apart from a malformed request.
        return failure(id, -32002, `No finding found at ${uri}`);
      }

      return success(id, {
        contents: [{ mimeType: "application/json", text: JSON.stringify(resolved.record), uri }],
      });
    }
    case "prompts/list":
      return success(id, {
        prompts: prompts.map((prompt) => ({
          arguments: prompt.arguments,
          description: prompt.description,
          name: prompt.name,
          title: prompt.title,
        })),
      });
    case "prompts/get": {
      const name = typeof params?.name === "string" ? params.name : "";
      const prompt = prompts.find((candidate) => candidate.name === name);

      if (!prompt) {
        return failure(id, -32602, `Unknown prompt: ${name || "(missing)"}`);
      }

      const args = isObject(params?.arguments) ? params.arguments : {};

      return success(id, {
        description: prompt.description,
        messages: [{ content: { text: prompt.build(args), type: "text" }, role: "user" }],
      });
    }
    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : "";
      const tool = tools.find((candidate) => candidate.name === name);

      if (!tool) {
        return success(
          id,
          toolResult({ code: "unknown_tool", message: `Unknown tool: ${name}`, ok: false }, true),
        );
      }

      const args = isObject(params?.arguments) ? params.arguments : {};

      try {
        // Read the live state alongside the tool call so a successful result can
        // carry the live-set note while Fluncle is on the decks (offline ⇒ no note).
        const [result, live] = await Promise.all([tool.execute(args, request), getLiveState()]);
        return success(id, toolResult(result, false, live));
      } catch (error) {
        if (error instanceof ApiError) {
          return success(
            id,
            toolResult({ code: error.code, message: error.message, ok: false }, true),
          );
        }

        return success(
          id,
          toolResult(
            {
              code: "error",
              message: error instanceof Error ? error.message : String(error),
              ok: false,
            },
            true,
          ),
        );
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

// One service in the get_status summary: the registry label, the raw service id,
// its three-state health, and the probe's short message (null when none).
type StatusService = {
  label: string;
  message: string | null;
  name: string;
  status: ServiceHealthStatus;
};

// A friendly label per `/status` service id, derived from the surfaces registry so
// the two never drift. The registry records each probed surface's `/status` service
// id in its operatorNotes (e.g. "Probed on /status as service `r2`"); we read that
// once and pair the id with the surface's first exposedContent line as a label. Keys
// the registry doesn't tag (the prober's own self-liveness, the box-reachability probe)
// fall back to a constant, so they read as their own distinct signal.
const SERVICE_PROBE_MARKER = /service `([a-z0-9-]+)`/i;
const registryServiceLabels: Record<string, string> = (() => {
  const labels: Record<string, string> = {
    // The rave-02 healthcheck cron's self-liveness — posted only by the prober, not
    // a registry surface, so it carries no operatorNotes marker.
    hermes: "the on-box prober (rave-02 healthcheck)",
    // The scale-to-zero render box's reachability (the conductor state file). A
    // DIFFERENT signal from `cron.render` (the render cron's last-run freshness),
    // so it gets its own box-centric label rather than the conductor's description.
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

// A concise operational summary an agent can answer "are all Fluncle systems up?"
// from. Reads the same public health store the /status page and /api/v1/status read.
// `ok` is true only when every service is `ok`; a single `down` flips `ok` false and
// drives a blunt headline. An empty store (the cron has never written) reports unknown
// rather than a false all-clear.
async function summarizeStatus(): Promise<{
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

// The one-line verdict. All clear → a plain all-up line; otherwise name the services
// that are down/degraded so the agent can relay specifics without re-reading the list.
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

function clampLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return defaultRecentLimit;
  }

  return Math.min(value, maxRecentLimit);
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idOf(message: unknown): JsonRpcId {
  if (isObject(message) && (typeof message.id === "string" || typeof message.id === "number")) {
    return message.id;
  }

  return null;
}

function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { id, jsonrpc: "2.0", result };
}

function failure(id: JsonRpcId, code: number, message: string): JsonRpcFailure {
  return { error: { code, message }, id, jsonrpc: "2.0" };
}

// A plain, agent-facing note teaching every tool's caller that Fluncle is on the
// decks right now (machine-facing third-person, no faked warmth — VOICE.md narrator
// rule). Appended as a second content block alongside the tool's data while live.
function liveNote(live: LiveState): string {
  const set = live.title ? ` Set: “${live.title}”.` : "";
  return `Fluncle is on the decks right now, mixing live at ${twitchUrl}.${set}`;
}

function toolResult(data: unknown, isError = false, live?: LiveState): ToolResult {
  const content: ToolResult["content"] = [{ text: JSON.stringify(data), type: "text" }];

  // While Fluncle is live, ride a live-set note alongside the result so the agent
  // learns the live state with every successful call (DESIGN.md "The Live Exception").
  if (live?.on) {
    content.push({ text: liveNote(live), type: "text" });
  }

  return { content, isError };
}

function jsonRpcResponse(body: JsonRpcResponse | JsonRpcResponse[], status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...corsHeaders() },
    status,
  });
}

function methodNotAllowed(allow: string): Response {
  return new Response(
    JSON.stringify({ code: "method_not_allowed", message: `Use ${allow}.`, ok: false }),
    {
      headers: { Allow: allow, "Content-Type": "application/json", ...corsHeaders() },
      status: 405,
    },
  );
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
    "Access-Control-Max-Age": "86400",
  };
}
