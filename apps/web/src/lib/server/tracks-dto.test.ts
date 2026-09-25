import { TrackListItemSchema } from "@fluncle/contracts/orpc";
import { describe, expect, it } from "vitest";
import {
  type TrackRow,
  toLeanTrackListItem,
  toPublicTrackListItem,
  toTrackListItem,
} from "./tracks";

const BASE_ROW: TrackRow = {
  added_at: "2026-06-21T09:00:00.000Z",
  added_to_spotify: 0,
  album: null,
  album_artwork_height: null,
  album_artwork_url_template: null,
  album_artwork_width: null,
  album_image_key: null,
  album_image_state: null,
  album_image_updated_at: null,
  album_image_url: null,
  album_slug: null,
  analyzed_at: null,
  analyzed_from: null,
  apple_music_url: null,
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
  label_slug: null,
  log_id: "004.7.2I",
  mb_recording_id: null,
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
  video_palette: null,
  video_plate_subject: null,
  video_register: null,
  video_squared_at: null,
  video_structure: null,
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
    const item = toTrackListItem({ ...BASE_ROW, galaxy_name: null, galaxy_slug: null });

    expect(item.galaxy).toBeUndefined();
  });
});

describe("sourceAudioKey — admin carries, public strips", () => {
  const CAPTURED_ROW: TrackRow = { ...BASE_ROW, source_audio_key: "004.7.2I/abc123.m4a" };

  it("the admin DTO (toTrackListItem) carries the captured source key", () => {
    expect(toTrackListItem(CAPTURED_ROW).sourceAudioKey).toBe("004.7.2I/abc123.m4a");
  });

  it("toPublicTrackListItem strips the key from a captured finding", () => {
    const publicItem = toPublicTrackListItem(toTrackListItem(CAPTURED_ROW));

    expect(publicItem.sourceAudioKey).toBeUndefined();

    expect(publicItem.trackId).toBe(CAPTURED_ROW.track_id);
    expect(publicItem.title).toBe(CAPTURED_ROW.title);
  });

  it("returns an un-captured item unchanged (nothing to strip)", () => {
    const item = toTrackListItem(BASE_ROW);

    expect(item.sourceAudioKey).toBeUndefined();
    expect(toPublicTrackListItem(item)).toBe(item);
  });
});

describe("analyzedFrom — admin carries, public strips", () => {
  const PREVIEW_ROW: TrackRow = { ...BASE_ROW, analyzed_from: "preview" };

  it("the admin DTO (toTrackListItem) carries analyzedFrom", () => {
    expect(toTrackListItem(PREVIEW_ROW).analyzedFrom).toBe("preview");
  });

  it("toPublicTrackListItem strips analyzedFrom even when there is no source audio", () => {
    const publicItem = toPublicTrackListItem(toTrackListItem(PREVIEW_ROW));

    expect(publicItem.analyzedFrom).toBeUndefined();
    expect(publicItem.sourceAudioKey).toBeUndefined();

    expect(publicItem.trackId).toBe(PREVIEW_ROW.track_id);
  });

  it("surfaces a null legacy analyzed_from as undefined", () => {
    expect(toTrackListItem(BASE_ROW).analyzedFrom).toBeUndefined();
  });
});

describe("analyzedAt — admin carries, public strips", () => {
  const STAMPED_ROW: TrackRow = { ...BASE_ROW, analyzed_at: "2026-07-10T14:02:00.000Z" };

  it("the admin DTO (toTrackListItem) carries analyzedAt", () => {
    expect(toTrackListItem(STAMPED_ROW).analyzedAt).toBe("2026-07-10T14:02:00.000Z");
  });

  it("toPublicTrackListItem strips analyzedAt", () => {
    const publicItem = toPublicTrackListItem(toTrackListItem(STAMPED_ROW));

    expect(publicItem.analyzedAt).toBeUndefined();

    expect(publicItem.trackId).toBe(STAMPED_ROW.track_id);
  });

  it("surfaces a null legacy analyzed_at as undefined", () => {
    expect(toTrackListItem(BASE_ROW).analyzedAt).toBeUndefined();
  });
});

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

    expect(publicItem.trackId).toBe(GRADED_ROW.track_id);
    expect(publicItem.title).toBe(GRADED_ROW.title);
  });

  it("surfaces null legacy source columns as undefined", () => {
    const item = toTrackListItem(BASE_ROW);

    expect(item.bpmSource).toBeUndefined();
    expect(item.keySource).toBeUndefined();

    expect(toPublicTrackListItem(item)).toBe(item);
  });
});

describe("track projection ↔ contract round-trip (Finding B20)", () => {
  const fatKeys = new Set(Object.keys(toTrackListItem(BASE_ROW)));
  const leanKeys = new Set(Object.keys(toLeanTrackListItem(BASE_ROW)));
  const schemaKeys = new Set(Object.keys(TrackListItemSchema.shape));

  const SCHEMA_ONLY_KEYS = new Set(["artistYoutubeChannelIds"]);

  const LEAN_OMITTED_KEYS = new Set(["features", "observationAlignment", "videoModelReasoning"]);

  it("the fat DTO (toTrackListItem) maps exactly the contract's list-item keys", () => {
    const missingFromDto = [...schemaKeys].filter(
      (key) => !SCHEMA_ONLY_KEYS.has(key) && !fatKeys.has(key),
    );

    const missingFromContract = [...fatKeys].filter((key) => !schemaKeys.has(key));

    expect({ missingFromContract, missingFromDto }).toEqual({
      missingFromContract: [],
      missingFromDto: [],
    });
  });

  it("the lean DTO (toLeanTrackListItem) drops exactly the heavy fields, nothing else", () => {
    const expectedLeanKeys = new Set([...fatKeys].filter((key) => !LEAN_OMITTED_KEYS.has(key)));

    const droppedBeyondHeavy = [...fatKeys].filter(
      (key) => !LEAN_OMITTED_KEYS.has(key) && !leanKeys.has(key),
    );
    const leakedHeavy = [...LEAN_OMITTED_KEYS].filter((key) => leanKeys.has(key));

    expect({ droppedBeyondHeavy, leakedHeavy }).toEqual({
      droppedBeyondHeavy: [],
      leakedHeavy: [],
    });
    expect(leanKeys).toEqual(expectedLeanKeys);
  });
});

const SPOTIFY_HASH = "18c0fd64aad5d4fb51a499b0";

describe("toLeanTrackListItem — albumImageUrl upgraded to 640² at the DTO boundary", () => {
  it("upgrades the stored Spotify 300² cover to the 640² rendition", () => {
    const item = toLeanTrackListItem({
      ...BASE_ROW,
      album_image_url: `https://i.scdn.co/image/ab67616d00001e02${SPOTIFY_HASH}`,
    });

    expect(item.albumImageUrl).toBe(`https://i.scdn.co/image/ab67616d0000b273${SPOTIFY_HASH}`);
  });

  it("is idempotent — an already-640² stored URL survives untouched", () => {
    const already640 = `https://i.scdn.co/image/ab67616d0000b273${SPOTIFY_HASH}`;
    const item = toLeanTrackListItem({ ...BASE_ROW, album_image_url: already640 });

    expect(item.albumImageUrl).toBe(already640);
  });

  it("passes a non-Spotify cover URL (an owned master, once U3b lands) through untouched", () => {
    const owned = "https://found.fluncle.com/cdn-cgi/image/width=640/albums/some-album.jpg";
    const item = toLeanTrackListItem({ ...BASE_ROW, album_image_url: owned });

    expect(item.albumImageUrl).toBe(owned);
  });

  it("stays undefined when the row carries no cover", () => {
    expect(
      toLeanTrackListItem({ ...BASE_ROW, album_image_url: null }).albumImageUrl,
    ).toBeUndefined();
  });
});

describe("toLeanTrackListItem — artworkMaxUrl composed from the album's Apple facts", () => {
  it("composes a 2048² Apple URL when the album carries artwork bigger than the target", () => {
    const item = toLeanTrackListItem({
      ...BASE_ROW,
      album_artwork_height: 3000,
      album_artwork_url_template: "https://is1-ssl.mzstatic.com/image/thumb/abc/{w}x{h}bb.jpg",
      album_artwork_width: 3000,
    });

    expect(item.artworkMaxUrl).toBe("https://is1-ssl.mzstatic.com/image/thumb/abc/2048x2048bb.jpg");
  });

  it("clamps the request to the artwork's native max (never upscales a smaller master)", () => {
    const item = toLeanTrackListItem({
      ...BASE_ROW,
      album_artwork_height: 1400,
      album_artwork_url_template: "https://is1-ssl.mzstatic.com/image/thumb/abc/{w}x{h}bb.jpg",
      album_artwork_width: 1400,
    });

    expect(item.artworkMaxUrl).toBe("https://is1-ssl.mzstatic.com/image/thumb/abc/1400x1400bb.jpg");
  });

  it("is undefined when the album has no stored Apple artwork (the render falls through)", () => {
    expect(toLeanTrackListItem(BASE_ROW).artworkMaxUrl).toBeUndefined();
  });

  it("is undefined when the template is present but the dimensions are missing", () => {
    const item = toLeanTrackListItem({
      ...BASE_ROW,
      album_artwork_height: null,
      album_artwork_url_template: "https://is1-ssl.mzstatic.com/image/thumb/abc/{w}x{h}bb.jpg",
      album_artwork_width: null,
    });

    expect(item.artworkMaxUrl).toBeUndefined();
  });
});
