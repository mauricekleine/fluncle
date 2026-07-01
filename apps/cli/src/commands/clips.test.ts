import { describe, expect, test } from "bun:test";
import {
  CLIP_AUDIO_BITRATE,
  CLIP_BUFSIZE,
  CLIP_COORDINATE_COLOR,
  CLIP_CRF,
  CLIP_HALO_COLOR,
  CLIP_HEIGHT,
  CLIP_MARGIN_X,
  CLIP_MAXRATE,
  CLIP_SAFE_BOTTOM,
  CLIP_TITLE_COLOR,
  CLIP_WIDTH,
  brandDrawtext,
  clipCutFfmpegArgs,
  clipCutVideoFilter,
  clipFootageKey,
  escapeDrawtextValue,
  setVideoUrl,
} from "./clips";

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
  test("emits the given ink over a warm-dark ink-halo, never a #000 box", () => {
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
    expect(node).toContain(`bordercolor=${CLIP_HALO_COLOR}`);
    expect(node).toContain(`shadowcolor=${CLIP_HALO_COLOR}`);
    expect(node).toContain("shadowx=2");
    expect(node).toContain("shadowy=2");
    expect(node).not.toContain("box=1");
    expect(node).not.toContain("boxcolor");
  });

  test("takes the ink color per role (cream title vs stardust coordinate)", () => {
    const title = brandDrawtext({ color: CLIP_TITLE_COLOR, size: 40, text: "T", x: 0, y: 0 });
    const coord = brandDrawtext({ color: CLIP_COORDINATE_COLOR, size: 22, text: "c", x: 0, y: 0 });

    expect(title).toContain(`fontcolor=${CLIP_TITLE_COLOR}`);
    expect(coord).toContain(`fontcolor=${CLIP_COORDINATE_COLOR}`);
  });

  test("scales the ink-halo borderw with the font size (~13% of cap height)", () => {
    expect(brandDrawtext({ color: CLIP_TITLE_COLOR, size: 40, text: "T", x: 0, y: 0 })).toContain(
      "borderw=5",
    );
    expect(
      brandDrawtext({ color: CLIP_COORDINATE_COLOR, size: 22, text: "T", x: 0, y: 0 }),
    ).toContain("borderw=3");
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

describe("clipCutVideoFilter", () => {
  const base = { logId: "019.F.1A", title: "Fluncle Dreaming 002", xOffset: 240 };

  test("crops 16:9 → 9:16 at the xOffset, then scales to 1080×1920", () => {
    const filter = clipCutVideoFilter(base);

    expect(filter.startsWith(`crop=ih*9/16:ih:240:0,scale=${CLIP_WIDTH}:${CLIP_HEIGHT},`)).toBe(
      true,
    );
  });

  test("floors a negative / fractional xOffset to a clean integer", () => {
    expect(clipCutVideoFilter({ ...base, xOffset: -10 })).toContain("crop=ih*9/16:ih:0:0");
    expect(clipCutVideoFilter({ ...base, xOffset: 12.7 })).toContain("crop=ih*9/16:ih:13:0");
  });

  test("bakes the mixtape title + the fluncle:// coordinate, both as brand ink", () => {
    const filter = clipCutVideoFilter(base);

    expect(filter).toContain("drawtext=text='Fluncle Dreaming 002'");
    // The coordinate's `://` colon is escaped so ffmpeg doesn't split the filtergraph.
    expect(filter).toContain("drawtext=text='fluncle\\://019.F.1A'");
  });

  test("mirrors the Remotion TypePlate: cream title (40) over dim Stardust coordinate (22)", () => {
    const filter = clipCutVideoFilter(base);

    // Title = Starlight Cream at size 40 (trackLine); coordinate = Stardust at size 22 (logId).
    expect(filter).toContain(`fontcolor=${CLIP_TITLE_COLOR}:fontsize=40`);
    expect(filter).toContain(`fontcolor=${CLIP_COORDINATE_COLOR}:fontsize=22`);
    // A warm-dark ink-halo on BOTH lines, and no #000 caption box (Warm Dark Rule).
    expect(filter.match(new RegExp(`bordercolor=${CLIP_HALO_COLOR}`, "g"))).toHaveLength(2);
    expect(filter).not.toContain("boxcolor");
    expect(filter).not.toContain("box=1");
    // No gold in the overlay — it stays quiet, under the One-Sun budget.
    expect(filter.toLowerCase()).not.toContain("f5b800");
  });

  test("places both lines bottom-left in the platform safe-area (MARGIN_X, SAFE_BOTTOM)", () => {
    const filter = clipCutVideoFilter(base);

    // Both lines share the left inset; each line's BOTTOM is anchored via its own `th`.
    expect(filter.match(new RegExp(`x=${CLIP_MARGIN_X}:`, "g"))).toHaveLength(2);
    // Coordinate is the lower line: bottom exactly SAFE_BOTTOM above the frame bottom.
    expect(filter).toContain(`y=h-${CLIP_SAFE_BOTTOM}-th`);
    // Title sits above it (SAFE_BOTTOM + the coordinate's line box + the gap = 230+26+10).
    expect(filter).toContain("y=h-266-th");
  });

  test("threads both font roles: the sans for the title, Oxanium for the coordinate", () => {
    const filter = clipCutVideoFilter({
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
    expect(clipCutVideoFilter(base)).not.toContain("fontfile=");
  });

  test("escapes a hostile title into the filtergraph", () => {
    const filter = clipCutVideoFilter({ ...base, title: "edge: a,b 100%" });

    expect(filter).toContain("drawtext=text='edge\\: a\\,b 100\\%'");
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

  test("carries the crop+frame filter as a single -vf token", () => {
    expect(flagValue("-vf")).toBe(
      clipCutVideoFilter({ logId: "019.F.1A", title: "Fluncle Dreaming 002", xOffset: 240 }),
    );
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
