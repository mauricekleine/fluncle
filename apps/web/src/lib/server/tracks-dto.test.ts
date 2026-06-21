import { describe, expect, it } from "vitest";
import { type TrackRow, toTrackListItem } from "./tracks";

// The served (mapped) observation audio URL must be versioned by
// observation_generated_at, so a re-`observe` — which overwrites
// observation.mp3 in place at the same R2 key — re-keys the edge cache instead
// of HITting the stale object until its max-age TTL. The bare URL stays in the
// observation_audio_url column (the admin-overwrite source of truth); the DTO
// the API + web read is the canonical consumer surface, so it carries the ?v=.

const BASE_ROW: TrackRow = {
  added_at: "2026-06-21T09:00:00.000Z",
  added_to_spotify: 0,
  album: null,
  album_image_url: null,
  artists_json: '["Some Artist"]',
  bpm: null,
  duration_ms: 200000,
  enrichment_status: "done",
  features_json: null,
  in_release_id: null,
  isrc: null,
  key: null,
  label: null,
  log_id: "004.7.2I",
  note: null,
  observation_audio_url: "https://found.fluncle.com/004.7.2I/observation.mp3",
  observation_duration_ms: 22000,
  observation_generated_at: "2026-06-21T10:00:00.000Z",
  popularity: null,
  posted_to_telegram: 0,
  preview_url: null,
  release_date: null,
  spotify_url: "https://open.spotify.com/track/abc",
  tiktok_url: null,
  title: "A Finding",
  track_id: "abc",
  updated_at: null,
  vibe_x: null,
  vibe_y: null,
  video_model: null,
  video_model_reasoning: null,
  video_squared_at: null,
  video_url: null,
  video_vehicle: null,
  youtube_url: null,
};

describe("toTrackListItem — observation audio URL versioning", () => {
  it("serves the observation audio URL with ?v=<epoch-ms of observation_generated_at>", () => {
    const item = toTrackListItem(BASE_ROW);

    expect(item.observationAudioUrl).toBe(
      `https://found.fluncle.com/004.7.2I/observation.mp3?v=${Date.parse(
        "2026-06-21T10:00:00.000Z",
      )}`,
    );
  });

  it("CHANGES the served URL when observation_generated_at changes (a re-observe refreshes the edge cache)", () => {
    const before = toTrackListItem(BASE_ROW).observationAudioUrl;
    const after = toTrackListItem({
      ...BASE_ROW,
      observation_generated_at: "2026-06-21T12:30:00.000Z",
    }).observationAudioUrl;

    expect(before).not.toBe(after);
    expect(before).toContain("?v=");
    expect(after).toContain("?v=");
  });

  it("leaves a finding with no observation without a broken URL", () => {
    const item = toTrackListItem({
      ...BASE_ROW,
      observation_audio_url: null,
      observation_duration_ms: null,
      observation_generated_at: null,
    });

    expect(item.observationAudioUrl).toBeUndefined();
  });
});
