import { describe, expect, it } from "vitest";
import { mcpOnlyTools } from "./server/mcp";
import { MIN_QUERY_LENGTH } from "./server/orpc/search";
import { webmcpOnlyTools } from "./webmcp";

// The two agent-facing tool surfaces — the server MCP (lib/server/mcp.ts) and the browser
// WebMCP (lib/webmcp.ts) — are kept in step by the SHARED REGISTRY: every tool projected from
// `SHARED_TOOL_SPECS` gets its name, description, and schema from one place, and
// tools/registry.test.ts asserts the projection.
//
// `search_tracks` is outside that registry on purpose (it searches Spotify, not the archive,
// and the registry's Projection set is a closed archive taxonomy whose parity test hard-asserts
// every shared spec is on ChatDnB). So it is hand-written TWICE, and nothing but this file stops
// the two copies drifting — an agent that reads one surface and calls the other must see the
// same tool.

const mcpSearchTracks = mcpOnlyTools.find((tool) => tool.name === "search_tracks");
const webmcpSearchTracks = webmcpOnlyTools.find((tool) => tool.name === "search_tracks");

describe("search_tracks — MCP ↔ WebMCP parity (the one tool outside the shared registry)", () => {
  it("is present on both surfaces", () => {
    expect(mcpSearchTracks, "server MCP carries search_tracks").toBeDefined();
    expect(webmcpSearchTracks, "WebMCP carries search_tracks").toBeDefined();
  });

  it("describes itself identically on both", () => {
    expect(webmcpSearchTracks?.description).toBe(mcpSearchTracks?.description);
  });

  it("advertises an identical input schema on both", () => {
    // Deep-compared as JSON: an agent reads the schema verbatim, so key order and every
    // nested field (the `minLength` floor, the description) has to match, not just the shape.
    expect(JSON.stringify(webmcpSearchTracks?.inputSchema)).toBe(
      JSON.stringify(mcpSearchTracks?.inputSchema),
    );
  });

  it("carries a title on the server MCP only — the one deliberate asymmetry", () => {
    // MCP tools have a human `title` alongside the machine `name`; navigator.modelContext's
    // tool shape has no such field, so WebMCP carries name + description + schema and no more.
    expect(mcpSearchTracks?.title).toBe("Search tracks");
    expect(webmcpSearchTracks).not.toHaveProperty("title");
  });

  it("advertises the same 2-character floor the HTTP handler enforces", () => {
    // Both surfaces publish `minLength` so an agent can self-correct before spending a call,
    // and the HTTP op rejects anything shorter with `invalid_query`. The three must agree —
    // an advertised floor that the server disagrees with teaches the agent a lie.
    //
    // The floor is read off the HANDLER, not the contract: the contract op deliberately types
    // `q` as a tolerant optional string with no minimum (packages/contracts/src/orpc/search.ts),
    // so the handler can emit the hand-rolled 400 rather than a schema rejection.
    const schemaFloor = (schema: Record<string, unknown> | undefined): unknown =>
      (
        (schema?.properties as Record<string, Record<string, unknown>> | undefined)?.query as
          | Record<string, unknown>
          | undefined
      )?.minLength;

    expect(schemaFloor(mcpSearchTracks?.inputSchema)).toBe(MIN_QUERY_LENGTH);
    expect(schemaFloor(webmcpSearchTracks?.inputSchema)).toBe(MIN_QUERY_LENGTH);
  });
});
