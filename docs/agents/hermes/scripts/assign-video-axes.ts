#!/usr/bin/env bun

export const BAKED_GRAIN_FAMILIES = [
  "grainFineEmulsion",
  "grainCoarseSilver",
  "grainHalftone",
  "grainChemicalDye",
  "grainVhsScanline",
  "grainDither",
] as const;

const GRAIN_RECENT_WINDOW = 3;

export const ASSIGNED_REGISTER: VideoRegister = "representational";

const PALETTE_RECENT_WINDOW = 3;

export type VideoRegister = "abstract" | "representational" | "framed";

export type LedgerEntry = {
  logId?: string;
  vehicle?: string | null;
  grain?: string | null;
  register?: string | null;

  palette?: string | null;
};

export type Assignment = {
  grain: string;
  register: VideoRegister;

  paletteAvoid: string | null;
};

function normStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function grainUniverse(entries: LedgerEntry[]): string[] {
  const universe: string[] = [...BAKED_GRAIN_FAMILIES];
  for (const e of entries) {
    const g = normStr(e.grain);
    if (g && !universe.includes(g)) {
      universe.push(g);
    }
  }
  return universe;
}

export function assignGrain(entries: LedgerEntry[]): string {
  const universe = grainUniverse(entries);
  const recent = new Set(
    entries
      .slice(0, GRAIN_RECENT_WINDOW)
      .map((e) => normStr(e.grain))
      .filter((g): g is string => g !== null),
  );

  const lastSeen = new Map<string, number>();
  for (const fam of universe) {
    lastSeen.set(fam, Number.POSITIVE_INFINITY);
  }
  for (let i = 0; i < entries.length; i++) {
    const g = normStr(entries[i].grain);
    if (g && lastSeen.has(g) && lastSeen.get(g) === Number.POSITIVE_INFINITY) {
      lastSeen.set(g, i);
    }
  }

  const eligible = universe.filter((fam) => !recent.has(fam));
  const pool = eligible.length > 0 ? eligible : universe;

  let best = pool[0];
  let bestSeen = lastSeen.get(best) ?? Number.POSITIVE_INFINITY;
  for (const fam of pool) {
    const seen = lastSeen.get(fam) ?? Number.POSITIVE_INFINITY;
    if (seen > bestSeen) {
      best = fam;
      bestSeen = seen;
    }
  }
  return best;
}

function topRepeat<T>(values: (T | null)[]): { value: T; count: number } | null {
  const counts = new Map<T, number>();
  for (const v of values) {
    if (v !== null) {
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  let best: { value: T; count: number } | null = null;
  for (const [value, count] of counts) {
    if (!best || count > best.count) {
      best = { count, value };
    }
  }
  return best;
}

export function assignPaletteAvoid(entries: LedgerEntry[]): string | null {
  const window = entries.slice(0, PALETTE_RECENT_WINDOW);

  const buckets = window.map((e) => normStr(e.palette));
  const topBucket = topRepeat(buckets);
  if (topBucket && topBucket.count >= 2) {
    return `${topBucket.value} is the worn palette in the recent window — swing the hue clearly away from it`;
  }

  const grains = window.map((e) => normStr(e.grain));
  const hasAmberTexture = grains.some(
    (g) =>
      g !== null && (g.toLowerCase().includes("halftone") || g.toLowerCase().includes("dither")),
  );
  const topGrain = topRepeat(grains);
  const sharedGrain = topGrain !== null && topGrain.count >= 2;
  if (hasAmberTexture || sharedGrain) {
    return "warm amber/sepia + halftone is a spent look in the recent window — reach for a clearly different palette and texture";
  }

  return null;
}

export function computeAssignment(entries: LedgerEntry[]): Assignment {
  return {
    grain: assignGrain(entries),
    paletteAvoid: assignPaletteAvoid(entries),
    register: ASSIGNED_REGISTER,
  };
}

export function parseLedger(raw: string): LedgerEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { vehicles?: unknown }).vehicles)
      ? (parsed as { vehicles: unknown[] }).vehicles
      : null;
  if (!list) {
    return null;
  }
  return list.filter((e): e is LedgerEntry => e !== null && typeof e === "object");
}

export function toEnvLines(assignment: Assignment): string {
  const lines = [
    `FLUNCLE_VIDEO_GRAIN='${assignment.grain}'`,
    `FLUNCLE_VIDEO_REGISTER='${assignment.register}'`,
  ];
  if (assignment.paletteAvoid) {
    lines.push(`FLUNCLE_VIDEO_PALETTE_AVOID='${assignment.paletteAvoid}'`);
  }
  return lines.join("\n");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.main) {
  try {
    const raw = await readStdin();
    const entries = parseLedger(raw);
    if (!entries) {
      console.error("[assign-video-axes] malformed vehicles ledger — no assignment (fail-open)");
      process.exit(0);
    }
    const assignment = computeAssignment(entries);
    console.log(toEnvLines(assignment));
    process.exit(0);
  } catch (error) {
    console.error(
      `[assign-video-axes] ${error instanceof Error ? error.message : String(error)} — no assignment (fail-open)`,
    );
    process.exit(0);
  }
}
