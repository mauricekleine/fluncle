import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyDiscoveryHref,
  classifySearchQueryKind,
  DISCOVERY_EVENTS,
  emitDiscoveryEvent,
  emitDiscoveryFromHref,
  shouldEmitDiscoveryPreview,
} from "./discovery-events";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discovery event vocabulary", () => {
  it("is six names, each one journey step", () => {
    expect([...DISCOVERY_EVENTS]).toEqual([
      "discovery_search",
      "discovery_example",
      "discovery_open",
      "discovery_similar",
      "discovery_preview",
      "discovery_outbound",
    ]);
  });
});

describe("classifySearchQueryKind — bounded categories, never the typed text", () => {
  it("reads a coordinate, a sonic phrase, a bare token, and folds the rest to other", () => {
    expect(classifySearchQueryKind("004.7.2I")).toBe("coordinate");
    expect(classifySearchQueryKind("tracks that sound like Nine Clouds")).toBe("sonic");
    expect(classifySearchQueryKind("netsky")).toBe("token");
    expect(classifySearchQueryKind("Hospital Records")).toBe("other");
  });
});

describe("classifyDiscoveryHref — resolved destination, not the English on the control", () => {
  it("treats a worked example link as discovery_example", () => {
    expect(classifyDiscoveryHref("/search?q=netsky")).toEqual({
      event: "discovery_example",
      metadata: { kind: "token" },
    });
    expect(classifyDiscoveryHref("/search?q=tracks%20that%20sound%20like%20Nine%20Clouds")).toEqual(
      {
        event: "discovery_example",
        metadata: { kind: "sonic" },
      },
    );
  });

  it("treats a non-example /search?q= as discovery_search with the query KIND only", () => {
    expect(classifyDiscoveryHref("/search?q=Aurora")).toEqual({
      event: "discovery_search",
      metadata: { kind: "token" },
    });
  });

  it("opens finding and track destinations, and classifies a fallback listen as outbound", () => {
    expect(classifyDiscoveryHref("/log/701.1.0A")).toEqual({
      event: "discovery_open",
      metadata: { kind: "finding" },
    });
    expect(classifyDiscoveryHref("/track/mb_2b1c4d5e")).toEqual({
      event: "discovery_open",
      metadata: { kind: "track" },
    });
    expect(classifyDiscoveryHref("https://open.spotify.com/track/abc")).toEqual({
      event: "discovery_outbound",
      metadata: { service: "spotify" },
    });
  });

  it("names graph destinations by path, and mixtape coordinates by the F orbit", () => {
    expect(classifyDiscoveryHref("/artist/nova-kestrel")?.metadata).toEqual({ kind: "artist" });
    expect(classifyDiscoveryHref("/label/driftwave-audio")?.metadata).toEqual({ kind: "label" });
    expect(classifyDiscoveryHref("/album/signal-bloom")?.metadata).toEqual({ kind: "album" });
    expect(classifyDiscoveryHref("/galaxies/kalyx")?.metadata).toEqual({ kind: "galaxy" });
    expect(classifyDiscoveryHref("/log/700.F.1A")).toEqual({
      event: "discovery_open",
      metadata: { kind: "mixtape" },
    });
  });

  it("reclassifies a neighbour rail click as discovery_similar", () => {
    expect(classifyDiscoveryHref("/log/702.2.0B", { similar: true })).toEqual({
      event: "discovery_similar",
      metadata: { kind: "finding" },
    });
    expect(classifyDiscoveryHref("/artist/cobalt-mirage", { similar: true })).toEqual({
      event: "discovery_similar",
      metadata: { kind: "artist" },
    });
    expect(classifyDiscoveryHref("/track/mb_2b1c4d5e", { similar: true })).toEqual({
      event: "discovery_similar",
      metadata: { kind: "track" },
    });
  });

  it("ignores hubs, chrome, and non-listening outbound", () => {
    expect(classifyDiscoveryHref("/findings")).toBeUndefined();
    expect(classifyDiscoveryHref("/tracks")).toBeUndefined();
    expect(classifyDiscoveryHref("/search")).toBeUndefined();
    expect(classifyDiscoveryHref("https://www.tiktok.com/@fluncle")).toBeUndefined();
    expect(classifyDiscoveryHref("https://www.discogs.com/release/1")).toBeUndefined();
  });
});

describe("shouldEmitDiscoveryPreview", () => {
  it("emits only when a call site opts into a public visitor preview", () => {
    expect(shouldEmitDiscoveryPreview()).toBe(false);
    expect(shouldEmitDiscoveryPreview(undefined)).toBe(false);
    expect(shouldEmitDiscoveryPreview({})).toBe(false);
    expect(shouldEmitDiscoveryPreview({ src: undefined })).toBe(false);
    expect(shouldEmitDiscoveryPreview({ src: "/api/v1/admin/tracks/x/source-audio" })).toBe(false);
    expect(shouldEmitDiscoveryPreview({ publicPreview: false })).toBe(false);
    expect(shouldEmitDiscoveryPreview({ publicPreview: true })).toBe(true);
  });
});

describe("emitDiscoveryEvent — never throws, never on import, once per call", () => {
  it("is a no-op when sa_event is absent", () => {
    vi.stubGlobal("window", {});

    expect(() => emitDiscoveryEvent("discovery_preview")).not.toThrow();
  });

  it("is a no-op when sa_event throws", () => {
    vi.stubGlobal("window", {
      sa_event: () => {
        throw new Error("blocked");
      },
    });

    expect(() => emitDiscoveryEvent("discovery_outbound", { service: "spotify" })).not.toThrow();
  });

  it("emits once per call and never ships raw query text or unknown fields", () => {
    const calls: unknown[][] = [];

    vi.stubGlobal("window", {
      sa_event: (...args: unknown[]) => {
        calls.push(args);
      },
    });

    emitDiscoveryEvent("discovery_search", { kind: "token" });
    emitDiscoveryEvent("discovery_search", { kind: "token" });
    emitDiscoveryFromHref("/log/701.1.0A");
    emitDiscoveryEvent("discovery_search", { kind: "not-a-kind" as "token" });
    emitDiscoveryEvent("discovery_outbound", {
      kind: "finding",
      service: "spotify",
    } as { service: "spotify" });

    expect(calls).toEqual([
      ["discovery_search", { kind: "token" }],
      ["discovery_search", { kind: "token" }],
      ["discovery_open", { kind: "finding" }],
      ["discovery_search"],
      ["discovery_outbound", { service: "spotify" }],
    ]);

    const serialized = JSON.stringify(calls);

    expect(serialized).not.toMatch(/netsky|Aurora|701\.1\.0A|session|user|profile/i);
  });
});
