import { describe, expect, test } from "bun:test";

import { type LabelImagesSweepEffects, runLabelImagesSweep } from "./label-images-sweep";

const env = {
  DISCOGS_USER_TOKEN: "discogs-test-token",
  FLUNCLE_API_BASE_URL: "https://worker.example",
  FLUNCLE_API_TOKEN: "agent-test-token",
};

function workerFetch(responses: object[], bodies: unknown[]): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const inputUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(inputUrl);
    expect(url.origin).toBe("https://worker.example");
    expect(url.pathname).toBe("/api/v1/admin/backfill/label-images");
    expect(url.searchParams.get("boxFetch")).toBe("true");
    expect(url.searchParams.get("limit")).toBe("4");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer agent-test-token");
    if (init?.body !== undefined && typeof init.body !== "string") {
      throw new Error("expected a JSON string request body");
    }

    bodies.push(init?.body === undefined ? undefined : JSON.parse(init.body));

    const response = responses.shift();

    if (response === undefined) {
      throw new Error("unexpected Worker call");
    }

    return Response.json(response);
  }) as typeof globalThis.fetch;
}

describe("label image box-side Discogs split", () => {
  test("prepares in the Worker, fetches on the box, and submits bounded evidence for the verdict", async () => {
    const bodies: unknown[] = [];
    const candidate = {
      detail: {
        id: 22,
        images: [{ type: "primary" as const, uri: "https://img.example/logo.png" }],
      },
      discogsLabelId: 22,
      image: {
        bytesBase64: "AQID",
        mime: "image/png",
        uri: "https://img.example/logo.png",
      },
      slug: "hospital",
    };
    const seen: { token?: string; work?: unknown } = {};
    const effects: LabelImagesSweepEffects = {
      createFetcher: (token) => {
        seen.token = token;
        return {
          fetchLabelCandidates: async (work) => {
            seen.work = work;
            return { candidates: [candidate], ok: true, rateLimited: false };
          },
        };
      },
      env,
      fetch: workerFetch(
        [
          {
            discogsWork: [{ discogsLabelId: 22, slug: "hospital" }],
            failedCount: 0,
            noneCount: 0,
            ok: true,
            rateLimited: false,
            resolvedCount: 0,
          },
          {
            discogsWork: [],
            failedCount: 0,
            noneCount: 0,
            ok: true,
            rateLimited: false,
            resolvedCount: 1,
          },
        ],
        bodies,
      ),
    };

    const summary = await runLabelImagesSweep(effects);

    expect(seen.token).toBe("discogs-test-token");
    expect(seen.work).toEqual([{ discogsLabelId: 22, slug: "hospital" }]);
    expect(bodies).toEqual([undefined, { discogsCandidates: [candidate] }]);
    expect(summary).toMatchObject({
      checked: 1,
      errors: 0,
      ok: true,
      produced: 1,
      resolved: 1,
      resolvedCount: 1,
      throttled: false,
    });
  });

  test("a preparation-only outcome needs no Discogs or second Worker call", async () => {
    const bodies: unknown[] = [];
    let created = false;
    const summary = await runLabelImagesSweep({
      createFetcher: () => {
        created = true;
        throw new Error("unused");
      },
      env,
      fetch: workerFetch(
        [
          {
            discogsWork: [],
            failedCount: 0,
            noneCount: 1,
            ok: true,
            rateLimited: false,
            resolvedCount: 0,
          },
        ],
        bodies,
      ),
    });

    expect(created).toBe(false);
    expect(bodies).toEqual([undefined]);
    expect(summary).toMatchObject({ checked: 1, none: 1, ok: true, produced: 1 });
  });

  test("a Discogs throttle submits no partial evidence and remains a clean yielded tick", async () => {
    const bodies: unknown[] = [];
    const summary = await runLabelImagesSweep({
      createFetcher: () => ({
        fetchLabelCandidates: async () => ({
          candidates: [],
          error: "Discogs rate limit reached",
          ok: false,
          rateLimited: true,
        }),
      }),
      env,
      fetch: workerFetch(
        [
          {
            discogsWork: [{ discogsLabelId: 22, slug: "hospital" }],
            failedCount: 0,
            noneCount: 0,
            ok: true,
            rateLimited: false,
            resolvedCount: 0,
          },
        ],
        bodies,
      ),
    });

    expect(bodies).toEqual([undefined]);
    expect(summary).toMatchObject({ errors: 0, ok: true, resolved: 0, throttled: true });
  });

  test("a Discogs transport failure submits nothing and fails loudly", async () => {
    const bodies: unknown[] = [];
    const summary = await runLabelImagesSweep({
      createFetcher: () => ({
        fetchLabelCandidates: async () => ({
          candidates: [],
          error: "network failed",
          ok: false,
          rateLimited: false,
        }),
      }),
      env,
      fetch: workerFetch(
        [
          {
            discogsWork: [{ discogsLabelId: 22, slug: "hospital" }],
            failedCount: 0,
            noneCount: 0,
            ok: true,
            rateLimited: false,
            resolvedCount: 0,
          },
        ],
        bodies,
      ),
    });

    expect(bodies).toEqual([undefined]);
    expect(summary).toMatchObject({ error: "network failed", errors: 1, ok: false });
  });
});
