import { describe, expect, it } from "vitest";
import { LAUNCH_INDEX, type StationInput, stationOf } from "./stations";

// A fully-landed find with no async artifacts yet — the baseline every case
// builds on. `stationOf` reads only these fields, so the partials below stay tiny.
const added: StationInput = {
  addedToSpotify: true,
  enrichmentStatus: "pending",
  postedToTelegram: true,
};

describe("stationOf", () => {
  it("parks a half-added find at intake (0)", () => {
    expect(stationOf({ ...added, addedToSpotify: false })).toBe(0);
    expect(stationOf({ ...added, postedToTelegram: false })).toBe(0);
  });

  it("walks the belt one station per artifact", () => {
    expect(stationOf(added)).toBe(1); // added → waiting at the spectrograph
    expect(stationOf({ ...added, enrichmentStatus: "done" })).toBe(2); // → press
    expect(stationOf({ ...added, enrichmentStatus: "done", note: "why" })).toBe(3); // → booth
    expect(
      stationOf({
        ...added,
        enrichmentStatus: "done",
        note: "why",
        observationAudioUrl: "/o.mp3",
      }),
    ).toBe(4); // → render bay
    expect(
      stationOf({
        ...added,
        enrichmentStatus: "done",
        note: "why",
        observationAudioUrl: "/o.mp3",
        videoUrl: "/v.mp4",
      }),
    ).toBe(5); // → dispatch
  });

  it("advances to the address printer on the first live link", () => {
    const filmed: StationInput = {
      ...added,
      enrichmentStatus: "done",
      note: "why",
      observationAudioUrl: "/o.mp3",
      videoUrl: "/v.mp4",
    };
    expect(stationOf({ ...filmed, youtubeUrl: "https://youtu.be/x" })).toBe(6);
    expect(stationOf({ ...filmed, tiktokUrl: "https://tiktok.com/x" })).toBe(6);
  });

  it("reaches the launch pad once both links are written back", () => {
    expect(
      stationOf({
        ...added,
        enrichmentStatus: "done",
        note: "why",
        observationAudioUrl: "/o.mp3",
        tiktokUrl: "https://tiktok.com/x",
        videoUrl: "/v.mp4",
        youtubeUrl: "https://youtu.be/x",
      }),
    ).toBe(LAUNCH_INDEX);
  });

  it("reads forward progress: a later artifact wins over a skipped step", () => {
    // The async pipeline runs in parallel — a find can have footage before its
    // note. It must ride to the render bay (5), never be parked back at the press.
    expect(
      stationOf({
        ...added,
        enrichmentStatus: "done",
        // note + observation skipped
        videoUrl: "/v.mp4",
      }),
    ).toBe(5);
  });

  it("never exceeds the launch pad", () => {
    const everything: StationInput = {
      addedToSpotify: true,
      enrichmentStatus: "done",
      note: "why",
      observationAudioUrl: "/o.mp3",
      postedToTelegram: true,
      tiktokUrl: "https://tiktok.com/x",
      videoUrl: "/v.mp4",
      youtubeUrl: "https://youtu.be/x",
    };
    expect(stationOf(everything)).toBe(LAUNCH_INDEX);
  });
});
