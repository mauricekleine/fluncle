// WebMCP (https://webmachinelearning.github.io/webmcp/): expose the site's
// key actions as in-page tools for agent-driving browsers. Registration is
// best-effort; browsers without navigator.modelContext skip it silently.
//
// This mirrors the server MCP's TOOL set (lib/server/mcp.ts); keep the two in
// step when the tools change. The server MCP also speaks resources (the archive
// as a readable corpus) and prompts (Fluncle-voiced starting points), but
// navigator.modelContext has no resource/prompt primitive — so the browser read
// path is the get_track tool below, and resources/prompts stay server-MCP only.

type WebMcpToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

type WebMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<WebMcpToolResult>;
};

type ModelContext = {
  provideContext?: (context: { tools: WebMcpTool[] }) => void;
  registerTool?: (tool: WebMcpTool) => unknown;
};

let registered = false;

export function registerWebMcpTools(): void {
  // Module-level guard: React StrictMode double-invokes effects in dev, and
  // registerTool (unlike provideContext) appends rather than replaces.
  if (registered || typeof navigator === "undefined") {
    return;
  }

  const modelContext = (navigator as Navigator & { modelContext?: ModelContext }).modelContext;

  if (!modelContext) {
    return;
  }

  registered = true;

  try {
    if (typeof modelContext.registerTool === "function") {
      for (const tool of tools) {
        modelContext.registerTool(tool);
      }
    } else if (typeof modelContext.provideContext === "function") {
      modelContext.provideContext({ tools });
    }
  } catch (error) {
    console.warn("WebMCP tool registration failed", error);
  }
}

const tools: WebMcpTool[] = [
  {
    description:
      "List the most recent findings and mixtapes in Fluncle's drum & bass archive, newest first.",
    execute: async (input) => {
      const limit = typeof input.limit === "number" ? input.limit : 10;
      const params = new URLSearchParams({ limit: String(limit) });

      return jsonResult(await fetchJson(`/api/tracks?${params}`));
    },
    inputSchema: {
      properties: {
        limit: {
          description: "How many tracks to return (1 to 48, default 10).",
          maximum: 48,
          minimum: 1,
          type: "number",
        },
      },
      type: "object",
    },
    name: "list_tracks",
  },
  {
    description:
      "List the newest drum & bass RELEASES across Fluncle's archive: every track that came OUT in the trailing 30-day window, freshest release first. Ordered by RELEASE date (when a track landed), not by when Fluncle found it, so do not say Fluncle found them, only that they just came out. Certified findings carry a Log ID coordinate and cover art; the quieter uncertified rows carry neither.",
    execute: async (input) => {
      const limit = typeof input.limit === "number" ? input.limit : 50;
      const params = new URLSearchParams({ limit: String(limit) });

      return jsonResult(await fetchJson(`/api/v1/tracks/fresh?${params}`));
    },
    inputSchema: {
      properties: {
        limit: {
          description: "How many releases to return (1 to 100, default 50).",
          maximum: 100,
          minimum: 1,
          type: "integer",
        },
      },
      type: "object",
    },
    name: "list_fresh",
  },
  {
    description:
      "Read one finding (or mixtape) in full by its Log ID coordinate or Spotify track id. Returns the same public record its /log page shows: artist, title, Found date, note, BPM, key, links, and the recovered observation transcript.",
    execute: async (input) =>
      jsonResult(await fetchJson(`/api/tracks/${encodeURIComponent(asString(input.idOrLogId))}`)),
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
  },
  {
    description: "Pull one random certified track from Fluncle's archive.",
    execute: async () => jsonResult(await fetchJson("/api/tracks/random")),
    inputSchema: {
      properties: {},
      type: "object",
    },
    name: "get_random_track",
  },
  {
    description:
      "Search Spotify for track candidates by name or Spotify track URL. Use a result's id and spotifyUrl with submit_track.",
    execute: async (input) => {
      const params = new URLSearchParams({ q: asString(input.query) });

      return jsonResult(await fetchJson(`/api/search?${params}`));
    },
    inputSchema: {
      properties: {
        query: {
          description: "Track search query or Spotify track URL, minimum 2 characters.",
          minLength: 2,
          type: "string",
        },
      },
      required: ["query"],
      type: "object",
    },
    name: "search_tracks",
  },
  {
    description:
      "Submit a track to Fluncle for review by Spotify track URL. Fluncle gives it a listen before anything publishes. Limited to 5 submissions per connection per hour.",
    execute: async (input) => {
      const spotifyUrl = asString(input.spotifyUrl);
      const search = (await fetchJson(`/api/search?${new URLSearchParams({ q: spotifyUrl })}`)) as {
        ok?: boolean;
        results?: Array<{
          id: string;
          spotifyUrl: string;
          title: string;
          artists: string[];
          album?: string;
          artworkUrl?: string;
        }>;
      };
      const candidate = search.results?.[0];

      if (!candidate) {
        return jsonResult(search);
      }

      const submission = await fetchJson("/api/submissions", {
        body: JSON.stringify({
          album: candidate.album,
          artists: candidate.artists,
          artworkUrl: candidate.artworkUrl,
          contact: typeof input.contact === "string" ? input.contact : undefined,
          note: typeof input.note === "string" ? input.note : undefined,
          source: "web",
          spotifyTrackId: candidate.id,
          spotifyUrl: candidate.spotifyUrl,
          title: candidate.title,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      return jsonResult(submission);
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
  },
  {
    description:
      "Subscribe an email address to Fluncle's newsletter. Fresh bangers, every Friday, from Fluncle.",
    execute: async (input) =>
      jsonResult(
        await fetchJson("/api/newsletter", {
          body: JSON.stringify({ email: asString(input.email) }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      ),
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
  },
];

// `get_recent_tracks` deprecation alias of `list_tracks` (Convention B §4), kept in
// parity with the server MCP surface (lib/server/mcp.ts). Shares the canonical
// tool's execute + schema so the two never drift.
const listTracksTool = tools[0];

if (!listTracksTool) {
  throw new Error("list_tracks tool missing from the WebMCP tool list");
}

tools.push({
  ...listTracksTool,
  description: `[Deprecated: use list_tracks] ${listTracksTool.description}`,
  name: "get_recent_tracks",
});

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function fetchJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);

  return response.json();
}

function jsonResult(data: unknown): WebMcpToolResult {
  return {
    content: [{ text: JSON.stringify(data), type: "text" }],
  };
}
