import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { decodeImageRgb } from "./frames";
import { bhattacharyya, featureOf, fetchRecentVideoLogIds } from "./judge-diversity";

const DECODE_SIZE = 160;
const DEFAULT_NEIGHBOURS = 3;

export const PALETTE_MIN = 0.18;

const posterUrl = (logId: string): string => `https://found.fluncle.com/${logId}/poster.jpg`;

export type PaletteGateStatus = "pass" | "fail" | "skipped";

export type PaletteNeighbourDistance = {
  logId: string;
  immediate: boolean;
  distance: number;
};

export type PaletteGate = {
  subject: string;
  threshold: number;
  neighbours: PaletteNeighbourDistance[];

  nearestDistance: number | null;

  nearestAt: number | null;
  status: PaletteGateStatus;
  pass: boolean;
  verdict: string;
};

export function evaluatePaletteGate(
  subject: string,
  subjectHist: Float32Array,
  neighbourHists: { logId: string; hist: Float32Array }[],
  threshold: number = PALETTE_MIN,
): PaletteGate {
  if (neighbourHists.length === 0) {
    return {
      nearestAt: null,
      nearestDistance: null,
      neighbours: [],
      pass: true,
      status: "skipped",
      subject,
      threshold,
      verdict: "no published neighbour to compare against (pass)",
    };
  }

  const neighbours: PaletteNeighbourDistance[] = neighbourHists.map((n, i) => ({
    distance: bhattacharyya(subjectHist, n.hist),
    immediate: i === 0,
    logId: n.logId,
  }));

  let nearestAt = 0;
  for (let i = 1; i < neighbours.length; i++) {
    if (neighbours[i].distance < neighbours[nearestAt].distance) {
      nearestAt = i;
    }
  }
  const nearestDistance = neighbours[nearestAt].distance;
  const pass = nearestDistance >= threshold;
  const nearest = neighbours[nearestAt];

  return {
    nearestAt,
    nearestDistance,
    neighbours,
    pass,
    status: pass ? "pass" : "fail",
    subject,
    threshold,
    verdict: pass
      ? `palette is distinct from the last ${neighbours.length} (nearest ${nearest.logId}: ${nearestDistance.toFixed(3)} >= ${threshold})`
      : `palette TOO CLOSE to ${nearest.logId} (${nearestDistance.toFixed(3)} < ${threshold}) — the same palette recolored at most; swing the hue`,
  };
}

function decodePoster(pathOrLogId: string, scratchDir: string): Float32Array {
  const isLocal =
    pathOrLogId.endsWith(".jpg") || pathOrLogId.endsWith(".png") || existsSync(pathOrLogId);
  if (isLocal) {
    return featureOf(decodeImageRgb(pathOrLogId, { height: DECODE_SIZE, width: DECODE_SIZE }))
      .colorHist;
  }

  const tmp = path.join(scratchDir, `${pathOrLogId.replace(/[^\w.-]/g, "_")}.jpg`);
  return featureOf(decodeImageRgb(tmp, { height: DECODE_SIZE, width: DECODE_SIZE })).colorHist;
}

async function fetchPosterTo(logId: string, scratchDir: string): Promise<void> {
  const res = await fetch(posterUrl(logId));
  if (!res.ok) {
    throw new Error(`poster fetch failed for ${logId}: ${res.status} ${res.statusText}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(path.join(scratchDir, `${logId.replace(/[^\w.-]/g, "_")}.jpg`), bytes);
}

export async function judgePalette(
  subject: string,
  opts: { excludeLogId?: string; neighbours?: number; threshold?: number } = {},
): Promise<PaletteGate> {
  const wanted = opts.neighbours ?? DEFAULT_NEIGHBOURS;
  const threshold = opts.threshold ?? PALETTE_MIN;
  const scratchDir = mkdtempSync(path.join(tmpdir(), "fluncle-palette-"));
  try {
    const subjectLogId = subject.endsWith(".jpg") || subject.endsWith(".png") ? null : subject;
    if (subjectLogId && !existsSync(subject)) {
      await fetchPosterTo(subjectLogId, scratchDir);
    }
    const subjectHist = decodePoster(subject, scratchDir);

    const excluded = opts.excludeLogId ?? subjectLogId;
    const ids = (await fetchRecentVideoLogIds(wanted + 1))
      .filter((id) => id !== excluded)
      .slice(0, wanted);

    const neighbourHists: { logId: string; hist: Float32Array }[] = [];
    for (const id of ids) {
      await fetchPosterTo(id, scratchDir);
      neighbourHists.push({ hist: decodePoster(id, scratchDir), logId: id });
    }

    return evaluatePaletteGate(subject, subjectHist, neighbourHists, threshold);
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const flagValue = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const neighboursRaw = flagValue("--neighbours");
  const neighbours = neighboursRaw !== undefined ? Number(neighboursRaw) : undefined;
  const thresholdRaw = flagValue("--threshold");
  const threshold = thresholdRaw !== undefined ? Number(thresholdRaw) : undefined;
  const valueFlags = new Set(["--neighbours", "--threshold"]);
  const subject = args.find((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1] ?? ""));

  if (!subject) {
    console.error(
      "usage: judge-palette <posterPathOrLogId> [--neighbours N] [--threshold T] [--json]",
    );
    process.exit(2);
  }

  const gate = await judgePalette(subject, { neighbours, threshold });
  if (asJson) {
    console.log(JSON.stringify(gate, null, 2));
  } else {
    console.log(`palette of ${gate.subject} vs the last ${gate.neighbours.length} published:`);
    for (const n of gate.neighbours) {
      const mark =
        gate.nearestAt !== null && gate.neighbours[gate.nearestAt] === n ? "←nearest" : "";
      console.log(
        `    ${n.immediate ? "→" : " "} ${n.logId}: ${n.distance.toFixed(3)} ${mark}`.trimEnd(),
      );
    }
    console.log(`${gate.pass ? "✓" : "✗"} ${gate.verdict}`);
  }

  process.exit(gate.status === "fail" ? 1 : 0);
}
