// The ship gates: the hard checks ship.ts runs before it writes anything into a bundle.
//
// - judge:metrics (analyze-motion.ts) stamps out/<trackId>.metrics.json with the sha256
//   of the render it measured (`videoSha256`) and whether `--allow-flash` was passed
//   (`allowFlash`). Ship hashes out/<trackId>.mp4 and refuses unless that record exists,
//   measured THIS render, and cleared every hard gate (flash safety, beat-pull, arc). A
//   flash override is honoured only when the record carries it, and ship names it.
// - judge:palette's subject is the poster ship cuts from the square master, which does
//   not exist before ship. So ship runs the palette gate itself on that poster and refuses
//   on a FAIL. No published neighbour to compare against is a pass.
//
// The verdicts are pure over parsed inputs, so ship-gates.test.ts covers them without
// renders, network, or fs (sha256File aside).

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

import { type PaletteGate } from "./judge-palette";

export type GateVerdict = { ok: true; notes: string[] } | { ok: false; reason: string };

/** Streamed sha256 of a file (hex). Streams in 1 MiB chunks so an hour-long set render
 *  never has to fit in one buffer. */
export function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    let bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decide whether the judge:metrics record clears the render ship is about to package.
 * `record` is the parsed out/<trackId>.metrics.json (null when absent or unparseable);
 * `renderSha256` is the digest of out/<trackId>.mp4 as it sits on disk now.
 */
export function metricsGateVerdict(input: {
  record: unknown;
  renderSha256: string;
  trackId: string;
}): GateVerdict {
  const rerun = `bun run --cwd packages/video judge:metrics ${input.trackId}`;
  const record = input.record;

  if (!isRecord(record)) {
    return {
      ok: false,
      reason: `no judge:metrics record for out/${input.trackId}.mp4. Run: ${rerun}`,
    };
  }
  if (typeof record.videoSha256 !== "string") {
    return {
      ok: false,
      reason: `out/${input.trackId}.metrics.json carries no render digest, so it cannot be tied to this render. Re-run: ${rerun}`,
    };
  }
  if (record.videoSha256 !== input.renderSha256) {
    return {
      ok: false,
      reason: `out/${input.trackId}.metrics.json measured a different render than out/${input.trackId}.mp4 (stale record). Re-run: ${rerun}`,
    };
  }

  const gate = isRecord(record.gate) ? record.gate : {};
  const blocking = Array.isArray(gate.blockingFailures)
    ? gate.blockingFailures.filter((f): f is string => typeof f === "string")
    : [];
  if (gate.hardPass !== true || blocking.length > 0) {
    const named = blocking.length > 0 ? blocking.join(", ") : "no hardPass in the record";
    return {
      ok: false,
      reason: `judge:metrics FAILED (${named}). Revise the composition, re-render, and re-run: ${rerun}`,
    };
  }

  const notes: string[] = [];
  const flash = isRecord(record.flashSafety) ? record.flashSafety : {};
  if (flash.unsafe === true) {
    if (record.allowFlash !== true) {
      return {
        ok: false,
        reason: `out/${input.trackId}.metrics.json reports an unsafe flash but records no --allow-flash override. Re-run: ${rerun}`,
      };
    }
    notes.push(
      "WARNING: the flash-safety gate was overridden with --allow-flash (recorded in metrics.json). This clip strobes past the WCAG 2.3.1 limit.",
    );
  }
  return { notes, ok: true };
}

/** Decide whether the palette gate result clears the poster ship just cut. */
export function paletteGateVerdict(gate: PaletteGate): GateVerdict {
  if (gate.status === "fail") {
    return {
      ok: false,
      reason: `judge:palette FAILED: ${gate.verdict}. Swing the palette clearly away from that neighbour, re-render, and re-run ship.`,
    };
  }
  return { notes: [`palette gate: ${gate.verdict}`], ok: true };
}
