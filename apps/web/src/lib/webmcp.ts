import { SHARED_TOOL_SPECS, toWebMcpTool } from "./tool-specs";

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

const httpExecutes: Record<string, WebMcpTool["execute"]> = {
  get_random_track: async () => jsonResult(await fetchJson("/api/v1/tracks/random")),
  get_track: async (input) =>
    jsonResult(await fetchJson(`/api/v1/tracks/${encodeURIComponent(asString(input.idOrLogId))}`)),

  list_findings: async (input) => {
    const limit = typeof input.limit === "number" ? input.limit : 10;
    const params = new URLSearchParams({ limit: String(limit) });

    return jsonResult(await fetchJson(`/api/v1/findings?${params}`));
  },
  list_fresh: async (input) => {
    const limit = typeof input.limit === "number" ? input.limit : 50;
    const params = new URLSearchParams({ limit: String(limit) });

    return jsonResult(await fetchJson(`/api/v1/tracks/fresh?${params}`));
  },

  list_tracks: async (input) => {
    const params = new URLSearchParams();
    if (typeof input.page === "number") {
      params.set("page", String(input.page));
    }
    if (typeof input.certified === "boolean") {
      params.set("certified", String(input.certified));
    }

    return jsonResult(await fetchJson(`/api/v1/tracks?${params}`));
  },

  search_archive: async (input) => {
    const params = new URLSearchParams({ q: asString(input.query) });

    return jsonResult(await fetchJson(`/api/v1/search/archive?${params}`));
  },

  submit_track: async (input) => {
    const spotifyUrl = asString(input.spotifyUrl);
    const search = (await fetchJson(
      `/api/v1/search?${new URLSearchParams({ q: spotifyUrl })}`,
    )) as {
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

    const submission = await fetchJson("/api/v1/submissions", {
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
  subscribe_newsletter: async (input) =>
    jsonResult(
      await fetchJson("/api/v1/newsletter", {
        body: JSON.stringify({ email: asString(input.email) }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    ),
};

export const webmcpOnlyTools: WebMcpTool[] = [
  {
    description:
      "Search Spotify for track candidates by name or Spotify track URL. Use a result's id and spotifyUrl with submit_track.",
    execute: async (input) => {
      const params = new URLSearchParams({ q: asString(input.query) });

      return jsonResult(await fetchJson(`/api/v1/search?${params}`));
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
];

const tools: WebMcpTool[] = [
  ...SHARED_TOOL_SPECS.filter((spec) => spec.transports.includes("webmcp")).map((spec) => {
    const httpExecute = httpExecutes[spec.name];

    if (!httpExecute) {
      throw new Error(`WebMCP is missing an HTTP execute for the shared tool ${spec.name}`);
    }

    return toWebMcpTool(spec, httpExecute);
  }),
  ...webmcpOnlyTools,
];

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
