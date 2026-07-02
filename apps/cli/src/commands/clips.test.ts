import { type ClipTrackInput, resolveClipTracks, trackLabel } from "@fluncle/contracts/util";
import { describe, expect, test } from "bun:test";
import {
  CLIP_AUDIO_BITRATE,
  CLIP_BUFSIZE,
  CLIP_CRF,
  CLIP_HEIGHT,
  CLIP_MAXRATE,
  CLIP_WIDTH,
  clipCutFfmpegArgs,
  clipCutFilterComplex,
  clipFootageKey,
  setVideoUrl,
} from "./clips";

// Synthetic cue sheet: three tracks at 0 / 60s / 120s in a 180s set. `resolveClipTracks`
// keys off `startMs` only, so the other MixtapeMember fields are omitted here. It is a pure
// `@fluncle/contracts/util` helper (still used by the recording cue rail); the clip cut no
// longer consumes it, but the coverage lives here alongside its historical home.
const CUED_MEMBERS: ClipTrackInput[] = [
  { artists: ["Alpha"], startMs: 0, title: "First" },
  { artists: ["Beta", "Gamma"], startMs: 60_000, title: "Second" },
  { artists: ["Delta"], startMs: 120_000, title: "Third" },
];
const SET_DURATION_MS = 180_000;

// CI has NO ffmpeg, so every test here exercises the PURE logic only — the footage key,
// the crop filtergraph, and the ffmpeg arg SHAPE (a string array, never invoked). The cut
// command's actual shell-out lives behind an `assertFfmpeg` probe and is never reached here.

describe("clipFootageKey", () => {
  test("is the clip's pseudo-finding master key", () => {
    expect(clipFootageKey("clip-abc")).toBe("clip-abc/footage.mp4");
  });
});

describe("setVideoUrl", () => {
  test("is the set rendition on found.fluncle.com, by log id", () => {
    expect(setVideoUrl("019.F.1A")).toBe("https://found.fluncle.com/019.F.1A/set.mp4");
  });

  test("encodes an unsafe log id", () => {
    expect(setVideoUrl("a b")).toBe("https://found.fluncle.com/a%20b/set.mp4");
  });
});

describe("clipCutFilterComplex — the overlay-free crop", () => {
  test("crops 16:9 → 9:16 at the xOffset, scales to 1080×1920, fixes SAR, maps [out]", () => {
    const filter = clipCutFilterComplex({ xOffset: 240 });

    expect(filter).toBe(
      `[0:v]crop=ih*9/16:ih:240:0,scale=${CLIP_WIDTH}:${CLIP_HEIGHT},setsar=1[out]`,
    );
  });

  test("honors the xOffset — flooring a negative / fractional offset to a clean integer", () => {
    expect(clipCutFilterComplex({ xOffset: -10 })).toContain("crop=ih*9/16:ih:0:0");
    expect(clipCutFilterComplex({ xOffset: 12.7 })).toContain("crop=ih*9/16:ih:13:0");
  });

  test("bakes NO text overlay — no drawtext, fonts, halo, or caption box", () => {
    const filter = clipCutFilterComplex({ xOffset: 240 });

    // The clip ships clean; captions go on Instagram / TikTok, not into the pixels.
    expect(filter).not.toContain("drawtext");
    expect(filter).not.toContain("fontfile");
    expect(filter).not.toContain("gblur");
    expect(filter).not.toContain("overlay");
    expect(filter).not.toContain("box=1");
    expect(filter).not.toContain("boxcolor");
    expect(filter).not.toContain("fluncle://");
  });
});

describe("clipCutFfmpegArgs", () => {
  const args = clipCutFfmpegArgs({
    inMs: 65_500,
    outMs: 95_500,
    outputPath: "/tmp/clip.mp4",
    setUrl: "https://found.fluncle.com/019.F.1A/set.mp4",
    xOffset: 240,
  });

  function flagValue(flag: string): string | undefined {
    const index = args.indexOf(flag);

    return index >= 0 ? args[index + 1] : undefined;
  }

  test("input-seeks BEFORE -i (the faststart range-seek), with the trim duration", () => {
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(flagValue("-ss")).toBe("65.500");
    expect(flagValue("-t")).toBe("30.000");
  });

  test("reads the set rendition URL as the input + writes the output path", () => {
    expect(flagValue("-i")).toBe("https://found.fluncle.com/019.F.1A/set.mp4");
    expect(args.at(-1)).toBe("/tmp/clip.mp4");
  });

  test("carries the crop as a -filter_complex, mapping [out] + optional audio", () => {
    expect(flagValue("-filter_complex")).toBe(clipCutFilterComplex({ xOffset: 240 }));
    // The graph's video pad and the source audio are mapped explicitly.
    const mapIndex = args.indexOf("-map");
    expect(args[mapIndex + 1]).toBe("[out]");
    expect(args).toContain("0:a?");
    // No simple -vf when a filter_complex is in play.
    expect(args).not.toContain("-vf");
  });

  test("caps the bitrate (H.264 + AAC, faststart) so the cut stays under 100 MB", () => {
    expect(flagValue("-c:v")).toBe("libx264");
    expect(flagValue("-crf")).toBe(String(CLIP_CRF));
    expect(flagValue("-maxrate")).toBe(CLIP_MAXRATE);
    expect(flagValue("-bufsize")).toBe(CLIP_BUFSIZE);
    expect(flagValue("-c:a")).toBe("aac");
    expect(flagValue("-b:a")).toBe(CLIP_AUDIO_BITRATE);
    expect(flagValue("-movflags")).toBe("+faststart");
  });
});

// `resolveClipTracks` / `trackLabel` are pure `@fluncle/contracts/util` helpers, still used
// by the recording cue rail (they no longer feed the clip cut, which ships overlay-free).
// Their coverage stays here alongside the clip module they were introduced with.
describe("trackLabel", () => {
  test("joins Artist — Title with the sanctioned em dash", () => {
    expect(trackLabel(["Alix Perez"], "Forsaken")).toBe("Alix Perez — Forsaken");
  });

  test("joins multiple artists with a comma", () => {
    expect(trackLabel(["Calyx", "TeeBee"], "Elevate This Sound")).toBe(
      "Calyx, TeeBee — Elevate This Sound",
    );
  });

  test("degrades to the title alone when there is no artist", () => {
    expect(trackLabel([], "Untitled")).toBe("Untitled");
  });
});

describe("resolveClipTracks", () => {
  const resolve = (inMs: number, outMs: number, members = CUED_MEMBERS) =>
    resolveClipTracks({ inMs, members, outMs, setDurationMs: SET_DURATION_MS });

  test("single track — a window inside one cue's interval", () => {
    const tracks = resolve(10_000, 40_000);

    expect(tracks.map((t) => t.label)).toEqual(["Alpha — First"]);
    expect(tracks[0]?.startMs).toBe(0);
  });

  test("blend — a window straddling a cue boundary returns both, in play order", () => {
    const tracks = resolve(55_000, 70_000);

    expect(tracks.map((t) => t.label)).toEqual(["Alpha — First", "Beta, Gamma — Second"]);
  });

  test("blend across two boundaries returns all three straddled tracks", () => {
    const tracks = resolve(55_000, 125_000);

    expect(tracks.map((t) => t.label)).toEqual([
      "Alpha — First",
      "Beta, Gamma — Second",
      "Delta — Third",
    ]);
  });

  test("boundary is half-open — a window opening exactly on a cue belongs to the later track", () => {
    const tracks = resolve(60_000, 90_000);

    expect(tracks.map((t) => t.label)).toEqual(["Beta, Gamma — Second"]);
  });

  test("before-first — a window before the first cue clamps to the first track", () => {
    // A set whose first cue is at 5s; a window at [1s, 3s) resolves to that first track.
    const members: ClipTrackInput[] = [
      { artists: ["Alpha"], startMs: 5_000, title: "First" },
      { artists: ["Beta"], startMs: 60_000, title: "Second" },
    ];
    const tracks = resolveClipTracks({
      inMs: 1_000,
      members,
      outMs: 3_000,
      setDurationMs: 120_000,
    });

    expect(tracks.map((t) => t.label)).toEqual(["Alpha — First"]);
  });

  test("after-last — a window past the last cue clamps to the last track", () => {
    const tracks = resolve(130_000, 175_000);

    expect(tracks.map((t) => t.label)).toEqual(["Delta — Third"]);
  });

  test("after-last — a window past setDurationMs still clamps to the last track", () => {
    const tracks = resolve(190_000, 210_000);

    expect(tracks.map((t) => t.label)).toEqual(["Delta — Third"]);
  });

  test("sorts unordered members by startMs before resolving", () => {
    const shuffled = [CUED_MEMBERS[2], CUED_MEMBERS[0], CUED_MEMBERS[1]].filter(
      (m): m is ClipTrackInput => m != null,
    );
    const tracks = resolveClipTracks({
      inMs: 55_000,
      members: shuffled,
      outMs: 70_000,
      setDurationMs: SET_DURATION_MS,
    });

    expect(tracks.map((t) => t.label)).toEqual(["Alpha — First", "Beta, Gamma — Second"]);
  });

  test("un-cued set (no startMs anywhere) → []", () => {
    const uncued: ClipTrackInput[] = [
      { artists: ["Alpha"], title: "First" },
      { artists: ["Beta"], title: "Second" },
    ];

    expect(
      resolveClipTracks({ inMs: 10_000, members: uncued, outMs: 40_000, setDurationMs: 180_000 }),
    ).toEqual([]);
  });

  test("empty members → []", () => {
    expect(resolveClipTracks({ inMs: 0, members: [], outMs: 30_000, setDurationMs: 0 })).toEqual(
      [],
    );
  });
});
