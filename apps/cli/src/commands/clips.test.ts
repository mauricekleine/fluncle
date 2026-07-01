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
