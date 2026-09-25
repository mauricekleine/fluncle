import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRandomRadioTrack } from "./tracks";

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

type StoredTrack = {
  observation_audio_url: string | null;
  title: string;
  track_id: string;
  video_squared_at: string | null;
};

const archive: StoredTrack[] = [
  {
    observation_audio_url: "https://found.fluncle.com/003.1.1A/observation.mp3",
    title: "Eligible",
    track_id: "track-eligible",
    video_squared_at: "2026-06-10T00:00:00.000Z",
  },

  {
    observation_audio_url: null,
    title: "No Observation",
    track_id: "track-no-observation",
    video_squared_at: "2026-06-09T00:00:00.000Z",
  },

  {
    observation_audio_url: "https://found.fluncle.com/002.5.9Z/observation.mp3",
    title: "Not Squared",
    track_id: "track-not-squared",
    video_squared_at: null,
  },

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
    galaxy_name: "The Liquid Deep",
    galaxy_slug: "the-liquid-deep",
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
    video_grain: null,
    video_model: null,
    video_model_reasoning: null,
    video_palette: null,
    video_register: null,
    video_url: "https://found.fluncle.com/003.1.1A/footage.mp4",
    video_vehicle: null,
    youtube_url: null,
  };
}

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

const randomSpy = vi.spyOn(Math, "random");

beforeEach(() => {
  execute.mockReset();
  randomSpy.mockReset().mockReturnValue(0);
  execute.mockImplementation(async (query: { sql: string }) => {
    // oxlint-disable-next-line vitest/no-standalone-expect
    expect(query.sql).toContain("video_squared_at is not null");
    // oxlint-disable-next-line vitest/no-standalone-expect
    expect(query.sql).toContain("observation_audio_url is not null");

    return { rows: runEligibleQuery() };
  });
});

describe("getRandomRadioTrack", () => {
  it("only ever returns a radio-eligible finding (squared + observed)", async () => {
    for (let i = 0; i < 50; i++) {
      randomSpy.mockReturnValue(i / 50);

      const track = await getRandomRadioTrack();

      expect(track?.trackId).toBe("track-eligible");
    }
  });

  it("maps the row through toTrackListItem (versioned observation URL + galaxy)", async () => {
    const track = await getRandomRadioTrack();

    expect(track?.logId).toBe("003.1.1A");

    expect(track?.observationAudioUrl).toContain("observation.mp3?v=");

    expect(track?.videoSquaredAt).toBe("2026-06-10T00:00:00.000Z");

    expect(track?.galaxy).toEqual({ name: "The Liquid Deep", slug: "the-liquid-deep" });
  });

  it("returns undefined when no finding is eligible", async () => {
    execute.mockResolvedValueOnce({ rows: [] });

    expect(await getRandomRadioTrack()).toBeUndefined();
  });
});
