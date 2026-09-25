import { expect, test } from "@playwright/test";
import { LONG_FORM_MS } from "../../src/lib/catalogue-eligibility";
import { SEARCH_STYLES } from "../../src/lib/search-styles";
import { SEEDED_DESTINATION_NEIGHBOUR, SEEDED_DESTINATION_TRACK, SEEDED_STYLE } from "./seed";
import { SONAR_URL } from "./stack";

const SECRET = "e2e-fake-sonar-secret";

function axisProbe(axis: number): number[] {
  return Array.from({ length: 1024 }, (_unused, index) => (index === axis ? 1 : 0));
}

test("fake Sonar authenticates and ranks the live seed with exact supported filters", async ({
  request,
}) => {
  const health = await request.get(`${SONAR_URL}/health`);
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ ok: true });

  const rankedBody = {
    exclude_ids: [],
    filter: {},
    index: "tracks",
    probes: [axisProbe(40)],
    top_k: SEEDED_STYLE.rankedTrackIds.length,
  };
  const unauthorized = await request.post(`${SONAR_URL}/search`, { data: rankedBody });
  expect(unauthorized.status()).toBe(401);

  const ranked = await request.post(`${SONAR_URL}/search`, {
    data: rankedBody,
    headers: { "x-sonar-secret": SECRET },
  });
  expect(ranked.status()).toBe(200);
  const rankedMatches = (await ranked.json()) as { matches: { id: string; score: number }[] };
  expect(rankedMatches.matches.map((match) => match.id)).toEqual(SEEDED_STYLE.rankedTrackIds);
  expect(rankedMatches.matches.map((match) => match.score)).toEqual(
    rankedMatches.matches.map((match) => match.score).sort((a, b) => b - a),
  );

  const centroids = await request.post(`${SONAR_URL}/search`, {
    data: { ...rankedBody, index: "centroids", top_k: SEARCH_STYLES[0].anchors.length },
    headers: { "x-sonar-secret": SECRET },
  });
  expect(centroids.status()).toBe(200);
  const centroidMatches = (await centroids.json()) as { matches: { id: string }[] };
  expect(centroidMatches.matches.map((match) => match.id)).toEqual(
    SEARCH_STYLES[0].anchors.map((slug) => `e2e-style-artist-${slug}`).sort(),
  );

  const filtered = await request.post(`${SONAR_URL}/search`, {
    data: {
      ...rankedBody,
      exclude_ids: [SEEDED_DESTINATION_TRACK.trackId],
      filter: {
        bpm_max: 174,
        bpm_min: 174,
        duration_ms_max: LONG_FORM_MS,
        has_finding: false,
        key_in: ["F minor"],
      },
      probes: [axisProbe(6)],
      top_k: 1,
    },
    headers: { "x-sonar-secret": SECRET },
  });
  expect(filtered.status()).toBe(200);
  expect(await filtered.json()).toMatchObject({
    matches: [{ id: SEEDED_DESTINATION_NEIGHBOUR.trackId }],
  });

  const unsupported = await request.post(`${SONAR_URL}/search`, {
    data: { ...rankedBody, filter: { unknown_filter: true } },
    headers: { "x-sonar-secret": SECRET },
  });
  expect(unsupported.status()).toBe(400);
});
