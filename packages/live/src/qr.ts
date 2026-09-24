// A MINIMAL QR ENCODER — so the room can scan its way onto the wall.
//
// The crew wall lives at `http://<lan-ip>:4180/crew`, and nobody at a party types an IP
// address. A QR does it in one tap, so `run show` prints one in the terminal and the wall
// overlay carries one in its corner. It is written here rather than pulled from npm for one
// reason: the live rig has NO network dependency mid-show (the never-crash rail), which rules
// out every hosted chart/QR service, and the encoder itself is small, pure, and testable.
//
// Deliberately narrow: BYTE mode, error-correction level M (~15% recovery — comfortable for
// a phone camera pointed at a screen), versions 1-10 (up to 213 bytes). That covers a LAN URL
// with room to spare and keeps the block tables short. `encodeQr` throws only when the text
// genuinely does not fit — callers print the bare URL instead (see `show.ts`).
//
// Everything here is pure: text in, boolean matrix out. `qr.test.ts` pins the structural
// invariants (finder/timing/alignment patterns, format bits, the fixed size law); a
// round-trip through a real scanner is the acceptance check recorded in the README.

/** The Galois field GF(256) used by QR's Reed-Solomon codes (primitive polynomial 0x11d). */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0;
  }
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** The generator polynomial for `degree` error-correction codewords. */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let d = 0; d < degree; d++) {
    const next = new Uint8Array(poly.length + 1);
    for (let i = 0; i < poly.length; i++) {
      next[i] ^= poly[i];
      next[i + 1] ^= gfMul(poly[i], GF_EXP[d]);
    }
    poly = next;
  }
  return poly;
}

/** The `ecCount` Reed-Solomon codewords for one data block. */
function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGenerator(ecCount);
  const out = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ out[0];
    out.copyWithin(0, 1);
    out[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i++) {
        out[i] ^= gfMul(gen[i + 1], factor);
      }
    }
  }
  return out;
}

/**
 * The level-M block structure per version: total codewords, error-correction codewords per
 * block, and the block groups (`count` blocks each holding `dataCodewords`). Straight from
 * the QR spec's Table 9 (level M rows only — the one level this encoder emits).
 */
type VersionSpec = {
  totalCodewords: number;
  ecPerBlock: number;
  groups: Array<{ count: number; dataCodewords: number }>;
};

const VERSIONS: Record<number, VersionSpec> = {
  1: { ecPerBlock: 10, groups: [{ count: 1, dataCodewords: 16 }], totalCodewords: 26 },
  10: {
    ecPerBlock: 26,
    groups: [
      { count: 4, dataCodewords: 43 },
      { count: 1, dataCodewords: 44 },
    ],
    totalCodewords: 346,
  },
  2: { ecPerBlock: 16, groups: [{ count: 1, dataCodewords: 28 }], totalCodewords: 44 },
  3: { ecPerBlock: 26, groups: [{ count: 1, dataCodewords: 44 }], totalCodewords: 70 },
  4: { ecPerBlock: 18, groups: [{ count: 2, dataCodewords: 32 }], totalCodewords: 100 },
  5: { ecPerBlock: 24, groups: [{ count: 2, dataCodewords: 43 }], totalCodewords: 134 },
  6: { ecPerBlock: 16, groups: [{ count: 4, dataCodewords: 27 }], totalCodewords: 172 },
  7: { ecPerBlock: 18, groups: [{ count: 4, dataCodewords: 31 }], totalCodewords: 196 },
  8: {
    ecPerBlock: 22,
    groups: [
      { count: 2, dataCodewords: 38 },
      { count: 2, dataCodewords: 39 },
    ],
    totalCodewords: 242,
  },
  9: {
    ecPerBlock: 22,
    groups: [
      { count: 3, dataCodewords: 36 },
      { count: 2, dataCodewords: 37 },
    ],
    totalCodewords: 292,
  },
};

/** The alignment-pattern centre coordinates per version (none for version 1). */
const ALIGNMENT: Record<number, number[]> = {
  1: [],
  10: [6, 28, 50],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
};

/** The highest version this encoder emits. */
export const QR_MAX_VERSION = 10;
/** Level M's bit indicator in the format information. */
const EC_LEVEL_M_BITS = 0b00;

/** How many data codewords a version holds (the sum over its block groups). */
function dataCodewords(spec: VersionSpec): number {
  return spec.groups.reduce((sum, g) => sum + g.count * g.dataCodewords, 0);
}

/** The character-count field width for byte mode: 8 bits up to version 9, 16 from 10. */
function countBits(version: number): number {
  return version < 10 ? 8 : 16;
}

/** How many bytes of byte-mode payload fit at `version` (level M). */
export function qrCapacity(version: number): number {
  const spec = VERSIONS[version];
  if (spec === undefined) {
    return 0;
  }
  return Math.floor((dataCodewords(spec) * 8 - 4 - countBits(version)) / 8);
}

/** The smallest version that holds `byteLength`, or null when it exceeds version 10. */
export function qrVersionFor(byteLength: number): number | null {
  for (let version = 1; version <= QR_MAX_VERSION; version++) {
    if (byteLength <= qrCapacity(version)) {
      return version;
    }
  }
  return null;
}

/** A growable MSB-first bit buffer. */
function bitBuffer(): { push(value: number, bits: number): void; bits: number[] } {
  const bits: number[] = [];
  return {
    bits,
    push(value, width) {
      for (let i = width - 1; i >= 0; i--) {
        bits.push((value >>> i) & 1);
      }
    },
  };
}

/** Encode the payload to the version's full, padded, interleaved codeword stream. */
function codewordsFor(bytes: Uint8Array, version: number): Uint8Array {
  const spec = VERSIONS[version];
  const buf = bitBuffer();
  buf.push(0b0100, 4); // byte mode
  buf.push(bytes.length, countBits(version));
  for (const byte of bytes) {
    buf.push(byte, 8);
  }

  const capacityBits = dataCodewords(spec) * 8;
  // Terminator: up to four zero bits, then pad to the byte boundary.
  const terminator = Math.min(4, capacityBits - buf.bits.length);
  buf.push(0, terminator);
  while (buf.bits.length % 8 !== 0) {
    buf.push(0, 1);
  }
  // Pad codewords alternate 0xEC / 0x11 until the data capacity is full.
  const padBytes = [0xec, 0x11];
  let pad = 0;
  while (buf.bits.length < capacityBits) {
    buf.push(padBytes[pad++ % 2], 8);
  }

  const data = new Uint8Array(buf.bits.length / 8);
  for (let i = 0; i < data.length; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      byte = (byte << 1) | buf.bits[i * 8 + b];
    }
    data[i] = byte;
  }

  // Split into blocks, Reed-Solomon each, then interleave data then EC (spec §7.6).
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const group of spec.groups) {
    for (let b = 0; b < group.count; b++) {
      const block = data.slice(offset, offset + group.dataCodewords);
      offset += group.dataCodewords;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, spec.ecPerBlock));
    }
  }

  const out: number[] = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) {
        out.push(block[i]);
      }
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const block of ecBlocks) {
      out.push(block[i]);
    }
  }
  return new Uint8Array(out);
}

/** 15-bit BCH format information for level M under `mask`, XOR-masked per the spec. */
function formatBits(mask: number): number {
  let value = ((EC_LEVEL_M_BITS << 3) | mask) << 10;
  const data = value;
  for (let i = 14; i >= 10; i--) {
    if ((value >>> i) & 1) {
      value ^= 0b10100110111 << (i - 10);
    }
  }
  return (data | value) ^ 0b101010000010010;
}

/** 18-bit BCH version information (versions 7 and up carry it). */
function versionBits(version: number): number {
  let value = version << 12;
  const data = value;
  for (let i = 17; i >= 12; i--) {
    if ((value >>> i) & 1) {
      value ^= 0b1111100100101 << (i - 12);
    }
  }
  return data | value;
}

type Grid = {
  size: number;
  /** The module colour: true = dark. */
  modules: boolean[][];
  /** True where a function pattern lives, so data placement and masking skip it. */
  reserved: boolean[][];
};

function newGrid(size: number): Grid {
  return {
    modules: Array.from({ length: size }, () => Array.from({ length: size }, () => false)),
    reserved: Array.from({ length: size }, () => Array.from({ length: size }, () => false)),
    size,
  };
}

function setModule(grid: Grid, row: number, col: number, dark: boolean): void {
  grid.modules[row][col] = dark;
  grid.reserved[row][col] = true;
}

/** The three 7x7 finder patterns plus their one-module separators. */
function placeFinders(grid: Grid): void {
  const corners = [
    [0, 0],
    [0, grid.size - 7],
    [grid.size - 7, 0],
  ];
  for (const [top, left] of corners) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const row = top + r;
        const col = left + c;
        if (row < 0 || col < 0 || row >= grid.size || col >= grid.size) {
          continue;
        }
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const onBorder = inRing && (r === 0 || r === 6 || c === 0 || c === 6);
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setModule(grid, row, col, onBorder || inCore);
      }
    }
  }
}

/** The two timing lines on row 6 and column 6. */
function placeTiming(grid: Grid): void {
  for (let i = 8; i < grid.size - 8; i++) {
    const dark = i % 2 === 0;
    setModule(grid, 6, i, dark);
    setModule(grid, i, 6, dark);
  }
}

/** The 5x5 alignment patterns, skipping the three finder corners. */
function placeAlignment(grid: Grid, version: number): void {
  const centres = ALIGNMENT[version];
  for (const row of centres) {
    for (const col of centres) {
      const nearFinder =
        (row === 6 && col === 6) ||
        (row === 6 && col === grid.size - 7) ||
        (row === grid.size - 7 && col === 6);
      if (nearFinder) {
        continue;
      }
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const ring = Math.max(Math.abs(r), Math.abs(c));
          setModule(grid, row + r, col + c, ring !== 1);
        }
      }
    }
  }
}

/** Reserve the format-information strips and the always-dark module. */
function reserveFormat(grid: Grid): void {
  for (let i = 0; i < 9; i++) {
    if (!grid.reserved[8][i]) {
      grid.reserved[8][i] = true;
    }
    if (!grid.reserved[i][8]) {
      grid.reserved[i][8] = true;
    }
  }
  for (let i = 0; i < 8; i++) {
    grid.reserved[8][grid.size - 1 - i] = true;
    grid.reserved[grid.size - 1 - i][8] = true;
  }
  // The dark module, always set (spec §7.9.1).
  setModule(grid, grid.size - 8, 8, true);
}

/** Reserve the two 3x6 version-information blocks (versions 7 and up). */
function reserveVersion(grid: Grid, version: number): void {
  if (version < 7) {
    return;
  }
  for (let i = 0; i < 18; i++) {
    const row = Math.floor(i / 3);
    const col = i % 3;
    grid.reserved[grid.size - 11 + col][row] = true;
    grid.reserved[row][grid.size - 11 + col] = true;
  }
}

/** Write the version information bits (versions 7 and up). */
function placeVersion(grid: Grid, version: number): void {
  if (version < 7) {
    return;
  }
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const row = Math.floor(i / 3);
    const col = i % 3;
    grid.modules[grid.size - 11 + col][row] = dark;
    grid.modules[row][grid.size - 11 + col] = dark;
  }
}

/**
 * Write the format information for `mask` into both copies. The mapping is the spec's fixed
 * one (§7.9): bits 0-5 run DOWN column 8, bits 6-8 turn the corner, bits 9-14 run back along
 * row 8 — then the same word again, split across the bottom-left and top-right finders.
 */
function placeFormat(grid: Grid, mask: number): void {
  const bits = formatBits(mask);
  const bitAt = (i: number): boolean => ((bits >>> i) & 1) === 1;
  const size = grid.size;
  // The copy wrapped around the top-left finder.
  for (let i = 0; i <= 5; i++) {
    grid.modules[i][8] = bitAt(i);
  }
  grid.modules[8][7] = bitAt(6);
  grid.modules[8][8] = bitAt(7);
  grid.modules[7][8] = bitAt(8);
  for (let i = 9; i <= 14; i++) {
    grid.modules[8][14 - i] = bitAt(i);
  }
  // The copy split along the bottom-left and top-right finders.
  for (let i = 0; i <= 7; i++) {
    grid.modules[8][size - 1 - i] = bitAt(i);
  }
  for (let i = 8; i <= 14; i++) {
    grid.modules[size - 15 + i][8] = bitAt(i);
  }
}

/** The eight mask conditions (spec Table 10). */
function maskAt(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

/** Walk the zigzag data region and place the codeword bits, masked. */
function placeData(grid: Grid, codewords: Uint8Array, mask: number): void {
  let bit = 0;
  const totalBits = codewords.length * 8;
  const nextBit = (): boolean => {
    if (bit >= totalBits) {
      return false; // remainder modules are light
    }
    const dark = ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1;
    bit++;
    return dark;
  };

  let upward = true;
  for (let right = grid.size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing line; the pair skips over it.
    const colPair = right === 6 ? [5, 4] : [right, right - 1];
    for (let step = 0; step < grid.size; step++) {
      const row = upward ? grid.size - 1 - step : step;
      for (const col of colPair) {
        if (grid.reserved[row][col]) {
          continue;
        }
        grid.modules[row][col] = nextBit() !== maskAt(mask, row, col);
      }
    }
    upward = !upward;
    if (right === 6) {
      right -= 1; // the pair consumed columns 5 and 4
    }
  }
}

/** The spec's four mask-penalty rules — lower is better. */
function penalty(grid: Grid): number {
  const { size, modules } = grid;
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules in a row or column.
  const runScore = (run: number): number => (run >= 5 ? 3 + (run - 5) : 0);
  for (let i = 0; i < size; i++) {
    let rowRun = 1;
    let colRun = 1;
    for (let j = 1; j < size; j++) {
      if (modules[i][j] === modules[i][j - 1]) {
        rowRun += 1;
      } else {
        score += runScore(rowRun);
        rowRun = 1;
      }
      if (modules[j][i] === modules[j - 1][i]) {
        colRun += 1;
      } else {
        score += runScore(colRun);
        colRun = 1;
      }
    }
    score += runScore(rowRun) + runScore(colRun);
  }

  // Rule 2: every 2x2 block of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  // Rule 3: the finder-lookalike 1:1:3:1:1 pattern with four light modules either side.
  const FINDER = [true, false, true, true, true, false, true];
  const matches = (get: (i: number) => boolean, start: number, len: number): boolean => {
    for (let i = 0; i < 7; i++) {
      if (get(start + i) !== FINDER[i]) {
        return false;
      }
    }
    const lightRun = (from: number): boolean => {
      for (let i = 0; i < 4; i++) {
        const at = from + i;
        if (at >= 0 && at < len && get(at)) {
          return false;
        }
      }
      return true;
    };
    return lightRun(start - 4) || lightRun(start + 7);
  };
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 7 <= size; j++) {
      if (matches((k) => modules[i][k], j, size)) {
        score += 40;
      }
      if (matches((k) => modules[k][i], j, size)) {
        score += 40;
      }
    }
  }

  // Rule 4: deviation of the dark-module share from 50%.
  let dark = 0;
  for (const row of modules) {
    for (const cell of row) {
      if (cell) {
        dark++;
      }
    }
  }
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * Encode `text` as a QR matrix (level M, byte mode, versions 1-10). Returns the module grid
 * WITHOUT a quiet zone — the renderers add it. Throws when the text is longer than version
 * 10 holds (213 bytes); callers fall back to printing the URL itself.
 */
export function encodeQr(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version = qrVersionFor(bytes.length);
  if (version === null) {
    throw new RangeError(
      `qr: ${bytes.length} bytes exceeds version ${QR_MAX_VERSION} (${qrCapacity(QR_MAX_VERSION)} bytes at level M)`,
    );
  }
  const codewords = codewordsFor(bytes, version);
  const size = 17 + version * 4;

  let best: { grid: Grid; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const grid = newGrid(size);
    placeFinders(grid);
    placeTiming(grid);
    placeAlignment(grid, version);
    reserveFormat(grid);
    reserveVersion(grid, version);
    placeData(grid, codewords, mask);
    placeFormat(grid, mask);
    placeVersion(grid, version);
    const score = penalty(grid);
    if (best === null || score < best.score) {
      best = { grid, score };
    }
  }
  if (best === null) {
    throw new Error("qr: no mask produced a grid"); // unreachable: the loop always runs
  }
  return best.grid.modules;
}

/** The quiet zone every renderer pads with (four light modules, per the spec). */
export const QR_QUIET_ZONE = 4;

/**
 * `text` as a standalone SVG, sized in CSS pixels by `size`. `shapeRendering: crispEdges`
 * keeps the modules hard-edged at any scale — a blurred QR is an unscannable QR.
 */
export function qrSvg(
  text: string,
  opts?: { size?: number; dark?: string; light?: string },
): string {
  const modules = encodeQr(text);
  const quiet = QR_QUIET_ZONE;
  const span = modules.length + quiet * 2;
  const size = opts?.size ?? 200;
  const dark = opts?.dark ?? "#090a0b";
  const light = opts?.light ?? "#f4ead7";
  const rects: string[] = [];
  for (let r = 0; r < modules.length; r++) {
    for (let c = 0; c < modules.length; c++) {
      if (modules[r][c]) {
        rects.push(`<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`);
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="QR code for ${escapeXml(text)}">` +
    `<rect width="${span}" height="${span}" fill="${light}"/>` +
    `<g fill="${dark}">${rects.join("")}</g></svg>`
  );
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * `text` as terminal art, two module rows per text line via half-block glyphs, with EXPLICIT
 * black-on-white colours so it scans on a light or a dark terminal theme alike (a QR rendered
 * in the theme's own colours inverts on half the machines and scans on neither).
 */
export function qrAscii(text: string): string {
  const modules = encodeQr(text);
  const quiet = QR_QUIET_ZONE;
  const span = modules.length + quiet * 2;
  const dark = (row: number, col: number): boolean => {
    const r = row - quiet;
    const c = col - quiet;
    if (r < 0 || c < 0 || r >= modules.length || c >= modules.length) {
      return false; // the quiet zone is light
    }
    return modules[r][c];
  };
  const lines: string[] = [];
  for (let row = 0; row < span; row += 2) {
    let line = "";
    for (let col = 0; col < span; col++) {
      const top = dark(row, col);
      const bottom = dark(row + 1, col);
      // Light modules are drawn as white ink on the black ground: a full block for two light
      // modules, an upper/lower half for one, a space for none.
      line += top && bottom ? " " : top ? "▄" : bottom ? "▀" : "█";
    }
    lines.push(`\u001b[37;40m${line}\u001b[0m`);
  }
  return lines.join("\n");
}

/** How wide `qrAscii` renders for `text`, in terminal columns (the caller's width check). */
export function qrAsciiWidth(text: string): number {
  const bytes = new TextEncoder().encode(text).length;
  const version = qrVersionFor(bytes);
  return version === null ? Number.POSITIVE_INFINITY : 17 + version * 4 + QR_QUIET_ZONE * 2;
}
