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

    const probeUrl = calls[0]?.url ?? "";
    expect(probeUrl).toMatch(/\/api\/admin\/tracks\/004\.6\.0K\/preview$/);
    expect(result?.url).toBe(probeUrl.replace(/\/preview$/, "/preview-audio"));

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

    expect(calls[0]?.url).toMatch(/\/api\/admin\/tracks\/weird%2Fid%3Fx\/preview$/);
    expect(result?.url).toMatch(/\/api\/admin\/tracks\/weird%2Fid%3Fx\/preview-audio$/);
  });
});
