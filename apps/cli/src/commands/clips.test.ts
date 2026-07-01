import { type ClipTrackInput, resolveClipTracks, trackLabel } from "@fluncle/contracts/util";
import { describe, expect, test } from "bun:test";
import {
  CLIP_AUDIO_BITRATE,
  CLIP_BUFSIZE,
  CLIP_COORDINATE_COLOR,
  CLIP_CRF,
  CLIP_HALO_COLOR,
  CLIP_HALO_CORE_SIGMA,
  CLIP_HALO_FEATHER_SIGMA,
  CLIP_HEIGHT,
  CLIP_MARGIN_X,
  CLIP_MAXRATE,
  CLIP_SAFE_BOTTOM,
  CLIP_SHARP_BORDERW,
  CLIP_TITLE_COLOR,
  CLIP_WIDTH,
  brandDrawtext,
  clipCutFfmpegArgs,
  clipCutFilterComplex,
  clipFootageKey,
  escapeDrawtextValue,
  setVideoUrl,
} from "./clips";

// Synthetic cue sheet: three tracks at 0 / 60s / 120s in a 180s set. `resolveClipTracks`
// keys off `startMs` only, so the other MixtapeMember fields are omitted here.
const CUED_MEMBERS: ClipTrackInput[] = [
  { artists: ["Alpha"], startMs: 0, title: "First" },
  { artists: ["Beta", "Gamma"], startMs: 60_000, title: "Second" },
  { artists: ["Delta"], startMs: 120_000, title: "Third" },
];
const SET_DURATION_MS = 180_000;

// CI has NO ffmpeg, so every test here exercises the PURE logic only — the footage key,
// the drawtext escaping, the brand-frame filtergraph, and the ffmpeg arg SHAPE (a string
// array, never invoked). The cut command's actual shell-out lives behind an `assertFfmpeg`
// probe and is never reached here.

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

describe("escapeDrawtextValue", () => {
  test("leaves a plain title untouched", () => {
    expect(escapeDrawtextValue("Fluncle Dreaming 002")).toBe("Fluncle Dreaming 002");
  });

  test("escapes backslashes first, then percent", () => {
    expect(escapeDrawtextValue("50%")).toBe("50\\%");
    expect(escapeDrawtextValue("a\\b")).toBe("a\\\\b");
  });

  test("escapes an embedded single quote with the ffmpeg close-reopen idiom", () => {
    expect(escapeDrawtextValue("don't")).toBe("don'\\''t");
  });

  test("backslash-escapes the filtergraph separators `:` and `,`", () => {
    // The single quotes do NOT protect `:`/`,` — ffmpeg splits on them regardless, so
    // they must be escaped (else a `fluncle://…` coordinate or a colon in the title
    // breaks the graph with "No option name near …").
    expect(escapeDrawtextValue("Live: dusk, redux")).toBe("Live\\: dusk\\, redux");
    expect(escapeDrawtextValue("fluncle://019.F.1A")).toBe("fluncle\\://019.F.1A");
  });
});

describe("brandDrawtext", () => {
  test("emits a plain drawtext node — no offset shadow, no border by default", () => {
    const node = brandDrawtext({
      color: CLIP_TITLE_COLOR,
      size: 40,
      text: "Fluncle",
      x: 96,
      y: "h-266-th",
    });

    expect(node.startsWith("drawtext=text='Fluncle'")).toBe(true);
    expect(node).toContain(`fontcolor=${CLIP_TITLE_COLOR}`);
    expect(node).toContain("fontsize=40");
    expect(node).toContain("x=96:y=h-266-th");
    // The soft glow is applied by the filtergraph (gblur), not by a per-node shadow/border.
    expect(node).not.toContain("shadowx");
    expect(node).not.toContain("shadowy");
    expect(node).not.toContain("borderw");
    expect(node).not.toContain("box=1");
    expect(node).not.toContain("boxcolor");
  });

  test("takes the ink color per role (cream title vs stardust coordinate)", () => {
    const title = brandDrawtext({ color: CLIP_TITLE_COLOR, size: 40, text: "T", x: 0, y: 0 });
    const coord = brandDrawtext({ color: CLIP_COORDINATE_COLOR, size: 22, text: "c", x: 0, y: 0 });

    expect(title).toContain(`fontcolor=${CLIP_TITLE_COLOR}`);
    expect(coord).toContain(`fontcolor=${CLIP_COORDINATE_COLOR}`);
  });

  test("adds a symmetric border only when borderw is set (the 1px sharp core, no offset)", () => {
    const node = brandDrawtext({
      borderw: CLIP_SHARP_BORDERW,
      color: CLIP_TITLE_COLOR,
      size: 40,
      text: "T",
      x: 0,
      y: 0,
    });

    expect(node).toContain(`borderw=${CLIP_SHARP_BORDERW}:bordercolor=${CLIP_HALO_COLOR}`);
    expect(node).not.toContain("shadowx");
  });

  test("escapes raw text and threads an installed fontfile", () => {
    const node = brandDrawtext({
      color: CLIP_COORDINATE_COLOR,
      fontFile: "/opt/fonts/Oxanium-SemiBold.ttf",
      size: 22,
      text: "fluncle://019.F.1A",
      x: 96,
      y: "h-230-th",
    });

    expect(node).toContain("drawtext=text='fluncle\\://019.F.1A'");
    expect(node).toContain("fontfile='/opt/fonts/Oxanium-SemiBold.ttf'");
  });
});

describe("clipCutFilterComplex", () => {
  const base = { logId: "019.F.1A", title: "Fluncle Dreaming 002", xOffset: 240 };

  test("crops 16:9 → 9:16 at the xOffset, then scales to 1080×1920 as [base]", () => {
    const filter = clipCutFilterComplex(base);

    expect(
      filter.startsWith(
        `[0:v]crop=ih*9/16:ih:240:0,scale=${CLIP_WIDTH}:${CLIP_HEIGHT},setsar=1[base]`,
      ),
    ).toBe(true);
    // The graph ends on the mapped video pad.
    expect(filter.endsWith("[out]")).toBe(true);
  });

  test("floors a negative / fractional xOffset to a clean integer", () => {
    expect(clipCutFilterComplex({ ...base, xOffset: -10 })).toContain("crop=ih*9/16:ih:0:0");
    expect(clipCutFilterComplex({ ...base, xOffset: 12.7 })).toContain("crop=ih*9/16:ih:13:0");
  });

  test("draws the title + the fluncle:// coordinate — once for the halo, once sharp", () => {
    const filter = clipCutFilterComplex(base);

    // Each line appears twice: the Deep-Field halo source AND the sharp ink on top.
    expect(filter.match(/drawtext=text='Fluncle Dreaming 002'/g)).toHaveLength(2);
    // The coordinate's `://` colon is escaped so ffmpeg doesn't split the filtergraph.
    expect(filter.match(/drawtext=text='fluncle\\:\/\/019\.F\.1A'/g)).toHaveLength(2);
  });

  test("builds the soft blurred ink-halo (transparent layer → two gblur passes → overlay)", () => {
    const filter = clipCutFilterComplex(base);

    // A transparent RGBA layer carries the Deep-Field halo glyphs.
    expect(filter).toContain("color=c=black@0:s=1080x1920,format=rgba");
    // Both halo glyphs are drawn in Deep-Field (no border on the halo source).
    expect(filter.match(new RegExp(`fontcolor=${CLIP_HALO_COLOR}:fontsize=`, "g"))).toHaveLength(2);
    // Split into a tight dense CORE + a wide FEATHER, each Gaussian-blurred, then overlaid.
    expect(filter).toContain("[ink]split[ink1][ink2]");
    expect(filter).toContain(`[ink1]gblur=sigma=${CLIP_HALO_CORE_SIGMA}[core]`);
    expect(filter).toContain(`[ink2]gblur=sigma=${CLIP_HALO_FEATHER_SIGMA}[feather]`);
    expect(filter).toContain("[base][feather]overlay=0:0[b1]");
    expect(filter).toContain("[b1][core]overlay=0:0[b2]");
    // NO offset drop shadow and NO #000 caption box anywhere (Warm Dark Rule).
    expect(filter).not.toContain("shadowx");
    expect(filter).not.toContain("boxcolor");
    expect(filter).not.toContain("box=1");
    // No gold in the overlay — it stays quiet, under the One-Sun budget.
    expect(filter.toLowerCase()).not.toContain("f5b800");
  });

  test("mirrors the Remotion TypePlate: cream title (40) over dim Stardust coordinate (22)", () => {
    const filter = clipCutFilterComplex(base);

    // The sharp ink: title = Starlight Cream at size 40; coordinate = Stardust at size 22.
    expect(filter).toContain(`fontcolor=${CLIP_TITLE_COLOR}:fontsize=40`);
    expect(filter).toContain(`fontcolor=${CLIP_COORDINATE_COLOR}:fontsize=22`);
    // The sharp ink carries only the 1px symmetric core (two lines).
    expect(
      filter.match(new RegExp(`borderw=${CLIP_SHARP_BORDERW}:bordercolor=${CLIP_HALO_COLOR}`, "g")),
    ).toHaveLength(2);
  });

  test("places both lines bottom-left in the platform safe-area (MARGIN_X, SAFE_BOTTOM)", () => {
    const filter = clipCutFilterComplex(base);

    // Both lines share the left inset (halo + sharp = 4 drawtext nodes total).
    expect(filter.match(new RegExp(`x=${CLIP_MARGIN_X}:`, "g"))).toHaveLength(4);
    // Coordinate is the lower line: bottom exactly SAFE_BOTTOM above the frame bottom.
    expect(filter).toContain(`y=h-${CLIP_SAFE_BOTTOM}-th`);
    // Title sits above it (SAFE_BOTTOM + the coordinate's line box + the gap = 230+26+10).
    expect(filter).toContain("y=h-266-th");
  });

  test("threads both font roles: the sans for the title, Oxanium for the coordinate", () => {
    const filter = clipCutFilterComplex({
      ...base,
      oxaniumFontFile: "/opt/fonts/Oxanium-SemiBold.ttf",
      sansFontFile: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    });

    // The title (cream, 40) carries the sans; the coordinate (stardust, 22) carries Oxanium.
    expect(filter).toContain(
      "fontfile='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf':fontcolor=" +
        `${CLIP_TITLE_COLOR}:fontsize=40`,
    );
    expect(filter).toContain(
      `fontfile='/opt/fonts/Oxanium-SemiBold.ttf':fontcolor=${CLIP_COORDINATE_COLOR}:fontsize=22`,
    );
  });

  test("omits fontfile for a role when none is given (fontconfig default)", () => {
    expect(clipCutFilterComplex(base)).not.toContain("fontfile=");
  });

  test("escapes a hostile title into the filtergraph", () => {
    const filter = clipCutFilterComplex({ ...base, title: "edge: a,b 100%" });

    expect(filter).toContain("drawtext=text='edge\\: a\\,b 100\\%'");
  });
});

// A clip cut from an UN-PROMOTED recording carries no coordinate (RFC recording-primitive,
// clip-domain D4): the `fluncle://` line is omitted and the title collapses onto the safe-
// area floor so it doesn't float above the dead space the coordinate would have filled.
describe("clipCutFilterComplex — un-promoted recording (no coordinate)", () => {
  const noCoordinate = { title: "Warehouse set, take 2", xOffset: 240 };

  test("omits the fluncle:// coordinate line entirely — no bare `fluncle://`", () => {
    const filter = clipCutFilterComplex(noCoordinate);

    // No coordinate text at all, and never a bare `fluncle://` sigil.
    expect(filter).not.toContain("fluncle://");
    expect(filter).not.toContain("fluncle\\:");
    // The Stardust coordinate ink (size 22) is gone; only the title (40) remains.
    expect(filter).not.toContain(`fontcolor=${CLIP_COORDINATE_COLOR}`);
    expect(filter).not.toContain("fontsize=22");
  });

  test("collapses the title onto the safe-area floor (h-SAFE_BOTTOM-th), not lifted above it", () => {
    const filter = clipCutFilterComplex(noCoordinate);

    // With no coordinate below it, the title sits exactly at the safe-area floor…
    expect(filter).toContain(`y=h-${CLIP_SAFE_BOTTOM}-th`);
    // …not lifted by the coordinate's line box + gap (the promoted-clip 266 offset is gone).
    expect(filter).not.toContain("y=h-266-th");
  });

  test("draws only the title line (once for the halo, once sharp) — two nodes total", () => {
    const filter = clipCutFilterComplex(noCoordinate);

    // The title still appears twice (halo + sharp); nothing else.
    expect(filter.match(/drawtext=text='Warehouse set\\, take 2'/g)).toHaveLength(2);
    expect(filter.match(/drawtext=/g)).toHaveLength(2);
  });

  test("treats a blank logId the same as absent (guards the bare `fluncle://`)", () => {
    const filter = clipCutFilterComplex({ ...noCoordinate, logId: "   " });

    expect(filter).not.toContain("fluncle://");
    expect(filter).toContain(`y=h-${CLIP_SAFE_BOTTOM}-th`);
  });

  test("still renders the changing per-cue Track-ID for a cued un-promoted recording", () => {
    const members: ClipTrackInput[] = [
      { artists: ["Alpha"], startMs: 0, title: "One" },
      { artists: ["Beta"], startMs: 30_000, title: "Two" },
    ];
    const filter = clipCutFilterComplex({
      ...noCoordinate,
      inMs: 10_000,
      members,
      outMs: 40_000,
      setDurationMs: 60_000,
    });

    // Both straddled tracks get gated title lines (halo + sharp = 2 each) — but no coordinate.
    expect(filter.match(/drawtext=text='Alpha — One'/g)).toHaveLength(2);
    expect(filter.match(/drawtext=text='Beta — Two'/g)).toHaveLength(2);
    expect(filter).not.toContain("fluncle://");
  });
});

describe("clipCutFfmpegArgs", () => {
  const args = clipCutFfmpegArgs({
    inMs: 65_500,
    logId: "019.F.1A",
    outMs: 95_500,
    outputPath: "/tmp/clip.mp4",
    setUrl: "https://found.fluncle.com/019.F.1A/set.mp4",
    title: "Fluncle Dreaming 002",
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

  test("carries the brand frame as a -filter_complex, mapping [out] + optional audio", () => {
    expect(flagValue("-filter_complex")).toBe(
      clipCutFilterComplex({ logId: "019.F.1A", title: "Fluncle Dreaming 002", xOffset: 240 }),
    );
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

  test("un-cued set (no startMs anywhere) → [] so the cut falls back to the title", () => {
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

describe("clipCutFilterComplex — the changing on-screen Track-ID (cued set)", () => {
  const cued = {
    inMs: 55_000,
    logId: "019.F.1A",
    members: CUED_MEMBERS,
    outMs: 70_000,
    setDurationMs: SET_DURATION_MS,
    title: "Fluncle Dreaming 002",
    xOffset: 240,
  };

  test("a 1-track window stamps ONE gated track line + the coordinate (not the mixtape title)", () => {
    const filter = clipCutFilterComplex({ ...cued, inMs: 10_000, outMs: 40_000 });

    // The single resolved track (Alpha — First), gated across the whole clip (halo + sharp).
    expect(filter.match(/drawtext=text='Alpha — First'/g)).toHaveLength(2);
    // Its gate spans the whole 30s clip window (relStart 0 → clipDur 30).
    expect(filter.match(/enable='between\(t,0\.000,30\.000\)'/g)).toHaveLength(2);
    // The coordinate is still present (halo + sharp), ungated.
    expect(filter.match(/drawtext=text='fluncle\\:\/\/019\.F\.1A'/g)).toHaveLength(2);
    // The static mixtape title is NOT stamped when the set is cued.
    expect(filter).not.toContain("Fluncle Dreaming 002");
  });

  test("a 2-track-blend window stamps two gated track lines that change at the boundary", () => {
    const filter = clipCutFilterComplex(cued);

    // Both track IDs appear, each twice (halo + sharp).
    expect(filter.match(/drawtext=text='Alpha — First'/g)).toHaveLength(2);
    expect(filter.match(/drawtext=text='Beta\\, Gamma — Second'/g)).toHaveLength(2);

    // Track A shows from the clip start until the 60s cue (relStart 0 → 5s into the clip);
    // Track B takes over from 5s to the clip end (15s). Two `enable` gates, each twice.
    expect(filter.match(/enable='between\(t,0\.000,5\.000\)'/g)).toHaveLength(2);
    expect(filter.match(/enable='between\(t,5\.000,15\.000\)'/g)).toHaveLength(2);

    // The coordinate rides along ungated (halo + sharp).
    expect(filter.match(/drawtext=text='fluncle\\:\/\/019\.F\.1A'/g)).toHaveLength(2);
    // Same brand style as before: cream title role, dim Stardust coordinate, the soft halo.
    expect(filter).toContain(`fontcolor=${CLIP_TITLE_COLOR}:fontsize=40`);
    expect(filter).toContain(`fontcolor=${CLIP_COORDINATE_COLOR}:fontsize=22`);
    expect(filter).toContain(`[ink1]gblur=sigma=${CLIP_HALO_CORE_SIGMA}[core]`);
    expect(filter.endsWith("[out]")).toBe(true);
  });

  test("un-cued members fall back to the static mixtape-title overlay (today's behavior)", () => {
    const uncued: ClipTrackInput[] = [
      { artists: ["Alpha"], title: "First" },
      { artists: ["Beta"], title: "Second" },
    ];
    const filter = clipCutFilterComplex({ ...cued, members: uncued });

    // Falls back to the mixtape title, byte-identical to the no-members call.
    expect(filter).toBe(
      clipCutFilterComplex({ logId: "019.F.1A", title: "Fluncle Dreaming 002", xOffset: 240 }),
    );
    expect(filter.match(/drawtext=text='Fluncle Dreaming 002'/g)).toHaveLength(2);
    expect(filter).not.toContain("enable=");
  });

  test("omitting members entirely keeps the legacy static-title overlay unchanged", () => {
    const filter = clipCutFilterComplex({
      logId: "019.F.1A",
      title: "Fluncle Dreaming 002",
      xOffset: 240,
    });

    expect(filter.match(/drawtext=text='Fluncle Dreaming 002'/g)).toHaveLength(2);
    expect(filter).not.toContain("enable=");
  });
});
