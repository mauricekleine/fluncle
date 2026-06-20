import { describe, expect, it } from "vitest";
import { appendOnionLocation, renderLlmsFull } from "./agent-discovery";
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
  });

  it("renders a finding with its coordinate and present facts", () => {
    const doc = renderLlmsFull(
      [
        finding({
          bpm: 172.94,
          galaxy: { key: "nebular", name: "Nebular" },
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

  it("defaults to the inert module constant (ships with no onion advertised)", () => {
    const url = new URL("https://www.fluncle.com/log/241.7.3A");
    const located = appendOnionLocation(htmlResponse(), url);

    expect(located.headers.get("Onion-Location")).toBeNull();
  });
});
