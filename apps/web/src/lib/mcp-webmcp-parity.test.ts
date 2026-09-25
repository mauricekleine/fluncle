import { describe, expect, it } from "vitest";
import { mcpOnlyTools } from "./server/mcp";
import { MIN_QUERY_LENGTH } from "./server/orpc/search";
import { webmcpOnlyTools } from "./webmcp";

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
    expect(JSON.stringify(webmcpSearchTracks?.inputSchema)).toBe(
      JSON.stringify(mcpSearchTracks?.inputSchema),
    );
  });

  it("carries a title on the server MCP only — the one deliberate asymmetry", () => {
    expect(mcpSearchTracks?.title).toBe("Search tracks");
    expect(webmcpSearchTracks).not.toHaveProperty("title");
  });

  it("advertises the same 2-character floor the HTTP handler enforces", () => {
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
