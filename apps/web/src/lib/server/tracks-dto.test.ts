import { describe, expect, it } from "vitest";
import { type TrackRow, toPublicTrackListItem, toTrackListItem } from "./tracks";

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
  observation_alignment_json: null,
  observation_audio_url: "https://found.fluncle.com/004.7.2I/observation.mp3",
  observation_duration_ms: 22000,
  observation_generated_at: "2026-06-21T10:00:00.000Z",
  popularity: null,
  posted_to_telegram: 0,
  preview_url: null,
  release_date: null,
  source_audio_failures: 0,
  source_audio_key: null,
  spotify_url: "https://open.spotify.com/track/abc",
  tiktok_url: null,
  title: "A Finding",
  track_id: "abc",
  updated_at: null,
  vibe_x: null,
  vibe_y: null,
  video_grain: null,
  video_model: null,
  video_model_reasoning: null,
  video_register: null,
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

// The private full-song capture key: the ADMIN DTO carries it (the on-box sweeps read
// it), but every PUBLIC read strips it via toPublicTrackListItem — the captured full
// song is a private analysis artifact and its R2 key must never world-serve.
describe("sourceAudioKey — admin carries, public strips", () => {
  const CAPTURED_ROW: TrackRow = { ...BASE_ROW, source_audio_key: "004.7.2I/abc123.m4a" };

  it("the admin DTO (toTrackListItem) carries the captured source key", () => {
    expect(toTrackListItem(CAPTURED_ROW).sourceAudioKey).toBe("004.7.2I/abc123.m4a");
  });

  it("toPublicTrackListItem strips the key from a captured finding", () => {
    const publicItem = toPublicTrackListItem(toTrackListItem(CAPTURED_ROW));

    expect(publicItem.sourceAudioKey).toBeUndefined();
    // Everything else survives — only the private key is removed.
    expect(publicItem.trackId).toBe(CAPTURED_ROW.track_id);
    expect(publicItem.title).toBe(CAPTURED_ROW.title);
  });

  it("returns an un-captured item unchanged (nothing to strip)", () => {
    const item = toTrackListItem(BASE_ROW);

    expect(item.sourceAudioKey).toBeUndefined();
    expect(toPublicTrackListItem(item)).toBe(item);
  });
});
