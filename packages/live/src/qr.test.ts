// The QR encoder. Two kinds of proof, because a QR that LOOKS right and does not scan is
// worse than no QR at all (the wall's whole point is that nobody types the IP):
//
//   * A GOLDEN MATRIX for the exact shape the wall encodes — a LAN crew URL. The golden was
//     verified by decoding a render of it with OpenCV's `QRCodeDetector`, which read back the
//     source string; every version 1-10 at full capacity was verified the same way. So this
//     fixture is not "what the code happens to emit", it is a matrix a real scanner reads.
//     Re-run that check (see the README's crew-wall section) if the encoder ever changes.
//   * STRUCTURAL invariants a broken change trips even where the golden does not reach: the
//     size law, the three finder patterns, the timing lines, the alignment patterns, the
//     always-dark module, and the capacity boundaries.

import { describe, expect, test } from "bun:test";

import {
  encodeQr,
  QR_MAX_VERSION,
  QR_QUIET_ZONE,
  qrAscii,
  qrAsciiWidth,
  qrCapacity,
  qrSvg,
  qrVersionFor,
} from "./qr";

/** The crew URL shape the wall encodes: a private LAN address, the bridge port, /crew. */
const CREW_URL = "http://192.168.1.42:4180/crew";

/** Verified by decoding a render of this matrix with OpenCV — it reads back CREW_URL. */
const CREW_URL_GOLDEN = [
  "#######.....####....#.#######",
  "#.....#.##.##..#..#.#.#.....#",
  "#.###.#.###...#.#.#...#.###.#",
  "#.###.#.#.#...##.##...#.###.#",
  "#.###.#..##.####...#..#.###.#",
  "#.....#..##..##.#.#...#.....#",
  "#######.#.#.#.#.#.#.#.#######",
  ".........#.#.#....#.#........",
  "#.....#####...##.##.###..###.",
  "##..##..###.#.#..#####..#.##.",
  "#####.#..#.#.....#.....##....",
  ".#..#...##.##.###..#..#.#....",
  ".##.#####.##.##......##.....#",
  "#..##...#######...##.##.#.###",
  "....#.#.###########..##...#..",
  "##.#.#..#..####.#..##.##..#.#",
  ".#...####.#.#.##.#..##....#..",
  "#.#......#..#...#..#..#.#####",
  "###...###.#.###.#.###..#....#",
  "#.#.#..##...#.###.#.#.#.#....",
  "#..#.##.####....##..#####.###",
  "........##.###..#.###...##...",
  "#######..#.#.####..##.#.###..",
  "#.....#....###......#...#..#.",
  "#.###.#..#..##.##..######....",
  "#.###.#...#..#..#...#..#...#.",
  "#.###.#..##.###..#.##.#.##.#.",
  "#.....#...#..#.#......###.#.#",
  "#######.#.#.##....#......##..",
];

const asRows = (modules: boolean[][]): string[] =>
  modules.map((row) => row.map((dark) => (dark ? "#" : ".")).join(""));

describe("encodeQr", () => {
  test("the golden matrix: a LAN crew URL encodes to the matrix OpenCV decoded", () => {
    expect(asRows(encodeQr(CREW_URL))).toEqual(CREW_URL_GOLDEN);
  });

  test("deterministic — the same text always picks the same mask and matrix", () => {
    expect(asRows(encodeQr(CREW_URL))).toEqual(asRows(encodeQr(CREW_URL)));
  });

  test("the size law holds at every version: 17 + 4v modules a side", () => {
    for (let version = 1; version <= QR_MAX_VERSION; version++) {
      const modules = encodeQr("x".repeat(qrCapacity(version)));
      expect(modules.length).toBe(17 + version * 4);
      expect(modules[0].length).toBe(17 + version * 4);
    }
  });

  test("the three finder patterns sit in their corners, with the fourth corner clear", () => {
    const modules = encodeQr(CREW_URL);
    const size = modules.length;
    const finderAt = (top: number, left: number): boolean => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
          const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          if (modules[top + r][left + c] !== (onBorder || inCore)) {
            return false;
          }
        }
      }
      return true;
    };
    expect(finderAt(0, 0)).toBe(true);
    expect(finderAt(0, size - 7)).toBe(true);
    expect(finderAt(size - 7, 0)).toBe(true);
    // The bottom-right corner carries data, never a fourth finder.
    expect(finderAt(size - 7, size - 7)).toBe(false);
  });

  test("the timing lines alternate along row 6 and column 6", () => {
    const modules = encodeQr(CREW_URL);
    for (let i = 8; i < modules.length - 8; i++) {
      expect(modules[6][i]).toBe(i % 2 === 0);
      expect(modules[i][6]).toBe(i % 2 === 0);
    }
  });

  test("version 2 carries its one alignment pattern centred at (18, 18)", () => {
    // 26 bytes fits version 2 exactly (version 1 holds 14).
    const modules = encodeQr("x".repeat(26));
    expect(modules.length).toBe(25);
    expect(modules[18][18]).toBe(true); // the centre module
    for (const [r, c] of [
      [17, 17],
      [17, 19],
      [19, 17],
      [19, 19],
    ]) {
      expect(modules[r][c]).toBe(false); // the light ring around it
    }
  });

  test("the always-dark module is set at [size - 8][8] for every version", () => {
    for (let version = 1; version <= QR_MAX_VERSION; version++) {
      const modules = encodeQr("x".repeat(qrCapacity(version)));
      expect(modules[modules.length - 8][8]).toBe(true);
    }
  });

  test("one byte over the version-10 capacity is refused, not silently truncated", () => {
    const max = qrCapacity(QR_MAX_VERSION);
    expect(() => encodeQr("x".repeat(max))).not.toThrow();
    expect(() => encodeQr("x".repeat(max + 1))).toThrow(RangeError);
  });

  test("multi-byte text is measured in BYTES, not characters", () => {
    // Each of these is 3 UTF-8 bytes, so 5 of them is 15 bytes: past version 1's 14.
    expect(qrVersionFor(new TextEncoder().encode("★★★★★").length)).toBe(2);
  });
});

describe("qrCapacity / qrVersionFor", () => {
  test("capacity rises with the version and starts at 14 bytes", () => {
    expect(qrCapacity(1)).toBe(14);
    for (let version = 2; version <= QR_MAX_VERSION; version++) {
      expect(qrCapacity(version)).toBeGreaterThan(qrCapacity(version - 1));
    }
  });

  test("an unknown version has no capacity", () => {
    expect(qrCapacity(0)).toBe(0);
    expect(qrCapacity(QR_MAX_VERSION + 1)).toBe(0);
  });

  test("the smallest fitting version is chosen, and nothing past version 10 fits", () => {
    expect(qrVersionFor(14)).toBe(1);
    expect(qrVersionFor(15)).toBe(2);
    expect(qrVersionFor(qrCapacity(QR_MAX_VERSION))).toBe(QR_MAX_VERSION);
    expect(qrVersionFor(qrCapacity(QR_MAX_VERSION) + 1)).toBeNull();
  });
});

describe("the renderers", () => {
  test("the SVG pads the spec's four-module quiet zone into its viewBox", () => {
    const svg = qrSvg(CREW_URL, { size: 256 });
    const span = CREW_URL_GOLDEN.length + QR_QUIET_ZONE * 2;
    expect(svg).toContain(`viewBox="0 0 ${span} ${span}"`);
    expect(svg).toContain('width="256" height="256"');
    expect(svg).toContain('shape-rendering="crispEdges"');
  });

  test("the SVG draws one rect per dark module, offset by the quiet zone", () => {
    const svg = qrSvg(CREW_URL);
    const dark = CREW_URL_GOLDEN.join("")
      .split("")
      .filter((ch) => ch === "#").length;
    expect(svg.split("<rect").length - 1).toBe(dark + 1); // +1 for the light ground
    // The top-left finder's first module lands at the quiet-zone origin.
    expect(svg).toContain(`<rect x="${QR_QUIET_ZONE}" y="${QR_QUIET_ZONE}" width="1" height="1"/>`);
  });

  test("the SVG escapes the label so a URL cannot break out of the attribute", () => {
    const svg = qrSvg('http://x/"><script>');
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&quot;&gt;&lt;script&gt;");
  });

  test("the terminal render packs two module rows per line and states its own width", () => {
    const span = CREW_URL_GOLDEN.length + QR_QUIET_ZONE * 2;
    const lines = qrAscii(CREW_URL).split("\n");
    expect(lines.length).toBe(Math.ceil(span / 2));
    expect(qrAsciiWidth(CREW_URL)).toBe(span);
  });

  test("the terminal render carries the SAME modules back, half-block for half-block", () => {
    // The half-block packing is its own transform, so decode it back to a matrix and compare:
    // a code that encodes correctly but renders wrong is just as unscannable.
    const modules = encodeQr(CREW_URL);
    const quiet = QR_QUIET_ZONE;
    const lines = qrAscii(CREW_URL)
      .split("\n")
      // Stripping the ANSI colour runs is exactly what this regex is for.
      // oxlint-disable-next-line no-control-regex
      .map((line) => line.replace(/\u001b\[[\d;]*m/g, ""));
    // Light modules are drawn as white ink: a full block for two, a half for one, a space for
    // neither. So a DARK module is where its half of the glyph is NOT painted.
    const darkAt = (row: number, col: number): boolean => {
      const glyph = lines[Math.floor(row / 2)][col];
      const top = glyph === "\u2588" || glyph === "\u2580";
      const bottom = glyph === "\u2588" || glyph === "\u2584";
      return !(row % 2 === 0 ? top : bottom);
    };
    for (let r = 0; r < modules.length; r++) {
      for (let c = 0; c < modules.length; c++) {
        expect(darkAt(r + quiet, c + quiet)).toBe(modules[r][c]);
      }
    }
    // The quiet zone stays light on every side.
    for (let c = 0; c < modules.length + quiet * 2; c++) {
      expect(darkAt(0, c)).toBe(false);
      expect(darkAt(1, c)).toBe(false);
    }
  });

  test("the terminal render pins explicit colours, so it scans on any terminal theme", () => {
    expect(qrAscii(CREW_URL).split("\n")[0]).toStartWith("\u001b[37;40m");
  });

  test("a text too long to encode reports an infinite width rather than throwing", () => {
    expect(qrAsciiWidth("x".repeat(qrCapacity(QR_MAX_VERSION) + 1))).toBe(Number.POSITIVE_INFINITY);
  });
});
