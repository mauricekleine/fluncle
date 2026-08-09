import { describe, expect, test } from "bun:test";

import { createDiscogsFetcher } from "./discogs-fetch";

type PlannedResponse = {
  body?: BodyInit | object;
  headers?: Record<string, string>;
  status?: number;
};

function harness(plans: PlannedResponse[]) {
  let clock = 0;
  const calls: Array<{ headers: Headers; time: number; url: string }> = [];
  const sleeps: number[] = [];

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const plan = plans.shift();

    if (plan === undefined) {
      throw new Error("unexpected fetch");
    }

    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ headers: new Headers(init?.headers), time: clock, url });
    const body =
      plan.body !== undefined &&
      typeof plan.body === "object" &&
      !(plan.body instanceof Blob) &&
      !(plan.body instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(plan.body)
        ? JSON.stringify(plan.body)
        : plan.body;

    return new Response(body as BodyInit | null | undefined, {
      headers: plan.headers,
      status: plan.status ?? 200,
    });
  };

  const sleep = async (milliseconds: number): Promise<void> => {
    sleeps.push(milliseconds);
    clock += milliseconds;
  };

  return { calls, fetch, now: () => clock, sleep, sleeps };
}

describe("box-side Discogs fetch", () => {
  test("paces every request and sends the authenticated identifiable headers", async () => {
    const fake = harness([
      { body: { results: [{ id: 41, master_id: 91 }] } },
      { body: { id: 41, title: "Release", tracklist: [{ title: "Tune" }] } },
    ]);
    const fetcher = createDiscogsFetcher("token-value", fake);

    const result = await fetcher.fetchReleaseCandidates([
      { queries: ["track=Tune&artist=Artist&type=release"], trackId: "trk_1" },
    ]);

    expect(result.ok).toBe(true);
    expect(fake.calls.map((call) => call.time)).toEqual([0, 1_100]);
    expect(fake.sleeps).toEqual([1_100]);
    expect(fake.calls[0]?.headers.get("Authorization")).toBe("Discogs token=token-value");
    expect(fake.calls[0]?.headers.get("User-Agent")).toBe("Fluncle/1.0 (+https://www.fluncle.com)");
    expect(result.candidates).toEqual([
      {
        releases: [
          {
            artists: [],
            formats: [],
            id: 41,
            labels: [],
            searchMasterId: 91,
            styles: [],
            title: "Release",
            tracklist: [{ title: "Tune" }],
          },
        ],
        trackId: "trk_1",
      },
    ]);
  });

  test("represents a completed zero-hit search explicitly", async () => {
    const fake = harness([{ body: { results: [] } }]);
    const result = await createDiscogsFetcher("token", fake).fetchReleaseCandidates([
      { queries: ["track=Missing&type=release"], trackId: "trk_empty" },
    ]);

    expect(result).toEqual({
      candidates: [{ releases: [], trackId: "trk_empty" }],
      ok: true,
      rateLimited: false,
    });
  });

  test("deduplicates releases and bounds every normalized evidence axis", async () => {
    const long = "x".repeat(700);
    const fake = harness([
      {
        body: {
          results: [
            { id: 7, master_id: 8 },
            { id: 7, master_id: 9 },
            { id: 10 },
            { id: 11 },
            { id: 12 },
          ],
        },
      },
      {
        body: {
          artists: Array.from({ length: 25 }, () => ({ name: long })),
          formats: Array.from({ length: 25 }, () => ({ name: long })),
          id: 7,
          labels: Array.from({ length: 25 }, () => ({ catno: long, name: long })),
          styles: Array.from({ length: 55 }, () => long),
          title: long,
          tracklist: Array.from({ length: 505 }, () => ({ title: long })),
          year: 42,
        },
      },
      { body: { id: 10 } },
      { body: { id: 11 } },
    ]);
    const result = await createDiscogsFetcher("token", fake).fetchReleaseCandidates([
      { queries: ["track=Bounded&type=release"], trackId: "trk_bounds" },
    ]);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error(result.error);
    }

    const release = result.candidates[0]?.releases[0];
    expect(result.candidates[0]?.releases).toHaveLength(3);
    expect(release?.artists).toHaveLength(20);
    expect(release?.formats).toHaveLength(20);
    expect(release?.labels).toHaveLength(20);
    expect(release?.styles).toHaveLength(50);
    expect(release?.tracklist).toHaveLength(500);
    expect(release?.title).toHaveLength(500);
    expect(release?.artists[0]?.name).toHaveLength(500);
    expect(release).not.toHaveProperty("year");
    expect(release?.searchMasterId).toBe(8);
  });

  test("downloads the primary label image through the same pacing gate", async () => {
    const primary = "https://img.discogs.com/primary.png";
    const fake = harness([
      {
        body: {
          id: 22,
          images: [
            { type: "secondary", uri: "https://img.discogs.com/secondary.png" },
            { type: "primary", uri: primary },
          ],
        },
      },
      { body: new Uint8Array([1, 2, 3]), headers: { "content-type": "image/png" } },
    ]);
    const result = await createDiscogsFetcher("token", fake).fetchLabelCandidates([
      { discogsLabelId: 22, slug: "hospital" },
    ]);

    expect(result.ok).toBe(true);
    expect(fake.calls[1]?.url).toBe(primary);
    expect(fake.calls[1]?.time).toBe(1_100);

    if (result.ok) {
      expect(result.candidates[0]?.image).toEqual({
        bytesBase64: "AQID",
        mime: "image/png",
        uri: primary,
      });
    }
  });

  test("rejects an oversized label image without reading its body", async () => {
    const fake = harness([
      {
        body: { id: 22, images: [{ type: "primary", uri: "https://img.discogs.com/a.png" }] },
      },
      {
        body: new Uint8Array([1]),
        headers: { "content-length": "5000001", "content-type": "image/png" },
      },
    ]);
    const result = await createDiscogsFetcher("token", fake).fetchLabelCandidates([
      { discogsLabelId: 22, slug: "hospital" },
    ]);

    expect(result).toMatchObject({ candidates: [], ok: false, rateLimited: false });
    expect(result.ok ? "" : result.error).toContain("5 MB");
  });

  test("never forwards the Discogs token to an untrusted image host", async () => {
    const fake = harness([
      {
        body: {
          id: 22,
          images: [{ type: "primary", uri: "https://attacker.example/logo.png" }],
        },
      },
    ]);
    const result = await createDiscogsFetcher("token", fake).fetchLabelCandidates([
      { discogsLabelId: 22, slug: "hospital" },
    ]);

    expect(result).toMatchObject({ candidates: [], ok: false, rateLimited: false });
    expect(fake.calls).toHaveLength(1);
  });

  test("stops on a proactive rate-limit header and makes no later calls", async () => {
    const fake = harness([
      {
        body: { results: [] },
        headers: { "X-Discogs-Ratelimit-Remaining": "1" },
      },
    ]);
    const fetcher = createDiscogsFetcher("token", fake);
    const release = await fetcher.fetchReleaseCandidates([
      { queries: ["track=One&type=release"], trackId: "trk_1" },
    ]);
    const facts = await fetcher.fetchFactsCandidates([{ releaseId: 1, slug: "album" }]);

    expect(release).toMatchObject({ candidates: [], ok: false, rateLimited: true });
    expect(facts).toMatchObject({ candidates: [], ok: false, rateLimited: true });
    expect(fake.calls).toHaveLength(1);
  });

  test("treats HTTP 429 as a throttle, never as a clean empty batch", async () => {
    const fake = harness([{ body: { message: "rate limit" }, status: 429 }]);
    const result = await createDiscogsFetcher("token", fake).fetchFactsCandidates([
      { releaseId: 7, slug: "album" },
    ]);

    expect(result).toMatchObject({ candidates: [], ok: false, rateLimited: true });
  });

  test("discards a partial batch when a later vendor request fails", async () => {
    const fake = harness([{ body: { id: 1 } }, { body: { message: "broken" }, status: 500 }]);
    const result = await createDiscogsFetcher("token", fake).fetchFactsCandidates([
      { releaseId: 1, slug: "first" },
      { releaseId: 2, slug: "second" },
    ]);

    expect(result).toMatchObject({ candidates: [], ok: false, rateLimited: false });
  });
});
