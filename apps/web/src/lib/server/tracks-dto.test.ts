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
  analyzed_at: null,
  analyzed_from: null,
  artists_json: '["Some Artist"]',
  bpm: null,
  bpm_source: null,
  duration_ms: 200000,
  enrichment_status: "done",
  features_json: null,
  galaxy_name: null,
  galaxy_slug: null,
  in_release_id: null,
  isrc: null,
  key: null,
  key_source: null,
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

// The sonic galaxy DTO field (browse-by-feel RFC): read from the `galaxy_id` join,
// present as `{ name, slug }` ONLY when the galaxy is operator-named (both name + slug
// non-null). The four dead vibe-quadrant names no longer feed it.
describe("galaxy — the named-galaxy DTO field", () => {
  it("surfaces { name, slug } when the galaxy is named (both columns present)", () => {
    const item = toTrackListItem({
      ...BASE_ROW,
      galaxy_name: "The Liquid Deep",
      galaxy_slug: "the-liquid-deep",
    });

    expect(item.galaxy).toEqual({ name: "The Liquid Deep", slug: "the-liquid-deep" });
  });

  it("omits galaxy when the finding is unassigned (both columns null)", () => {
    expect(toTrackListItem(BASE_ROW).galaxy).toBeUndefined();
  });

  it("omits galaxy when the galaxy is assigned but not yet named (slug null)", () => {
    // An unnamed galaxy is admin-only — its findings carry a galaxy_id but the name/slug
    // columns read null through the join, so the public DTO shows nothing.
    const item = toTrackListItem({ ...BASE_ROW, galaxy_name: null, galaxy_slug: null });

    expect(item.galaxy).toBeUndefined();
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

// Analysis provenance (RFC bpm-key-accuracy): the ADMIN DTO carries analyzedFrom (the capture
// sweep + the requeue-analysis command read it), but every PUBLIC read strips it — it is
// internal capture/enrich state, never part of a public DTO. This also covers the case a
// captured key alone would miss: a preview-analyzed finding with NO source audio still leaks
// analyzedFrom unless the public mapper strips it independently of sourceAudioKey.
describe("analyzedFrom — admin carries, public strips", () => {
  const PREVIEW_ROW: TrackRow = { ...BASE_ROW, analyzed_from: "preview" };

  it("the admin DTO (toTrackListItem) carries analyzedFrom", () => {
    expect(toTrackListItem(PREVIEW_ROW).analyzedFrom).toBe("preview");
  });

  it("toPublicTrackListItem strips analyzedFrom even when there is no source audio", () => {
    const publicItem = toPublicTrackListItem(toTrackListItem(PREVIEW_ROW));

    expect(publicItem.analyzedFrom).toBeUndefined();
    expect(publicItem.sourceAudioKey).toBeUndefined();
    // Everything else survives.
    expect(publicItem.trackId).toBe(PREVIEW_ROW.track_id);
  });

  it("surfaces a null legacy analyzed_from as undefined", () => {
    expect(toTrackListItem(BASE_ROW).analyzedFrom).toBeUndefined();
  });
});

// analyzedAt (RFC bpm-key-accuracy): the freshness companion to analyzedFrom/keySource — the
// admin DTO carries it so a reader can tell WHEN a key was (re-)derived, but every public read
// strips it, since exposing analysis freshness advertises internal curation state.
describe("analyzedAt — admin carries, public strips", () => {
  const STAMPED_ROW: TrackRow = { ...BASE_ROW, analyzed_at: "2026-07-10T14:02:00.000Z" };

  it("the admin DTO (toTrackListItem) carries analyzedAt", () => {
    expect(toTrackListItem(STAMPED_ROW).analyzedAt).toBe("2026-07-10T14:02:00.000Z");
  });

  it("toPublicTrackListItem strips analyzedAt", () => {
    const publicItem = toPublicTrackListItem(toTrackListItem(STAMPED_ROW));

    expect(publicItem.analyzedAt).toBeUndefined();
    // Everything else survives.
    expect(publicItem.trackId).toBe(STAMPED_ROW.track_id);
  });

  it("surfaces a null legacy analyzed_at as undefined", () => {
    expect(toTrackListItem(BASE_ROW).analyzedAt).toBeUndefined();
  });
});

// Source-hierarchy provenance (operator > rekordbox > DSP): the ADMIN DTO carries
// bpmSource/keySource (the Rekordbox sync reads them to skip an operator-graded row and to
// detect a matching-but-unstamped value), but every PUBLIC read strips them — they are
// internal curation state, never part of a public DTO.
describe("bpmSource/keySource — admin carries, public strips", () => {
  const GRADED_ROW: TrackRow = { ...BASE_ROW, bpm_source: "operator", key_source: "rekordbox" };

  it("the admin DTO (toTrackListItem) carries bpmSource + keySource", () => {
    const item = toTrackListItem(GRADED_ROW);

    expect(item.bpmSource).toBe("operator");
    expect(item.keySource).toBe("rekordbox");
  });

  it("toPublicTrackListItem strips both source fields", () => {
    const publicItem = toPublicTrackListItem(toTrackListItem(GRADED_ROW));

    expect(publicItem.bpmSource).toBeUndefined();
    expect(publicItem.keySource).toBeUndefined();
    // Everything else survives — only the private provenance is removed.
    expect(publicItem.trackId).toBe(GRADED_ROW.track_id);
    expect(publicItem.title).toBe(GRADED_ROW.title);
  });

  it("surfaces null legacy source columns as undefined", () => {
    const item = toTrackListItem(BASE_ROW);

    expect(item.bpmSource).toBeUndefined();
    expect(item.keySource).toBeUndefined();
    // An un-graded finding has nothing to strip — same reference back.
    expect(toPublicTrackListItem(item)).toBe(item);
  });
});
