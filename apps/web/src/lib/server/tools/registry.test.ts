import { describe, expect, it } from "vitest";
import { FRESH_TRACKS_MAX } from "../fresh";
import { type TrackListItem } from "../tracks";
import {
  FRESH_LIMIT_MAX,
  getStatusSpec,
  MAX_RECENT_LIMIT,
  SHARED_TOOL_SPECS,
  type ToolSpec,
  toInputJsonSchema,
  toWebMcpTool,
  type Transport,
} from "./specs";
import { compactFinding, publicFindingRecord, SHARED_TOOLS, toMcpTool } from "./registry";

// The registry projects one tool set onto three transports. These tests are the drift guard: the
// SAME five verbs, byte-identical output per transport, projected to exactly the surfaces each is
// declared for. They pair with mcp.test.ts / chat.test.ts (which exercise the executes end to end
// through each transport's dispatcher); here we assert the registry's structure + the two record
// projections directly, without a database.

// A finding with every field a projection reads — including the private ones a projection MUST
// strip (the capture key, the expiring preview token).
function findingFixture(overrides: Partial<TrackListItem> = {}): TrackListItem {
  return {
    addedAt: "2026-06-15T20:00:00.000Z",
    addedToSpotify: true,
    album: "The Album",
    albumImageUrl: "https://cover.example/banger.jpg",
    artists: ["Camo & Krooked"],
    bpm: 172.6,
    durationMs: 215_000,
    enrichmentStatus: "done",
    galaxy: { name: "Liquid", slug: "liquid" },
    key: "F minor",
    label: "Hospital Records",
    logId: "012.8.0A",
    logPageUrl: "https://www.fluncle.com/log/012.8.0A",
    note: "A hook that folds the room in half.",
    postedToTelegram: true,
    previewUrl: "https://deezer.example/expiring-token.mp3",
    sourceAudioKey: "012.8.0A/deadbeef.opus",
    spotifyUrl: "https://open.spotify.com/track/abc",
    title: "Test Banger",
    trackId: "abc",
    type: "finding",
    ...overrides,
  } as TrackListItem;
}

const byName = (name: string): ToolSpec => {
  const spec = SHARED_TOOL_SPECS.find((candidate) => candidate.name === name);

  if (!spec) {
    throw new Error(`spec ${name} missing`);
  }

  return spec;
};

describe("SHARED_TOOLS registry — one definition, five verbs", () => {
  it("seeds exactly the five overlapping tools", () => {
    expect(SHARED_TOOL_SPECS.map((spec) => spec.name).sort()).toEqual([
      "get_random_track",
      "get_status",
      "get_track",
      "list_fresh",
      "list_tracks",
    ]);
    // SHARED_TOOLS (spec + execute) mirrors the specs one-for-one.
    expect(SHARED_TOOLS.map((def) => def.name).sort()).toEqual(
      SHARED_TOOL_SPECS.map((spec) => spec.name).sort(),
    );
    for (const def of SHARED_TOOLS) {
      expect(typeof def.execute).toBe("function");
    }
  });

  it("keeps the fresh cap in step with the fresh library (client-safe duplicate)", () => {
    // FRESH_LIMIT_MAX lives in the client-safe specs; this asserts it never drifts from the
    // server-only source of truth.
    expect(FRESH_LIMIT_MAX).toBe(FRESH_TRACKS_MAX);
  });
});

describe("output-shape / behavior-preserving — a finding through each projection", () => {
  it("the MCP publicRecord carries the full public record and strips the private key", () => {
    const record = publicFindingRecord(findingFixture());

    expect(record).toMatchObject({
      album: "The Album",
      artists: ["Camo & Krooked"],
      bpm: 173, // rounded
      coordinate: "012.8.0A",
      found: "2026-06-15T20:00:00.000Z",
      galaxy: "Liquid",
      key: "F minor",
      label: "Hospital Records",
      note: "A hook that folds the room in half.",
      title: "Test Banger",
      type: "finding",
      uri: "fluncle://finding/012.8.0A",
    });
    expect(record.links).toMatchObject({ spotify: "https://open.spotify.com/track/abc" });
    // Never the private capture key, never the expiring preview token.
    expect(JSON.stringify(record)).not.toContain("deadbeef");
    expect(JSON.stringify(record)).not.toContain("expiring-token");
  });

  it("the chat compactCard carries the card fields, hasPreview, and no expiring token", () => {
    const card = compactFinding(findingFixture());

    expect(card).toMatchObject({
      albumImageUrl: "https://cover.example/banger.jpg",
      artists: ["Camo & Krooked"],
      bpm: 173,
      coordinate: "012.8.0A",
      durationMs: 215_000,
      hasPreview: true, // derived from previewUrl
      key: "F minor",
      note: "A hook that folds the room in half.",
      title: "Test Banger",
    });
    // The card gets the boolean, NEVER the raw expiring URL or the capture key.
    expect(hasKeyDeep(card, "previewUrl")).toBe(false);
    expect(JSON.stringify(card)).not.toContain("expiring-token");
    expect(JSON.stringify(card)).not.toContain("deadbeef");
    // The compact card deliberately does NOT carry the MCP-only record fields.
    expect(hasKeyDeep(card, "uri")).toBe(false);
    expect(hasKeyDeep(card, "observation")).toBe(false);
  });

  it("keeps hasPreview: false intact when there is no preview (the card needs the explicit false)", () => {
    const card = compactFinding(findingFixture({ previewUrl: undefined }));

    expect(card.hasPreview).toBe(false);
  });
});

describe("tool-set parity — each transport gets exactly its declared projection", () => {
  it("declares a projection for every transport it appears on, and none it does not", () => {
    for (const spec of SHARED_TOOL_SPECS) {
      const projected = Object.keys(spec.project).sort();
      expect(projected, `${spec.name} project keys`).toEqual([...spec.transports].sort());
    }
  });

  it("codifies get_status OFF WebMCP (the browser read path is get_track)", () => {
    expect(getStatusSpec.transports).toEqual(["mcp", "chat"]);
    expect(getStatusSpec.transports).not.toContain("webmcp");
  });

  it("projects the four read tools onto all three transports", () => {
    for (const name of ["list_tracks", "list_fresh", "get_track", "get_random_track"]) {
      expect(byName(name).transports.sort()).toEqual(["chat", "mcp", "webmcp"]);
    }
  });

  it("the projected set for a transport equals the specs declared for it", () => {
    const forTransport = (transport: Transport) =>
      SHARED_TOOL_SPECS.filter((spec) => spec.transports.includes(transport))
        .map((spec) => spec.name)
        .sort();

    expect(forTransport("mcp")).toEqual([
      "get_random_track",
      "get_status",
      "get_track",
      "list_fresh",
      "list_tracks",
    ]);
    expect(forTransport("chat")).toEqual([
      "get_random_track",
      "get_status",
      "get_track",
      "list_fresh",
      "list_tracks",
    ]);
    // get_status absent — WebMCP carries the four read tools only.
    expect(forTransport("webmcp")).toEqual([
      "get_random_track",
      "get_track",
      "list_fresh",
      "list_tracks",
    ]);
  });

  it("get_recent_tracks is a per-transport alias, never a shared tool", () => {
    // The deprecation alias is minted inside mcp.ts / webmcp.ts (present there, absent on chat);
    // it is never a registry tool.
    expect(SHARED_TOOL_SPECS.map((spec) => spec.name)).not.toContain("get_recent_tracks");
  });
});

describe("the transport adapters bridge signatures", () => {
  it("toMcpTool exposes name/title/description/inputSchema + a positional (args, request) execute", () => {
    const listTracks = SHARED_TOOLS.find((def) => def.name === "list_tracks");
    if (!listTracks) {
      throw new Error("list_tracks missing");
    }

    const mcpTool = toMcpTool(listTracks);

    expect(mcpTool.name).toBe("list_tracks");
    expect(mcpTool.title).toBe("Recent findings");
    expect(typeof mcpTool.description).toBe("string");
    expect(mcpTool.inputSchema).toMatchObject({ type: "object" });
    expect(mcpTool.execute.length).toBe(2); // (args, request)
  });

  it("toWebMcpTool keeps the hand-written HTTP execute and shares name + description + schema", async () => {
    const httpExecute = async () => ({ content: [{ text: "{}", type: "text" as const }] });
    const webTool = toWebMcpTool(byName("get_track"), httpExecute);

    expect(webTool.name).toBe("get_track");
    expect(webTool.execute).toBe(httpExecute);
    expect(webTool.inputSchema).toMatchObject({ required: ["idOrLogId"] });
  });
});

describe("schema snapshot — z.toJSONSchema carries required / min / max", () => {
  it("list_tracks: an optional integer limit clamped 1..48, no required", () => {
    const schema = toInputJsonSchema(byName("list_tracks")) as {
      properties: { limit: { maximum: number; minimum: number; type: string } };
      required?: string[];
      type: string;
    };

    expect(schema.type).toBe("object");
    expect(schema.properties.limit).toMatchObject({
      maximum: MAX_RECENT_LIMIT,
      minimum: 1,
      type: "integer",
    });
    expect(schema.required).toBeUndefined();
  });

  it("list_fresh: an optional integer limit clamped 1..100", () => {
    const schema = toInputJsonSchema(byName("list_fresh")) as {
      properties: { limit: { maximum: number; minimum: number; type: string } };
    };

    expect(schema.properties.limit).toMatchObject({
      maximum: FRESH_LIMIT_MAX,
      minimum: 1,
      type: "integer",
    });
  });

  it("get_track: a required idOrLogId string (the canonical arg)", () => {
    const schema = toInputJsonSchema(byName("get_track")) as {
      properties: { idOrLogId: { type: string } };
      required: string[];
    };

    expect(schema.properties.idOrLogId.type).toBe("string");
    expect(schema.required).toEqual(["idOrLogId"]);
    // The chat arg `coordinate` was renamed to the canonical `idOrLogId` (0 consumers).
    expect(Object.keys(schema.properties)).not.toContain("coordinate");
  });

  it("get_random_track / get_status: an empty, arg-free object (no additionalProperties emitted)", () => {
    for (const name of ["get_random_track", "get_status"]) {
      const schema = toInputJsonSchema(byName(name)) as Record<string, unknown>;

      expect(schema.type).toBe("object");
      expect(schema.properties).toEqual({});
      // The explicit-opts toJSONSchema form deliberately omits additionalProperties:false.
      expect(schema.additionalProperties).toBeUndefined();
    }
  });
});

/** Walk any value and report whether `key` appears anywhere in it (arrays + nested objects). */
function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasKeyDeep(entry, key));
  }

  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([entryKey, entryValue]) => entryKey === key || hasKeyDeep(entryValue, key),
    );
  }

  return false;
}
