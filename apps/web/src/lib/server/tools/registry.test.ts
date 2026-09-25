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
} from "../../tool-specs";
import { compactFinding, publicFindingRecord, SHARED_TOOLS, toMcpTool } from "./registry";

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

const ALL_TOOL_NAMES = [
  "build_set",
  "get_artist",
  "get_label",
  "get_random_track",
  "get_status",
  "get_track",
  "list_album_catalogue",
  "list_albums",
  "list_artist_catalogue",
  "list_artists",
  "list_findings",
  "list_fresh",
  "list_label_catalogue",
  "list_labels",
  "list_similar_artists",
  "list_tracks",
  "search_archive",
  "submit_track",
  "subscribe_newsletter",
];

describe("SHARED_TOOLS registry — one definition, every verb", () => {
  it("seeds exactly the registered tools (reads + writes)", () => {
    expect(SHARED_TOOL_SPECS.map((spec) => spec.name).sort()).toEqual(ALL_TOOL_NAMES);

    expect(SHARED_TOOLS.map((def) => def.name).sort()).toEqual(
      SHARED_TOOL_SPECS.map((spec) => spec.name).sort(),
    );
    for (const def of SHARED_TOOLS) {
      expect(typeof def.execute).toBe("function");
    }
  });

  it("keeps the fresh cap in step with the fresh library (client-safe duplicate)", () => {
    expect(FRESH_LIMIT_MAX).toBe(FRESH_TRACKS_MAX);
  });
});

describe("output-shape / behavior-preserving — a finding through each projection", () => {
  it("the MCP publicRecord carries the full public record and strips the private key", () => {
    const record = publicFindingRecord(findingFixture());

    expect(record).toMatchObject({
      album: "The Album",
      artists: ["Camo & Krooked"],
      bpm: 173,
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
      hasPreview: true,
      key: "F minor",
      note: "A hook that folds the room in half.",
      title: "Test Banger",
    });

    expect(hasKeyDeep(card, "previewUrl")).toBe(false);
    expect(JSON.stringify(card)).not.toContain("expiring-token");
    expect(JSON.stringify(card)).not.toContain("deadbeef");

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

  it("projects the five read tools onto all three transports", () => {
    for (const name of [
      "list_findings",
      "list_tracks",
      "list_fresh",
      "get_track",
      "get_random_track",
    ]) {
      expect(byName(name).transports.sort()).toEqual(["chat", "mcp", "webmcp"]);
    }
  });

  it("the projected set for a transport equals the specs declared for it", () => {
    const forTransport = (transport: Transport) =>
      SHARED_TOOL_SPECS.filter((spec) => spec.transports.includes(transport))
        .map((spec) => spec.name)
        .sort();

    expect(forTransport("mcp")).toEqual(ALL_TOOL_NAMES);
    expect(forTransport("chat")).toEqual(ALL_TOOL_NAMES);

    expect(forTransport("webmcp")).toEqual([
      "get_random_track",
      "get_track",
      "list_findings",
      "list_fresh",
      "list_tracks",
      "search_archive",
      "submit_track",
      "subscribe_newsletter",
    ]);
  });

  it("codifies the reads that stay off WebMCP (no name-keyed public endpoint)", () => {
    for (const name of [
      "get_artist",
      "get_label",
      "build_set",
      "list_similar_artists",
      "list_album_catalogue",
      "list_artist_catalogue",
      "list_label_catalogue",
      "list_artists",
      "list_albums",
      "list_labels",
    ]) {
      expect(byName(name).transports.sort(), name).toEqual(["chat", "mcp"]);
    }
  });

  it("get_recent_tracks is fully retired — never a shared tool, never a per-transport alias", () => {
    expect(SHARED_TOOL_SPECS.map((spec) => spec.name)).not.toContain("get_recent_tracks");
  });
});

describe("the transport adapters bridge signatures", () => {
  it("toMcpTool exposes name/title/description/inputSchema + a positional (args, request) execute", () => {
    const listFindings = SHARED_TOOLS.find((def) => def.name === "list_findings");
    if (!listFindings) {
      throw new Error("list_findings missing");
    }

    const mcpTool = toMcpTool(listFindings);

    expect(mcpTool.name).toBe("list_findings");
    expect(mcpTool.title).toBe("Recent findings");
    expect(typeof mcpTool.description).toBe("string");
    expect(mcpTool.inputSchema).toMatchObject({ type: "object" });
    expect(mcpTool.execute.length).toBe(2);
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
  it("list_findings: an optional integer limit clamped 1..48, no required", () => {
    const schema = toInputJsonSchema(byName("list_findings")) as {
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

  it("list_tracks (the reborn enumerator): optional page + tri-state certified, no limit, no required", () => {
    const schema = toInputJsonSchema(byName("list_tracks")) as {
      properties: {
        certified?: { type: string };
        limit?: unknown;
        page?: { minimum: number; type: string };
      };
      required?: string[];
      type: string;
    };

    expect(schema.type).toBe("object");
    expect(schema.properties.page).toMatchObject({ minimum: 1, type: "integer" });
    expect(schema.properties.certified?.type).toBe("boolean");

    expect(schema.properties.limit).toBeUndefined();
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

    expect(Object.keys(schema.properties)).not.toContain("coordinate");
  });

  it("get_random_track / get_status: an empty, arg-free object (no additionalProperties emitted)", () => {
    for (const name of ["get_random_track", "get_status"]) {
      const schema = toInputJsonSchema(byName(name)) as Record<string, unknown>;

      expect(schema.type).toBe("object");
      expect(schema.properties).toEqual({});

      expect(schema.additionalProperties).toBeUndefined();
    }
  });
});

const VERB_NOUN_SHAPE = /^[a-z]+(?:_[a-z0-9]+)+$/;
const APPROVED_TOOL_VERBS = new Set<string>([
  "build",
  "get",
  "list",
  "search",
  "submit",
  "subscribe",
]);

describe("registry naming — verb_noun over the tool names (incl. build)", () => {
  it("every tool name is lowercase snake_case verb_noun", () => {
    for (const spec of SHARED_TOOL_SPECS) {
      expect(VERB_NOUN_SHAPE.test(spec.name), `${spec.name} is not verb_noun`).toBe(true);
    }
  });

  it("every tool leads with an approved verb (build_set brings `build` under the convention)", () => {
    for (const spec of SHARED_TOOL_SPECS) {
      const verb = spec.name.split("_")[0] ?? spec.name;
      expect(
        APPROVED_TOOL_VERBS.has(verb),
        `${spec.name} leads with unapproved verb "${verb}"`,
      ).toBe(true);
    }

    expect(byName("build_set").name.split("_")[0]).toBe("build");
  });
});

describe("the auth model — transports authored independently of access", () => {
  it("the realized MCP tool set contains NO access:session tool (the cross-field guard)", () => {
    for (const spec of SHARED_TOOL_SPECS) {
      if (spec.transports.includes("mcp")) {
        expect(spec.access, `${spec.name} on the MCP`).toBe("public");
      }
    }
  });

  it("the writes are effect:write + public (the review rule: any user-owned-state mutation is session)", () => {
    for (const name of ["submit_track", "subscribe_newsletter"]) {
      expect(byName(name).effect, name).toBe("write");
      expect(byName(name).access, name).toBe("public");
    }

    for (const spec of SHARED_TOOL_SPECS) {
      if (spec.name !== "submit_track" && spec.name !== "subscribe_newsletter") {
        expect(spec.effect, spec.name).toBe("read");
      }
    }
  });
});

describe("list_similar_artists — the new artist-discovery read", () => {
  it("is a lore-canon read on MCP + chat, off WebMCP (a codified asymmetry)", () => {
    const spec = byName("list_similar_artists");
    expect(spec.tier).toBe("lore-canon");
    expect(spec.effect).toBe("read");
    expect(spec.transports.sort()).toEqual(["chat", "mcp"]);
  });

  it("takes a required name and an optional bounded limit", () => {
    const schema = toInputJsonSchema(byName("list_similar_artists")) as {
      properties: {
        limit: { maximum: number; minimum: number; type: string };
        name: { type: string };
      };
      required: string[];
    };

    expect(schema.properties.name.type).toBe("string");
    expect(schema.required).toEqual(["name"]);
    expect(schema.properties.limit).toMatchObject({ minimum: 1, type: "integer" });
  });
});

describe("the catalogue browse tools — the unlit register, by name (PR-5)", () => {
  const BROWSE_TOOLS = ["list_album_catalogue", "list_artist_catalogue", "list_label_catalogue"];

  it("are catalogue-tier reads on MCP + chat, off WebMCP (a codified asymmetry)", () => {
    for (const name of BROWSE_TOOLS) {
      const spec = byName(name);
      expect(spec.tier, name).toBe("catalogue");
      expect(spec.effect, name).toBe("read");
      expect(spec.access, name).toBe("public");
      expect(spec.transports.sort(), name).toEqual(["chat", "mcp"]);

      expect(spec.project, name).toEqual({ chat: "twoBucket", mcp: "publicRecord" });
    }
  });

  it("each takes a required name and an optional page", () => {
    for (const name of BROWSE_TOOLS) {
      const schema = toInputJsonSchema(byName(name)) as {
        properties: { name: { type: string }; page: { minimum: number; type: string } };
        required: string[];
      };

      expect(schema.properties.name.type, name).toBe("string");
      expect(schema.required, name).toEqual(["name"]);

      expect(schema.properties.page, name).toMatchObject({ minimum: 1, type: "integer" });
    }
  });

  it("states the certified split plainly and leaks no mechanism word (Flat Copy Test)", () => {
    for (const name of BROWSE_TOOLS) {
      const spec = byName(name);
      const text = `${spec.description} ${spec.title}`.toLowerCase();

      expect(text, `${name} description`).toContain("not certified as findings");
      expect(text, `${name} description`).toContain("log id");
      for (const banned of ["anti-join", "uncertified", "catalogue table"]) {
        expect(text, `${name} leaks "${banned}"`).not.toContain(banned);
      }
    }
  });
});

describe("the full A–Z browse tools (Slice F) — list_artists / list_albums / list_labels", () => {
  const LIST_ALL_TOOLS = ["list_artists", "list_albums", "list_labels"];

  it("are catalogue-tier reads on MCP + chat, register-neutral (browseIndex both ways)", () => {
    for (const name of LIST_ALL_TOOLS) {
      const spec = byName(name);
      expect(spec.tier, name).toBe("catalogue");
      expect(spec.effect, name).toBe("read");
      expect(spec.access, name).toBe("public");
      expect(spec.transports.sort(), name).toEqual(["chat", "mcp"]);

      expect(spec.project, name).toEqual({ chat: "browseIndex", mcp: "browseIndex" });
    }
  });

  it("take only an optional page (no required arg)", () => {
    for (const name of LIST_ALL_TOOLS) {
      const schema = toInputJsonSchema(byName(name)) as {
        properties: { page: { minimum: number; type: string } };
        required?: string[];
      };

      expect(schema.properties.page, name).toMatchObject({ minimum: 1, type: "integer" });
      expect(schema.required ?? [], name).toEqual([]);
    }
  });

  it("state the certified split plainly and leak no mechanism word (Flat Copy Test)", () => {
    for (const name of LIST_ALL_TOOLS) {
      const spec = byName(name);
      const text = `${spec.description} ${spec.title}`.toLowerCase();

      expect(text, `${name} description`).toContain("a to z");
      expect(text, `${name} description`).toContain("certified");
      expect(text, `${name} description`).toContain("log id");

      for (const banned of ["catalogue", "anti-join", "sitemap", "having", "renderable"]) {
        expect(text, `${name} leaks "${banned}"`).not.toContain(banned);
      }
    }
  });
});

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
