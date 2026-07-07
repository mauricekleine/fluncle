import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Instagram Reel push (lib/server/postiz.ts `pushInstagramReel`). Verifies the
// three-call request shape against a mocked fetch: resolve the connected IG integration
// → upload-from-url (Postiz pulls the public clip MP4) → POST /posts with the Reel
// settings (`__type` = the matched integration identifier, `post_type: "post"`, `type:
// "now"`). `./env` is mocked so no real key/URL is read.

vi.mock("./env", () => ({
  readEnv: async () => "test-key",
  readOptionalEnv: async () => undefined,
}));

import { pushInstagramReel, resolveSocialUrl } from "./postiz";

const BASE = "https://api.postiz.com/public/v1";

// A fetch double that routes by path to the three staged responses.
function stubFetch(overrides: {
  integrations?: Array<{ disabled?: boolean; id: string; identifier: string }>;
  postId?: string;
}) {
  const integrations = overrides.integrations ?? [{ id: "ig-123", identifier: "instagram" }];
  const calls: Array<{ body?: unknown; method: string; url: string }> = [];

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ body, method, url });

    if (url === `${BASE}/integrations`) {
      return new Response(JSON.stringify(integrations), { status: 200 });
    }

    if (url === `${BASE}/upload-from-url`) {
      return new Response(JSON.stringify({ id: "media-1", path: "https://cdn/media-1.mp4" }), {
        status: 200,
      });
    }

    if (url === `${BASE}/posts`) {
      return new Response(
        JSON.stringify([{ integration: "ig-123", postId: overrides.postId ?? "post-9" }]),
        { status: 200 },
      );
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pushInstagramReel", () => {
  it("resolves the IG integration, uploads, and posts a Reel with the right shape", async () => {
    const calls = stubFetch({});

    const result = await pushInstagramReel({
      caption: "a clip caption\n\nfluncle://2026.F.01",
      videoUrl: "https://found.fluncle.com/clip-1/footage.mp4",
    });

    expect(result).toEqual({ postId: "post-9" });

    // 1) GET /integrations, 2) POST /upload-from-url, 3) POST /posts.
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/integrations`,
      `${BASE}/upload-from-url`,
      `${BASE}/posts`,
    ]);

    // upload-from-url pulls the public clip MP4.
    expect(calls[1]?.body).toEqual({ url: "https://found.fluncle.com/clip-1/footage.mp4" });

    // The post: a single video + Reel settings, sent NOW.
    const post = calls[2]?.body as {
      posts: Array<{
        integration: { id: string };
        settings: Record<string, unknown>;
        value: Array<{ content: string; image: Array<{ id: string; path: string }> }>;
      }>;
      type: string;
    };
    expect(post.type).toBe("now");
    expect(post.posts[0]?.integration).toEqual({ id: "ig-123" });
    expect(post.posts[0]?.settings).toEqual({ __type: "instagram", post_type: "post" });
    expect(post.posts[0]?.value[0]?.content).toBe("a clip caption\n\nfluncle://2026.F.01");
    expect(post.posts[0]?.value[0]?.image).toEqual([
      { id: "media-1", path: "https://cdn/media-1.mp4" },
    ]);
  });

  it("echoes the matched identifier as __type (instagram-standalone)", async () => {
    const calls = stubFetch({
      integrations: [{ id: "ig-std", identifier: "instagram-standalone" }],
    });

    await pushInstagramReel({ caption: "c", videoUrl: "https://found.fluncle.com/x/footage.mp4" });

    const post = calls[2]?.body as { posts: Array<{ settings: Record<string, unknown> }> };
    expect(post.posts[0]?.settings.__type).toBe("instagram-standalone");
  });

  it("throws a clear error when no IG channel is connected", async () => {
    stubFetch({ integrations: [{ id: "yt", identifier: "youtube" }] });

    await expect(
      pushInstagramReel({ caption: "c", videoUrl: "https://found.fluncle.com/x/footage.mp4" }),
    ).rejects.toThrow(/No connected instagram channel/);
  });
});

// The Instagram permalink capture (`resolveSocialUrl(postId, "instagram")`): once the Reel
// publishes, Postiz auto-populates the real Graph-API permalink onto the post object in the
// dated `/posts` list. We capture it VERBATIM (a Reel shortcode can't be rebuilt from the
// numeric media id). `./env` is mocked, so `getDatedPosts` reads from the fetch double.
function stubDatedPosts(posts: unknown[]) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET" && url.startsWith(`${BASE}/posts`)) {
      return new Response(JSON.stringify({ posts }), { status: 200 });
    }

    throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
}

describe("resolveSocialUrl (instagram)", () => {
  it("captures a published Reel's real permalink verbatim + the media id", async () => {
    stubDatedPosts([
      {
        id: "post-9",
        releaseId: "media-9",
        releaseURL: "https://www.instagram.com/reel/AbC123/",
        state: "PUBLISHED",
      },
    ]);

    const resolved = await resolveSocialUrl("post-9", "instagram");

    expect(resolved).toEqual({
      nativeId: "media-9",
      url: "https://www.instagram.com/reel/AbC123/",
    });
  });

  it("returns null when the Reel isn't published yet (retried next tick)", async () => {
    stubDatedPosts([{ id: "post-9", releaseId: "", releaseURL: "", state: "QUEUE" }]);

    expect(await resolveSocialUrl("post-9", "instagram")).toBeNull();
  });

  it("returns null when the published post carries no real Instagram URL", async () => {
    stubDatedPosts([
      {
        id: "post-9",
        releaseId: "media-9",
        releaseURL: "https://api.postiz.com/messages?foo=bar",
        state: "PUBLISHED",
      },
    ]);

    expect(await resolveSocialUrl("post-9", "instagram")).toBeNull();
  });

  it("returns null when the post id isn't in the dated window", async () => {
    stubDatedPosts([
      {
        id: "someone-else",
        releaseId: "media-x",
        releaseURL: "https://www.instagram.com/reel/Zzz/",
        state: "PUBLISHED",
      },
    ]);

    expect(await resolveSocialUrl("post-9", "instagram")).toBeNull();
  });
});
