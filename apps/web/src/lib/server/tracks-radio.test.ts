import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRandomRadioTrack } from "./tracks";

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

// A finding's two radio-eligibility signals: a clean SQUARE master
// (`video_squared_at`, so the crop is clean / no baked text) and an OBSERVATION
// (`observation_audio_url`, the only audio radio plays). The mocked DB applies
// the SAME `is not null AND is not null` predicate the real SQL carries, so the
// test proves an ineligible finding can never be returned.
type StoredTrack = {
  observation_audio_url: string | null;
  title: string;
  track_id: string;
  video_squared_at: string | null;
};

const archive: StoredTrack[] = [
  // Eligible: squared + observed.
  {
    observation_audio_url: "https://found.fluncle.com/003.1.1A/observation.mp3",
    title: "Eligible",
    track_id: "track-eligible",
    video_squared_at: "2026-06-10T00:00:00.000Z",
  },
  // Ineligible: squared but NO observation.
  {
    observation_audio_url: null,
    title: "No Observation",
    track_id: "track-no-observation",
    video_squared_at: "2026-06-09T00:00:00.000Z",
  },
  // Ineligible: observed but NOT squared (would be the old baked-text cut).
  {
    observation_audio_url: "https://found.fluncle.com/002.5.9Z/observation.mp3",
    title: "Not Squared",
    track_id: "track-not-squared",
    video_squared_at: null,
  },
  // Ineligible: neither.
  {
    observation_audio_url: null,
    title: "Bare",
    track_id: "track-bare",
    video_squared_at: null,
  },
];

function baseRow(stored: StoredTrack) {
  return {
    ...stored,
    added_at: "2026-06-10T00:00:00.000Z",
    added_to_spotify: 1,
    album: "Album",
    album_image_url: "https://example.com/cover.jpg",
    artists_json: JSON.stringify(["Some Artist"]),
    bpm: 174,
    duration_ms: 180000,
    enrichment_status: "done",
    features_json: null,
    in_release_id: null,
    isrc: null,
    key: "F",
    label: "Some Label",
    log_id: "003.1.1A",
    note: null,
    observation_duration_ms: 30000,
    observation_generated_at: "2026-06-10T00:00:00.000Z",
    popularity: null,
    posted_to_telegram: 1,
    preview_url: null,
    release_date: "2026-01-01",
    spotify_url: `https://open.spotify.com/track/${stored.track_id}`,
    tiktok_url: null,
    updated_at: null,
    vibe_x: 0.4,
    vibe_y: -0.2,
    video_model: null,
    video_model_reasoning: null,
    video_url: "https://found.fluncle.com/003.1.1A/footage.mp4",
    video_vehicle: null,
    youtube_url: null,
  };
}

// Apply the real eligibility predicates the SQL `where` clause carries, then take
// one at random (the function's `order by random() limit 1`).
function runEligibleQuery() {
  const eligible = archive.filter(
    (t) => t.video_squared_at !== null && t.observation_audio_url !== null,
  );

  if (eligible.length === 0) {
    return [];
  }
  const picked = eligible[Math.floor(Math.random() * eligible.length)];
  if (picked === undefined) {
    throw new Error("expected a picked eligible track");
  }
  return [baseRow(picked)];
}

// The mock emulates the real `order by random() limit 1` with `Math.random()`.
// Pin it so the pick is deterministic across runs — the eligibility invariant
// below must hold for ANY draw, so we sweep the spy across the [0,1) range rather
// than freezing a single index.
const randomSpy = vi.spyOn(Math, "random");

beforeEach(() => {
  execute.mockReset();
  randomSpy.mockReset().mockReturnValue(0);
  execute.mockImplementation(async (query: { sql: string }) => {
    // Guard the predicate is actually in the SQL, not just emulated by the mock.
    expect(query.sql).toContain("video_squared_at is not null");
    expect(query.sql).toContain("observation_audio_url is not null");

    return { rows: runEligibleQuery() };
  });
});

describe("getRandomRadioTrack", () => {
  it("only ever returns a radio-eligible finding (squared + observed)", async () => {
    // Sweep the pick across the whole [0,1) range: an ineligible finding
    // (un-squared OR observation-less) must never surface, however the random
    // pick lands. Deterministic now (the spy drives every draw) instead of
    // hoping 50 real-random draws happen to cover the space.
    for (let i = 0; i < 50; i++) {
      randomSpy.mockReturnValue(i / 50);

      const track = await getRandomRadioTrack();

      expect(track?.trackId).toBe("track-eligible");
    }
  });

  it("maps the row through toTrackListItem (versioned observation URL + galaxy)", async () => {
    const track = await getRandomRadioTrack();

    expect(track?.logId).toBe("003.1.1A");
    // The playback URL is versioned by the render timestamp (the today cache fix).
    expect(track?.observationAudioUrl).toContain("observation.mp3?v=");
    // The square signal rides through so the page knows it can centre-crop.
    expect(track?.videoSquaredAt).toBe("2026-06-10T00:00:00.000Z");
    expect(track?.galaxy).toBeDefined();
  });

  it("returns undefined when no finding is eligible", async () => {
    execute.mockResolvedValueOnce({ rows: [] });

    expect(await getRandomRadioTrack()).toBeUndefined();
  });
});
