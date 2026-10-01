import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
  SUPPORTED_PROTOCOL_VERSIONS,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { onionUrl, siteUrl, twitchUrl } from "../fluncle-links";
import { fluncleDescription } from "../identity";
import { type FeedItem, mixtapeDisplayTitle } from "../mixtapes";
import { getLiveState, type LiveState } from "./live";
import { ApiError } from "./spotify";
import { readCoordinate, resourceUri, SHARED_TOOLS, toMcpTool } from "./tools/registry";
import { searchTracks } from "./track-search";
import { listTracks } from "./tracks";

const SERVER_NAME = "com.fluncle/fluncle-api";
const SERVER_VERSION = "1.0.0";
const MCP_ENDPOINT = `${siteUrl}/mcp`;

const maxRecentLimit = 48;
const minQueryLength = 2;

const resourceListLimit = 25;

type ToolResult = {
  content: Array<{ text: string; type: "text" }>;
  isError: boolean;
};

type McpTool = {
  description: string;
  execute: (args: Record<string, unknown>, request: Request) => Promise<unknown>;
  inputSchema: Record<string, unknown>;
  name: string;
  title: string;
};

export const mcpOnlyTools: McpTool[] = [
  {
    description:
      "Search for track candidates to submit, by artist and title or a Spotify track URL. Covers Fluncle's catalogue and other music sources such as Deezer. Pass a result's id and provider to submit_track.",
    execute: async (args, request) => {
      const query = asTrimmedString(args.query);

      if (query.length < minQueryLength) {
        throw new ApiError("invalid_query", "Search query must be at least 2 characters", 400);
      }

      return { ok: true, results: await searchTracks({ query, request }) };
    },
    inputSchema: {
      properties: {
        query: {
          description: "Artist and title, or a Spotify track URL, minimum 2 characters.",
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
];

const tools: McpTool[] = [
  ...SHARED_TOOLS.filter((tool) => tool.transports.includes("mcp")).map(toMcpTool),
  ...mcpOnlyTools,
];

export const mcpToolNames: string[] = tools.map((tool) => tool.name);

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

Dig through Fluncle's archive to answer. Call list_findings and get_random_track to range over it, read the contenders with get_track (or their fluncle://finding/<coordinate> resources), and lean on each finding's note, BPM, key, and galaxy. Pick the ONE that lands the mood best. Reply in a single warm line, the way Fluncle would text it to the crew: name the artist and title, drop its Log ID coordinate, and say in a breath why it's the one. No lists, no preamble.`;
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

Call list_findings with limit ${count} to pull them, then read each one with get_track (or its fluncle://finding/<coordinate> resource). Go newest to oldest. For each, give one warm line in Fluncle's voice: the artist and title, its Log ID coordinate, and the one thing that made it worth logging. Keep the whole thing moving; end on where the night leaves you.`;
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

Fetch it with get_track (or the fluncle://finding/<coordinate> resource). Then, in a few plain sentences in Fluncle's voice: what the tune is (artist, title), when he found it, why it's certified (use the note), and how to read the Log ID itself: the sector counts the days since the 2026-05-30 epoch, the tail is a stable signature of the recording, stamped once and never changed. Keep it warm and short.`;
    },
    description: "Read the finding at a Log ID coordinate and explain the coordinate.",
    name: "decode_coordinate",
    title: "Decode a Log ID",
  },
];

function clampPromptCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(asTrimmedString(value), 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return 5;
  }

  return Math.min(parsed, maxRecentLimit);
}

function firstLine(note: string | undefined): string | undefined {
  const line = note
    ?.split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);

  return line && line.length > 0 ? line : undefined;
}

const MCP_CAPABILITIES = {
  prompts: { listChanged: false },
  resources: { listChanged: false },
  tools: { listChanged: false },
} as const;

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
        supportedProtocolVersions: ["2026-07-28", ...SUPPORTED_PROTOCOL_VERSIONS],
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

const SERVER_INSTRUCTIONS =
  "Fluncle's drum & bass archive over MCP. TOOLS: list recent findings, list the newest releases (what just came out), read one in full by coordinate, pull a random one, search the archive itself, look up an artist or a label, browse every artist, album, and label in the archive A to Z (each flagged when Fluncle has certified a finding there), list the tracks on one album, artist, or label, find the artists nearest another in sound, chain a mixable set from a finding, check whether all of Fluncle's systems are operational, search for tracks to submit, submit a track for review, or board the newsletter. RESOURCES: read the archive as a corpus, each finding/mixtape at fluncle://finding/<logId> or fluncle://mixtape/<logId>, its public record. PROMPTS: Fluncle-voiced starting points (recommend a finding for a mood, walk a recent night, decode a Log ID). A submission is a recommendation, not a publish; Fluncle listens before anything goes out.";

const SITE_ORIGINS = [
  new URL(siteUrl).origin,
  new URL(siteUrl.replace("//www.", "//")).origin,
  new URL(onionUrl).origin,
];
const CATALOG_CACHE = { cacheScope: "public", ttlMs: 3_600_000 } as const;
const ARCHIVE_CACHE = { cacheScope: "public", ttlMs: 30_000 } as const;

function createServer(requestInfo?: Request): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: "Fluncle", version: SERVER_VERSION },
    {
      cacheHints: {
        "prompts/list": CATALOG_CACHE,
        "resources/list": ARCHIVE_CACHE,
        "resources/read": ARCHIVE_CACHE,
        "resources/templates/list": CATALOG_CACHE,
        "server/discover": CATALOG_CACHE,
        "tools/list": CATALOG_CACHE,
      },
      capabilities: MCP_CAPABILITIES,
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  for (const tool of SHARED_TOOLS.filter((candidate) => candidate.transports.includes("mcp"))) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input, title: tool.title },
      async (args) =>
        executeTool(() =>
          tool.execute(args as Record<string, unknown>, { request: requestInfo, transport: "mcp" }),
        ),
    );
  }

  for (const tool of mcpOnlyTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: z.object({
          query: z
            .string()
            .describe("Artist and title, or a Spotify track URL, minimum 2 characters.")
            .meta({ minLength: minQueryLength }),
        }),
        title: tool.title,
      },
      async (args) =>
        executeTool(() => tool.execute(args, requestInfo ?? new Request(MCP_ENDPOINT))),
    );
  }

  const recentResources = async () => {
    const page = await listTracks({ includeMixtapes: true, limit: resourceListLimit });
    return { resources: page.tracks.filter((item) => item.logId).map(resourceDescriptor) };
  };
  const readResource = async (uri: URL, variables: Record<string, string | string[]>) => {
    const coordinate = variables.coordinate;
    const value = typeof coordinate === "string" ? coordinate.trim() : "";
    const resolved = value ? await readCoordinate(value) : undefined;
    if (!resolved) {
      throw new ResourceNotFoundError(uri.href, `No finding found at ${uri.href}`);
    }
    return {
      contents: [
        {
          mimeType: "application/json" as const,
          text: JSON.stringify(resolved.record),
          uri: uri.href,
        },
      ],
    };
  };
  server.registerResource(
    "finding",
    new ResourceTemplate("fluncle://finding/{coordinate}", { list: recentResources }),
    { cacheHint: ARCHIVE_CACHE, mimeType: "application/json" },
    readResource,
  );
  server.registerResource(
    "mixtape",
    new ResourceTemplate("fluncle://mixtape/{coordinate}", { list: undefined }),
    { cacheHint: ARCHIVE_CACHE, mimeType: "application/json" },
    readResource,
  );
  server.registerResource(
    "coordinate",
    new ResourceTemplate("fluncle://{coordinate}", { list: undefined }),
    { cacheHint: ARCHIVE_CACHE, mimeType: "application/json" },
    readResource,
  );

  for (const prompt of prompts) {
    const fields = Object.fromEntries(
      prompt.arguments.map((argument) => [
        argument.name,
        argument.required
          ? z.string().describe(argument.description)
          : z.string().optional().describe(argument.description),
      ]),
    );
    server.registerPrompt(
      prompt.name,
      {
        argsSchema: z.object(fields).default({}),
        description: prompt.description,
        title: prompt.title,
      },
      (args) => ({
        description: prompt.description,
        messages: [{ content: { text: prompt.build(args), type: "text" }, role: "user" }],
      }),
    );
  }

  return server;
}

const mcpHandler = createMcpHandler(({ requestInfo }) => createServer(requestInfo), {
  legacy: "reject",
  maxSubscriptions: 0,
  responseMode: "json",
});

async function handleLegacyRequest(request: Request): Promise<Response> {
  const server = createServer(request);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
  });
  const headers = new Headers(request.headers);
  headers.set("Accept", "application/json, text/event-stream");
  try {
    await server.connect(transport);
    return await transport.handleRequest(new Request(request, { headers }));
  } finally {
    await transport.close();
    await server.close();
  }
}

async function executeTool(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const [result, live] = await Promise.all([run(), getLiveState()]);
    return toolResult(result, false, live);
  } catch (error) {
    if (error instanceof ApiError) {
      return toolResult(
        {
          code: error.code,
          message: error.message,
          ok: false,
          ...(error.until !== undefined ? { until: error.until } : {}),
        },
        true,
      );
    }
    return toolResult(
      { code: "error", message: error instanceof Error ? error.message : String(error), ok: false },
      true,
    );
  }
}

export async function handleMcp(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname === "/.well-known/mcp/server-card.json") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET");
    }
    return new Response(request.method === "HEAD" ? null : JSON.stringify(serverCard(), null, 2), {
      headers: { "Cache-Control": "public, max-age=3600", "Content-Type": "application/json" },
    });
  }
  if (pathname !== "/mcp") {
    return undefined;
  }

  if (!allowedOrigin(request.headers.get("origin"))) {
    return new Response(null, { headers: { Vary: "Origin" }, status: 403 });
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(request), status: 204 });
  }
  if (request.method !== "POST") {
    return withCors(methodNotAllowed("POST, OPTIONS"), request);
  }
  const response = (await isLegacyRequest(request))
    ? await handleLegacyRequest(request)
    : await mcpHandler.fetch(request);
  return withCors(response, request);
}

function withCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(request))) {
    headers.set(name, value);
  }
  return new Response(response.body, { headers, status: response.status });
}

function allowedOrigin(origin: string | null): boolean {
  if (origin === null) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin) {
      return false;
    }
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return parsed.protocol === "http:";
    }
    return SITE_ORIGINS.includes(parsed.origin);
  } catch {
    return false;
  }
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function liveNote(live: LiveState): string {
  const set = live.title ? ` Set: “${live.title}”.` : "";
  return `Fluncle is on the decks right now, mixing live at ${twitchUrl}.${set}`;
}

function toolResult(data: unknown, isError = false, live?: LiveState): ToolResult {
  const content: ToolResult["content"] = [{ text: JSON.stringify(data), type: "text" }];

  if (live?.on) {
    content.push({ text: liveNote(live), type: "text" });
  }

  return { content, isError };
}

function methodNotAllowed(allow: string): Response {
  return new Response(
    JSON.stringify({ code: "method_not_allowed", message: `Use ${allow}.`, ok: false }),
    {
      headers: { Allow: allow, "Content-Type": "application/json" },
      status: 405,
    },
  );
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) {
    return { Vary: "Origin" };
  }
  return {
    "Access-Control-Allow-Headers": "Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "MCP-Protocol-Version",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
