import { describe, expect, it } from "vitest";
import { appendOnionLocation, handleAgentDiscovery, renderLlmsFull } from "./agent-discovery";
import { type TrackListItem } from "./tracks";

// A stand-in v3 onion hostname (56 base32 chars, correct shape, not a real
// address) so the test exercises the "set" state without an address in source.
const testOnion = "examplefluncleonionaddressplaceholder0000000000000000aaaa";

function htmlResponse(): Response {
  return new Response("<!doctype html><title>finding</title>", {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function jsonResponse(): Response {
  return new Response('{"ok":true}', {
    headers: { "Content-Type": "application/json" },
  });
}

function finding(overrides: Partial<TrackListItem>): TrackListItem {
  return {
    addedAt: "2026-06-15T20:00:00.000Z",
    addedToSpotify: true,
    artists: ["Camo & Krooked"],
    durationMs: 215_000,
    enrichmentStatus: "done",
    postedToTelegram: true,
    spotifyUrl: "https://open.spotify.com/track/abc",
    title: "Test Banger",
    trackId: "abc",
    ...overrides,
  };
}

describe("renderLlmsFull", () => {
  it("opens with the canonical description and the Log ID decode", () => {
    const doc = renderLlmsFull([], 0);

    expect(doc).toContain("Drum & bass bangers from another dimension.");
    expect(doc).toContain("How to read a Log ID");
    expect(doc).toContain("## The findings (0)");
    // The artist hub sits parallel to the labels + albums hubs (the human page, not
    // the API), and the mixtape surface is advertised too.
    expect(doc).toContain("The artists: https://www.fluncle.com/artists");
    expect(doc).toContain("The labels: https://www.fluncle.com/labels");
    expect(doc).toContain("The albums: https://www.fluncle.com/albums");
    expect(doc).toContain("/api/v1/mixtapes");
  });

  it("appends the album + label entity-page URLs a finding carries (graph traversal)", () => {
    const doc = renderLlmsFull(
      [finding({ albumSlug: "mosaik", labelSlug: "hospital-records", logId: "012.8.0A" })],
      1,
    );

    expect(doc).toContain("label https://www.fluncle.com/label/hospital-records");
    expect(doc).toContain("album https://www.fluncle.com/album/mosaik");
  });

  it("omits the graph line when a finding carries no album/label slug", () => {
    const doc = renderLlmsFull([finding({ logId: "012.8.0A" })], 1);

    expect(doc).not.toContain("/label/");
    expect(doc).not.toContain("/album/");
  });

  it("renders a finding with its coordinate and present facts", () => {
    const doc = renderLlmsFull(
      [
        finding({
          bpm: 172.94,
          galaxy: { name: "Nebular", slug: "nebular" },
          key: "F minor",
          logId: "012.8.0A",
        }),
      ],
      1,
    );

    expect(doc).toContain(
      "**Camo & Krooked — Test Banger** (found 2026-06-15, fluncle://012.8.0A)",
    );
    expect(doc).toContain(
      "173 BPM · F minor · Nebular galaxy · https://open.spotify.com/track/abc",
    );
  });

  it("omits absent facts and marks a finding without a Log ID", () => {
    const doc = renderLlmsFull([finding({})], 1);

    expect(doc).toContain("(found 2026-06-15, uncoordinated)");
    expect(doc).toContain("  https://open.spotify.com/track/abc");
    expect(doc).not.toContain("BPM");
  });

  it("notes omitted findings when the archive is truncated", () => {
    const doc = renderLlmsFull([finding({ logId: "012.8.0A" })], 30);

    expect(doc).toContain("29 older findings omitted");
  });

  it("advertises the sonic-galaxies API only once the map is named (launch gate)", () => {
    // Default (map not yet fully named): the galaxies lens stays out of the map, so
    // an agent is never pointed at a lens the launch gate 404s.
    expect(renderLlmsFull([], 0)).not.toContain("/api/v1/galaxies");
    // Named: the galaxies API joins the "More" pointer list.
    expect(renderLlmsFull([], 0, true)).toContain("The sonic galaxies: ");
    expect(renderLlmsFull([], 0, true)).toContain("/api/v1/galaxies");
  });
});

describe("handleAgentDiscovery — /llms.txt", () => {
  it("serves the static map as text/markdown (not the static text/plain)", async () => {
    const res = await handleAgentDiscovery(new Request("https://www.fluncle.com/llms.txt"));

    expect(res).toBeDefined();
    expect(res?.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");

    const body = await res?.text();
    // The SAME bytes as public/llms.txt — a single source of truth, re-typed.
    expect(body).toContain("# Fluncle");
    expect(body).toContain("Reading a Log ID");
  });
});

describe("handleAgentDiscovery — the fluncle-api SKILL.md tool list", () => {
  it("derives its tool list from the live MCP tool set, so it can never go stale", async () => {
    const { mcpToolNames } = await import("./mcp");
    const res = await handleAgentDiscovery(
      new Request("https://www.fluncle.com/.well-known/agent-skills/fluncle-api/SKILL.md"),
    );
    const body = (await res?.text()) ?? "";

    expect(res?.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    // Every realized MCP tool name — including Slice F's browse tools — appears verbatim; a tool
    // added or renamed shows up here without a hand-edit.
    for (const name of mcpToolNames) {
      expect(body, `SKILL.md is missing tool ${name}`).toContain(`\`${name}\``);
    }
    for (const name of ["list_artists", "list_albums", "list_labels"]) {
      expect(mcpToolNames, `${name} should be a live MCP tool`).toContain(name);
    }
  });
});

describe("handleAgentDiscovery — the A2A agent card", () => {
  async function fetchCard(path: string) {
    const res = await handleAgentDiscovery(new Request(`https://www.fluncle.com${path}`));

    expect(res).toBeDefined();
    expect(res?.headers.get("Content-Type")).toBe("application/json");
    expect(res?.headers.get("Cache-Control")).toBe("public, max-age=3600");

    return JSON.parse((await res?.text()) ?? "{}");
  }

  it("serves the SAME card at the canonical and the legacy well-known paths", async () => {
    // The current canonical A2A path and the legacy short path older clients still
    // probe must return byte-identical bytes — one source, two doors.
    const canonical = await handleAgentDiscovery(
      new Request("https://www.fluncle.com/.well-known/agent-card.json"),
    );
    const legacy = await handleAgentDiscovery(
      new Request("https://www.fluncle.com/.well-known/agent.json"),
    );

    expect(await canonical?.text()).toBe(await legacy?.text());
  });

  it("carries every A2A-required top-level field", async () => {
    const card = await fetchCard("/.well-known/agent-card.json");

    // The A2A v1.0 required set: protocolVersion, name, description, url, provider,
    // capabilities, skills. A missing one makes the card fail a conformant validator.
    for (const field of [
      "protocolVersion",
      "name",
      "description",
      "url",
      "provider",
      "capabilities",
      "skills",
    ]) {
      expect(card[field]).toBeDefined();
    }
  });

  it("uses the identity strings verbatim and points at the real actionable surface", async () => {
    const card = await fetchCard("/.well-known/agent-card.json");

    expect(card.name).toBe("Fluncle");
    // fluncleDescription (lib/identity.ts), reused verbatim as the MCP card does.
    expect(card.description).toContain("Drum & bass bangers from another dimension.");
    expect(card.url).toBe("https://www.fluncle.com/api/v1");
    expect(card.provider).toEqual({ organization: "Fluncle", url: "https://www.fluncle.com" });
    expect(card.documentationUrl).toBe("https://www.fluncle.com/llms.txt");
    expect(card.preferredTransport).toBe("HTTP+JSON");
  });

  it("declares an honest, non-conversational capability scope", async () => {
    const card = await fetchCard("/.well-known/agent-card.json");

    // Fluncle is a read + submit archive over HTTP, not a streaming/push A2A task agent —
    // so it must not claim either capability.
    expect(card.capabilities).toEqual({ pushNotifications: false, streaming: false });
  });

  it("advertises exactly the actionable public ops as skills — no invented capability", async () => {
    const card = await fetchCard("/.well-known/agent-card.json");

    // Each skill maps 1:1 to a real op the public API + MCP server expose (the MCP tool
    // list is the source of truth): search, the findings feed, the track enumerator,
    // read one, submit, subscribe.
    expect(card.skills.map((skill: { id: string }) => skill.id)).toEqual([
      "search-tracks",
      "list-findings",
      "list-tracks",
      "get-track",
      "submit-track",
      "subscribe-newsletter",
    ]);

    for (const skill of card.skills) {
      expect(typeof skill.name).toBe("string");
      expect(typeof skill.description).toBe("string");
      expect(Array.isArray(skill.tags)).toBe(true);
      expect(Array.isArray(skill.examples)).toBe(true);
    }
  });
});

describe("appendOnionLocation", () => {
  it("points an HTML response at the onion with the request's exact path", () => {
    const url = new URL("https://www.fluncle.com/log/241.7.3A");
    const located = appendOnionLocation(htmlResponse(), url, testOnion);

    expect(located.headers.get("Onion-Location")).toBe(`http://${testOnion}.onion/log/241.7.3A`);
  });

  it("preserves the query string on the onion URL", () => {
    const url = new URL("https://www.fluncle.com/log?page=2");
    const located = appendOnionLocation(htmlResponse(), url, testOnion);

    expect(located.headers.get("Onion-Location")).toBe(`http://${testOnion}.onion/log?page=2`);
  });

  it("does not advertise the onion on a JSON/XML response", () => {
    const url = new URL("https://www.fluncle.com/rss.xml");
    const located = appendOnionLocation(jsonResponse(), url, testOnion);

    expect(located.headers.get("Onion-Location")).toBeNull();
  });

  it("is inert when the onion hostname is unset, regardless of content type", () => {
    const url = new URL("https://www.fluncle.com/log/241.7.3A");

    expect(appendOnionLocation(htmlResponse(), url, "").headers.get("Onion-Location")).toBeNull();
    expect(appendOnionLocation(jsonResponse(), url, "").headers.get("Onion-Location")).toBeNull();
  });

  it("defaults to the live module constant (advertises the web onion per-path)", () => {
    const url = new URL("https://www.fluncle.com/log/241.7.3A");
    const located = appendOnionLocation(htmlResponse(), url);

    expect(located.headers.get("Onion-Location")).toMatch(
      /^http:\/\/[a-z2-7]{56}\.onion\/log\/241\.7\.3A$/,
    );
  });
});
