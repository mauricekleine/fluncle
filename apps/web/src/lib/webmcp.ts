// WebMCP (https://webmachinelearning.github.io/webmcp/): expose the site's
// key actions as in-page tools for agent-driving browsers. Registration is
// best-effort; browsers without navigator.modelContext skip it silently.
//
// This mirrors the server MCP's TOOL set (lib/server/mcp.ts); keep the two in
// step when the tools change. The server MCP also speaks resources (the archive
// as a readable corpus) and prompts (Fluncle-voiced starting points), but
// navigator.modelContext has no resource/prompt primitive — so the browser read
// path is the get_track tool below, and resources/prompts stay server-MCP only.

import { SHARED_TOOL_SPECS, toWebMcpTool } from "./server/tools/specs";

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

// The browser HTTP execute per shared read tool. Name/description/schema come from the shared
// registry specs (./server/tools/specs); only these hand-written `fetch('/api/…')` bodies are
// WebMCP's own (the browser has no in-process server functions).
const httpExecutes: Record<string, WebMcpTool["execute"]> = {
  get_random_track: async () => jsonResult(await fetchJson("/api/v1/tracks/random")),
  get_track: async (input) =>
    jsonResult(await fetchJson(`/api/v1/tracks/${encodeURIComponent(asString(input.idOrLogId))}`)),
  // The found-order FEED (findings + published mixtapes) — the public GET /api/v1/findings twin.
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
  // The whole-archive ENUMERATOR — the public GET /api/v1/tracks twin (release-ordered, numbered
  // pages, tri-state `certified`). Distinct from the found-order `list_findings` feed above.
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
  // The archive search — the public GET /api/v1/search/archive twin, whose `q` input matches the
  // tool's `query` 1:1 and whose per-IP limiter is shared with the MCP (orpc/search.ts). Returns
  // the whole SearchResult (both registers, each row certified-tagged).
  search_archive: async (input) => {
    const params = new URLSearchParams({ q: asString(input.query) });

    return jsonResult(await fetchJson(`/api/v1/search/archive?${params}`));
  },
  // The two write verbs (submit_track resolves the URL to a candidate first, then POSTs it;
  // subscribe_newsletter boards the email). Public POST routes; the browser has no in-process fns.
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

// WebMCP-only tool: the Spotify candidate search (Epic-2 territory, not in the shared registry —
// it searches Spotify, not the archive).
const webmcpOnlyTools: WebMcpTool[] = [
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

// The realized WebMCP tool set: the shared read tools projected from the registry specs (each with
// its browser HTTP execute), then the WebMCP-only verbs. get_status is codified off WebMCP, so the
// `webmcp` transport filter drops it.
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

// The vocabulary cut retired the last deprecation alias (`get_recent_tracks`) with no
// replacement shim, so the WebMCP tool set is exactly the shared web tools plus the
// WebMCP-only verbs — one name per operation, in parity with the server MCP surface.

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
