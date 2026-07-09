// resolveArchivedPreview points the render at the AGENT-tier preview-audio route
// (the private R2 archive), together with the bearer headers needed to fetch it.
// It probes the cheap metadata route first so a track with no archive returns
// null HERE — the caller then falls back to the live Deezer/iTunes search. These
// tests drive it through a swapped global fetch, so they never touch the network.

import { afterEach, describe, expect, test } from "bun:test";

import { resolveArchivedPreview } from "./resolve-archived-preview";

const realFetch = globalThis.fetch;
const realToken = process.env.FLUNCLE_API_TOKEN;

type MetadataResponse = { body?: unknown; ok?: boolean };

function installMockFetch(response: MetadataResponse | (() => never)): {
  calls: { init: RequestInit | undefined; url: string }[];
} {
  const calls: { init: RequestInit | undefined; url: string }[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ init, url });
    if (typeof response === "function") {
      return response();
    }
    return {
      json: async () => response.body,
      ok: response.ok ?? true,
    } as Response;
  }) as typeof fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realToken === undefined) {
    delete process.env.FLUNCLE_API_TOKEN;
  } else {
    process.env.FLUNCLE_API_TOKEN = realToken;
  }
});

describe("resolveArchivedPreview", () => {
  test("returns null with no admin token (local dev) — never touches the network", async () => {
    delete process.env.FLUNCLE_API_TOKEN;
    const { calls } = installMockFetch({ body: { archived: true } });

    const result = await resolveArchivedPreview("004.6.0K");

    expect(result).toBeNull();
    expect(calls.length).toBe(0);
  });

  test("archived: resolves the preview-audio route WITH the bearer headers", async () => {
    process.env.FLUNCLE_API_TOKEN = "secret-agent-token";
    const { calls } = installMockFetch({ body: { archived: true, key: "abc/def.mp3" } });

    const result = await resolveArchivedPreview("004.6.0K");

    expect(result?.confidence).toBe(1);
    expect(result?.source).toBe("archive");
    expect(result?.headers).toEqual({ authorization: "Bearer secret-agent-token" });
    // The audio url is the metadata-probe url with `/preview` → `/preview-audio`
    // (base decoupled from FLUNCLE_API_URL, which is captured once at import).
    const probeUrl = calls[0]?.url ?? "";
    expect(probeUrl).toMatch(/\/api\/admin\/tracks\/004\.6\.0K\/preview$/);
    expect(result?.url).toBe(probeUrl.replace(/\/preview$/, "/preview-audio"));
    // The metadata probe carried the bearer too.
    expect((calls[0]?.init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer secret-agent-token",
    );
  });

  test("no archive on the track → null (caller falls back to live search)", async () => {
    process.env.FLUNCLE_API_TOKEN = "secret-agent-token";
    installMockFetch({ body: { archived: false } });

    expect(await resolveArchivedPreview("004.6.0K")).toBeNull();
  });

  test("non-ok metadata response → null", async () => {
    process.env.FLUNCLE_API_TOKEN = "secret-agent-token";
    installMockFetch({ body: {}, ok: false });

    expect(await resolveArchivedPreview("004.6.0K")).toBeNull();
  });

  test("a thrown fetch → null (never propagates)", async () => {
    process.env.FLUNCLE_API_TOKEN = "secret-agent-token";
    installMockFetch(() => {
      throw new Error("network down");
    });

    expect(await resolveArchivedPreview("004.6.0K")).toBeNull();
  });

  test("url-encodes the id in both the probe and the audio url", async () => {
    process.env.FLUNCLE_API_TOKEN = "secret-agent-token";
    const { calls } = installMockFetch({ body: { archived: true } });

    const result = await resolveArchivedPreview("weird/id?x");

    // The id is percent-encoded in both the probe and the audio url (base is
    // captured once at import, so assert the encoded path, not the whole origin).
    expect(calls[0]?.url).toMatch(/\/api\/admin\/tracks\/weird%2Fid%3Fx\/preview$/);
    expect(result?.url).toMatch(/\/api\/admin\/tracks\/weird%2Fid%3Fx\/preview-audio$/);
  });
});
