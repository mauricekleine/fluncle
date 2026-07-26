import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TASTE_SHORTLIST } from "./mixability";
import { MAX_REC_SEEDS, RECOMMENDATIONS_POOL } from "./recommendations";
import {
  isSonarArtistsEnabled,
  isSonarLogEnabled,
  isSonarMixEnabled,
  isSonarRecsCatalogueEnabled,
  isSonarRecsEnabled,
  isSonarSonicEnabled,
  SONAR_MAX_PROBES,
  SONAR_MAX_TOP_K,
  searchSonar,
} from "./sonar";

// The client is the load-bearing safety seam: it must return `null` (⇒ the caller falls back to
// the Turso scan) on EVERY failure mode — unprovisioned env, non-2xx, timeout/throw, garbled body —
// and only route to sonar when both env vars are present and the reply is well-formed. The flag
// readers are default-DENY: only the literal "true" enables a surface.

const readOptionalEnv = vi.hoisted(() => vi.fn<(name: string) => Promise<string | undefined>>());
const getSetting = vi.hoisted(() => vi.fn<(key: string) => Promise<string | undefined>>());

vi.mock("./env", () => ({ readOptionalEnv }));
vi.mock("./settings", () => ({ getSetting, setSetting: vi.fn() }));

const fetchMock = vi.fn();

beforeEach(() => {
  readOptionalEnv.mockReset();
  readOptionalEnv.mockImplementation(async (name) => {
    if (name === "SONAR_BASE_URL") {
      return "https://sonar.test";
    }

    if (name === "SONAR_SECRET") {
      return "shhh";
    }

    return undefined;
  });
  getSetting.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A well-formed `POST /search` reply. */
function reply(matches: Array<{ id: string; score: number }>) {
  return { json: async () => ({ matches }), ok: true };
}

const REQUEST = { index: "tracks" as const, probes: [[0.1, 0.2]], topK: 5 };

describe("searchSonar — the triple-gated fallback client", () => {
  it("returns parsed matches when sonar answers OK", async () => {
    fetchMock.mockResolvedValue(
      reply([
        { id: "t2", score: 0.9 },
        { id: "t1", score: 0.8 },
      ]),
    );

    expect(await searchSonar(REQUEST)).toEqual([
      { id: "t2", score: 0.9 },
      { id: "t1", score: 0.8 },
    ]);
  });

  it("sends the secret header and maps the request to sonar's wire body", async () => {
    fetchMock.mockResolvedValue(reply([]));

    await searchSonar({
      excludeIds: ["x"],
      filter: { certified: true },
      index: "tracks",
      probes: [[0.1, 0.2]],
      topK: 5,
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];

    expect(url.toString()).toBe("https://sonar.test/search");
    expect((init.headers as Record<string, string>)["x-sonar-secret"]).toBe("shhh");
    expect(JSON.parse(init.body as string)).toEqual({
      exclude_ids: ["x"],
      filter: { certified: true },
      index: "tracks",
      probes: [[0.1, 0.2]],
      top_k: 5,
    });
  });

  it("returns a real EMPTY array when sonar answers with no matches", async () => {
    fetchMock.mockResolvedValue(reply([]));

    expect(await searchSonar(REQUEST)).toEqual([]);
  });

  it("returns null WITHOUT fetching when SONAR_SECRET is missing", async () => {
    readOptionalEnv.mockImplementation(async (name) =>
      name === "SONAR_BASE_URL" ? "https://sonar.test" : undefined,
    );

    expect(await searchSonar(REQUEST)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null WITHOUT fetching when SONAR_BASE_URL is missing", async () => {
    readOptionalEnv.mockImplementation(async (name) =>
      name === "SONAR_SECRET" ? "shhh" : undefined,
    );

    expect(await searchSonar(REQUEST)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on a non-2xx status", async () => {
    fetchMock.mockResolvedValue({ json: async () => ({}), ok: false, status: 503 });

    expect(await searchSonar(REQUEST)).toBeNull();
  });

  it("returns null when the request times out or the transport dies", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted", "TimeoutError"));

    expect(await searchSonar(REQUEST)).toBeNull();
  });

  it("puts the call on a deadline — a hung sonar must never become a slow page", async () => {
    fetchMock.mockResolvedValue(reply([]));

    await searchSonar(REQUEST);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;

    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns null when the body is missing `matches`", async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ nope: true }), ok: true });

    expect(await searchSonar(REQUEST)).toBeNull();
  });

  it("returns null when a match entry has the wrong shape", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ matches: [{ id: "t1", score: "high" }] }),
      ok: true,
    });

    expect(await searchSonar(REQUEST)).toBeNull();
  });

  // ── The request caps, at the boundary ──────────────────────────────────────────────────────
  //
  // The engine 400s an over-cap body (search.rs `cap_violation`); the client refuses to send one
  // at all. Both sides of each boundary are asserted so a raised constant cannot slip past.

  it("sends a topK AT the cap", async () => {
    fetchMock.mockResolvedValue(reply([{ id: "t1", score: 0.9 }]));

    expect(await searchSonar({ ...REQUEST, topK: SONAR_MAX_TOP_K })).toEqual([
      { id: "t1", score: 0.9 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back WITHOUT fetching when topK is one over the cap", async () => {
    expect(await searchSonar({ ...REQUEST, topK: SONAR_MAX_TOP_K + 1 })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a probe set AT the cap", async () => {
    fetchMock.mockResolvedValue(reply([{ id: "t1", score: 0.9 }]));

    const probes = Array.from({ length: SONAR_MAX_PROBES }, () => [0.1, 0.2]);

    expect(await searchSonar({ ...REQUEST, probes })).toEqual([{ id: "t1", score: 0.9 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back WITHOUT fetching when the probe set is one over the cap", async () => {
    const probes = Array.from({ length: SONAR_MAX_PROBES + 1 }, () => [0.1, 0.2]);

    expect(await searchSonar({ ...REQUEST, probes })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves every live call shape inside the caps", () => {
    // The widest legitimate calls in the tree: /mix's TASTE_SHORTLIST topK and
    // /recommendations' MAX_REC_SEEDS-wide probe set.
    expect(TASTE_SHORTLIST).toBeLessThanOrEqual(SONAR_MAX_TOP_K);
    expect(RECOMMENDATIONS_POOL).toBeLessThanOrEqual(SONAR_MAX_TOP_K);
    expect(MAX_REC_SEEDS).toBeLessThanOrEqual(SONAR_MAX_PROBES);
  });
});

describe("the dark flags — default OFF, only 'true' enables", () => {
  const cases: Array<[string, () => Promise<boolean>, string]> = [
    ["sonic", isSonarSonicEnabled, "sonar_sonic_enabled"],
    ["artists", isSonarArtistsEnabled, "sonar_artists_enabled"],
    ["log", isSonarLogEnabled, "sonar_log_enabled"],
    ["recs", isSonarRecsEnabled, "sonar_recs_enabled"],
    ["recs-catalogue", isSonarRecsCatalogueEnabled, "sonar_recs_catalogue_enabled"],
    ["mix", isSonarMixEnabled, "sonar_mix_enabled"],
  ];

  for (const [label, read, key] of cases) {
    it(`${label}: reads its own key and is ON only for the literal "true"`, async () => {
      getSetting.mockResolvedValue("true");
      expect(await read()).toBe(true);
      expect(getSetting).toHaveBeenCalledWith(key);

      getSetting.mockResolvedValue(undefined);
      expect(await read()).toBe(false);

      getSetting.mockResolvedValue("false");
      expect(await read()).toBe(false);

      getSetting.mockResolvedValue("TRUE");
      expect(await read()).toBe(false);
    });
  }
});
