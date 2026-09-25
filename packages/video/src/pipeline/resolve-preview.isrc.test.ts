import assert from "node:assert/strict";

import { resolvePreview } from "./resolve-preview";

const realFetch = globalThis.fetch;

type Route = { body: unknown; match: string; ok?: boolean };

function installMockFetch(routes: Route[]): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    return {
      json: async () => route.body,
      ok: route.ok ?? true,
    } as Response;
  }) as typeof fetch;
  return { calls };
}

const REMIX = "In And Out Of Phase - Calyx & TeeBee Remix";
const ARTIST = "Bad Company UK";
const REMIX_ISRC = "GB1101200123";

const familyData = {
  data: [
    {
      artist: { name: ARTIST },
      preview: "https://cdn.deezer.com/ORIGINAL.mp3",
      title: "In And Out Of Phase",
    },
    {
      artist: { name: ARTIST },
      preview: "https://cdn.deezer.com/REMIX.mp3",
      title: "In And Out Of Phase - Calyx & TeeBee Remix",
    },
  ],
};

async function run(): Promise<void> {
  {
    const { calls } = installMockFetch([
      {
        body: { id: 999, preview: "https://cdn.deezer.com/remix-preview.mp3" },
        match: `track/isrc:${REMIX_ISRC}`,
      },
    ]);
    const preview = await resolvePreview({ artists: [ARTIST], isrc: REMIX_ISRC, title: REMIX });
    assert.equal(preview?.url, "https://cdn.deezer.com/remix-preview.mp3", "ISRC preview url");
    assert.equal(preview?.source, "deezer", "ISRC source is deezer");
    assert.ok((preview?.confidence ?? 0) >= 0.99, "ISRC confidence is maximal");
    assert.equal(calls.length, 1, "ISRC hit short-circuits — no fuzzy search/iTunes");
  }

  {
    installMockFetch([{ body: familyData, match: "api.deezer.com/search" }]);
    const preview = await resolvePreview({ artists: [ARTIST], title: REMIX });
    assert.equal(preview?.url, "https://cdn.deezer.com/REMIX.mp3", "remix wins over the original");
  }

  {
    const { calls } = installMockFetch([
      { body: { error: { code: 800 } }, match: `track/isrc:${REMIX_ISRC}` },
      { body: familyData, match: "api.deezer.com/search" },
    ]);
    const preview = await resolvePreview({ artists: [ARTIST], isrc: REMIX_ISRC, title: REMIX });
    assert.equal(preview?.url, "https://cdn.deezer.com/REMIX.mp3", "fallback resolves the remix");
    assert.ok(calls[0]?.includes(`track/isrc:${REMIX_ISRC}`), "ISRC tried first");
    assert.ok(
      calls.some((c) => c.includes("api.deezer.com/search")),
      "then the name search ran",
    );
  }

  {
    installMockFetch([
      {
        body: {
          data: [
            {
              artist: { name: ARTIST },
              preview: "https://cdn.deezer.com/REMIX.mp3",
              title: "In And Out Of Phase - Calyx & TeeBee Remix",
            },
            {
              artist: { name: ARTIST },
              preview: "https://cdn.deezer.com/ORIGINAL.mp3",
              title: "In And Out Of Phase",
            },
          ],
        },
        match: "api.deezer.com/search",
      },
    ]);
    const preview = await resolvePreview({ artists: [ARTIST], title: "In And Out Of Phase" });
    assert.equal(preview?.url, "https://cdn.deezer.com/ORIGINAL.mp3", "original ignores the remix");
  }

  {
    installMockFetch([
      {
        body: {
          data: [
            {
              artist: { name: ARTIST },
              preview: "https://cdn.deezer.com/ORIGINAL.mp3",
              title: "In And Out Of Phase",
            },
          ],
        },
        match: "api.deezer.com/search",
      },
      {
        body: {
          results: [
            {
              artistName: ARTIST,
              previewUrl: "https://itunes.example/REMIX.m4a",
              trackName: "In And Out Of Phase (Calyx & TeeBee Remix)",
            },
          ],
        },
        match: "itunes.apple.com/search",
      },
    ]);
    const preview = await resolvePreview({ artists: [ARTIST], title: REMIX });
    assert.equal(preview?.url, "https://itunes.example/REMIX.m4a", "iTunes remix wins");
    assert.equal(preview?.source, "itunes", "source is itunes");
  }

  {
    installMockFetch([
      {
        body: {
          data: [
            {
              artist: { name: ARTIST },
              preview: "https://cdn.deezer.com/ORIGINAL.mp3",
              title: "In And Out Of Phase",
            },
          ],
        },
        match: "api.deezer.com/search",
      },
      {
        body: {
          results: [
            {
              artistName: ARTIST,
              previewUrl: "https://itunes.example/ORIGINAL.m4a",
              trackName: "In And Out Of Phase",
            },
          ],
        },
        match: "itunes.apple.com/search",
      },
    ]);
    const preview = await resolvePreview({ artists: [ARTIST], title: REMIX });
    assert.equal(preview, null, "no version match → null, never the original");
  }

  console.log(
    "✓ resolve-preview: ISRC-first + version-aware Deezer/iTunes fallback (no remix→original)",
  );
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = realFetch;
  });
