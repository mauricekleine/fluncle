// PROOF THAT THE CREW WALL'S QR ACTUALLY SCANS.
//
// `qr.test.ts` pins a golden matrix and the structural invariants, but a golden only proves
// the encoder still emits what it emitted the day a REAL scanner read it. This script is that
// day, repeatable: it encodes a set of URLs plus every version at full capacity, renders each
// matrix to a bitmap, and decodes it with OpenCV's `QRCodeDetector`, requiring the source
// string back. Run it after any change to `src/qr.ts`, then refresh the golden if the matrix
// moved deliberately.
//
//   bun run --cwd packages/live qr:verify
//
// It is deliberately NOT part of `bun test`: it needs `uv` and downloads OpenCV, the same
// reason `test:matcher-accuracy` sits outside the suite.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeQr, QR_MAX_VERSION, QR_QUIET_ZONE, qrCapacity } from "../src/qr";

/** The shapes that matter: real LAN crew URLs, then every version at its exact capacity. */
function cases(): string[] {
  const urls = [
    "http://192.168.1.42:4180/crew",
    "http://10.0.0.7:4180/crew",
    "http://172.16.31.200:4180/crew",
  ];
  const versions = Array.from({ length: QR_MAX_VERSION }, (_, i) => "x".repeat(qrCapacity(i + 1)));
  return [...urls, ...versions];
}

/** One matrix as quiet-zoned rows of 0/1, the shape the decoder script reads. */
function rowsFor(text: string): string[] {
  const modules = encodeQr(text);
  const quiet = QR_QUIET_ZONE;
  const span = modules.length + quiet * 2;
  const rows: string[] = [];
  for (let r = 0; r < span; r++) {
    let line = "";
    for (let c = 0; c < span; c++) {
      const rr = r - quiet;
      const cc = c - quiet;
      const dark =
        rr >= 0 && cc >= 0 && rr < modules.length && cc < modules.length && modules[rr][cc];
      line += dark ? "1" : "0";
    }
    rows.push(line);
  }
  return rows;
}

const DECODER = `
import json, sys
import numpy as np, cv2

failures = 0
for line in open(sys.argv[1]):
    rec = json.loads(line)
    rows = rec["rows"]
    n, scale = len(rows), 10
    img = np.full((n * scale, n * scale), 255, np.uint8)
    for r, row in enumerate(rows):
        for c, ch in enumerate(row):
            if ch == "1":
                img[r * scale:(r + 1) * scale, c * scale:(c + 1) * scale] = 0
    read, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
    ok = read == rec["text"]
    failures += 0 if ok else 1
    label = rec["text"] if len(rec["text"]) <= 34 else rec["text"][:31] + "..."
    print(("  [clear] " if ok else "  [HOLD]  ") + str(rec["size"]).rjust(3) + " modules  " + label)
total = sum(1 for _ in open(sys.argv[1]))
if failures:
    print(str(failures) + " of " + str(total) + " FAILED to decode")
else:
    print("all " + str(total) + " decoded")
sys.exit(1 if failures else 0)
`;

const dir = mkdtempSync(join(tmpdir(), "fluncle-qr-verify-"));
const matrices = join(dir, "matrices.jsonl");
const decoder = join(dir, "decode.py");

const lines = cases().map((text) =>
  JSON.stringify({ rows: rowsFor(text), size: encodeQr(text).length, text }),
);
writeFileSync(matrices, `${lines.join("\n")}\n`);
writeFileSync(decoder, DECODER);

console.error(`qr:verify — decoding ${lines.length} matrices with OpenCV`);
const proc = Bun.spawnSync(
  ["uv", "run", "--with", "opencv-python-headless", "--with", "numpy", "python", decoder, matrices],
  {
    env: { ...process.env, UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? "/tmp/uv-cache" },
    stdio: ["ignore", "inherit", "inherit"],
  },
);
process.exit(proc.exitCode ?? 1);
