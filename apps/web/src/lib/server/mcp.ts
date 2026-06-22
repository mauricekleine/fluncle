import { siteUrl } from "../fluncle-links";
import { fluncleDescription } from "../identity";
import { subscribeToNewsletter } from "./newsletter";
import { ApiError, searchTrackCandidates } from "./spotify";
import { createSubmission } from "./submissions";
import { getRandomTrack, listTracks } from "./tracks";

// A small, stateless Model Context Protocol server: the same drum & bass
// archive the public API exposes, handed to agents as MCP tools over the
// Streamable HTTP transport (a single JSON-RPC endpoint at /mcp). No sessions,
// no Durable Objects — every request is self-contained, so it runs anywhere
// the Worker does. The tools are a thin layer over the internal functions the
// /api routes already use, so behaviour (validation, rate limits, the
// submitter hash) stays identical. The matching MCP Server Card (SEP-2127) is
// served at /.well-known/mcp/server-card.json for agent discovery.
//
// The browser-side WebMCP surface (lib/webmcp.ts) mirrors this tool set for
// agent-driving browsers; keep the two in step when either changes.

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
  // (docs/naming-conventions.md §4) renamed `get_recent_tracks` → `list_tracks`;
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
    execute: async (args) => listTracks({ includeMixtapes: true, limit: clampLimit(args.limit) }),
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
    description: "Pull one random certified track from Fluncle's archive.",
    execute: async () => {
      const track = await getRandomTrack();

      return track
        ? { ok: true, track }
        : { code: "track_not_found", message: "No tracks found", ok: false };
    },
    inputSchema: { properties: {}, type: "object" },
    name: "get_random_track",
    title: "Random finding",
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
  description: `[Deprecated — use list_tracks] ${listTracksTool.description}`,
  name: "get_recent_tracks",
});

// The MCP Server Card (SEP-2127). Carries the canonical shape (top-level name,
// remotes, capabilities object) plus the looser serverInfo/transport fields
// some validators still expect, so one document satisfies both readings.
function serverCard() {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    capabilities: { tools: { listChanged: false } },
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
        capabilities: { tools: { listChanged: false } },
        instructions:
          "Fluncle's drum & bass archive as tools: list recent findings, pull a random one, search Spotify candidates, submit a track for review, or board the newsletter. A submission is a recommendation, not a publish; Fluncle listens before anything goes out.",
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
        return success(id, toolResult(await tool.execute(args, request)));
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

function toolResult(data: unknown, isError = false): ToolResult {
  return { content: [{ text: JSON.stringify(data), type: "text" }], isError };
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
