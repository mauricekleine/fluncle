#!/usr/bin/env bun
// assign-video-axes.ts — the DETERMINISTIC diversity-axis assigner for the per-finding
// video render. The standing law (docs/planning/homogenisation-evidence.md; ROADMAP
// § Homogenisation): sequential/parallel generation converges on a shared attractor, so
// diversity has to be DESIGNED IN UP FRONT — assign the family before generation;
// prescriptive mid-flight coaching increases convergence instead of fixing it. Today the
// render brief fires one static prompt every tick and all diversity pressure is the agent
// eyeballing recent posters, which produced the attractor anyway (07-13: four of five
// consecutive renders one amber/halftone look; 07-14: register collapsed to 24/26
// representational).
//
// This computes the NEXT render's cell — grain family, register, and a palette-avoid
// directive — from the vehicles ledger alone, so the assignment is fixed before the agent
// starts and the agent's creativity lives INSIDE the cell (vehicle name, shader concept,
// motion, composition stay fully free). It is invoked by render-conductor.sh, which pipes
// `fluncle admin tracks vehicles --json` to stdin and appends this script's env-line
// stdout to the box's /dev/shm/fluncle.env. FAIL-OPEN by contract: malformed input prints
// nothing and exits 0, so the render simply falls back to today's free-choice behaviour —
// a render is never blocked on the assigner.
//
// Self-contained (a box script cannot import the workspace); tested by
// assign-video-axes.test.ts (`bun test docs/agents/hermes/scripts/assign-video-axes.test.ts`).

// ── The dials (operator-tunable; edit here or override via the env vars below) ──────────

// The grain-family universe. These are the skill's six named `grainFamilies` presets
// (packages/skills/fluncle-video/references/cookbook.md § grain families) — the closed set
// the ledger's `grain` column records. The ledger's own distinct values are UNIONed on top
// at runtime, so a family the skill adds later is picked up without editing this list.
export const BAKED_GRAIN_FAMILIES = [
  "grainFineEmulsion",
  "grainCoarseSilver",
  "grainHalftone",
  "grainChemicalDye",
  "grainVhsScanline",
  "grainDither",
] as const;

// A grain family in the last N renders is EXCLUDED from this render (never repeat the
// immediate neighbourhood's grain). Among the rest, the least-recently-used wins.
const GRAIN_RECENT_WINDOW = 3;

// The register quota — retuned 2026-07-20 on the operator's TikTok read: the
// representational renders (the plate-lane pieces with real shapes, figures,
// artifacts) consistently outperform, abstract consistently underperforms. So
// representational is the strong default and abstract/framed keep REAL floors —
// the 07-14 anti-collapse purpose stands (never back to 92% one-register), the
// split just follows the audience now. Not taste law — the operator retunes by
// editing here (or the FLUNCLE_VIDEO_REGISTER_TARGETS env override). Must sum to 1.
export const DEFAULT_REGISTER_TARGETS: Record<VideoRegister, number> = {
  abstract: 0.15,
  framed: 0.2,
  representational: 0.65,
};

// The register decision looks back over this many renders (a wider window than grain — a
// register drifts over a longer arc, and the collapse was measured over ~dozens).
const REGISTER_WINDOW = 12;

// The palette-avoid directive looks at this many recent renders.
const PALETTE_RECENT_WINDOW = 3;

// ── Types ───────────────────────────────────────────────────────────────────────────────

export type VideoRegister = "abstract" | "representational" | "framed";
export const REGISTERS: readonly VideoRegister[] = ["abstract", "representational", "framed"];

/** One vehicles-ledger entry, as `fluncle admin tracks vehicles --json` emits it. All
 *  fields optional/loose — the ledger is a public read and older rows omit newer axes. */
export type LedgerEntry = {
  logId?: string;
  vehicle?: string | null;
  grain?: string | null;
  register?: string | null;
  /** The coarse palette hue-bucket tag (palette-summary.ts). Absent on rows shipped before
   *  palette provenance existed — the assigner's data-driven palette path lights up as this
   *  fills in. */
  palette?: string | null;
};

export type Assignment = {
  grain: string;
  register: VideoRegister;
  /** A NEGATIVE palette directive ("<X> is spent — avoid it"), or null when nothing in the
   *  recent window is clearly worn (the agent stays free on palette). */
  paletteAvoid: string | null;
};

// ── Grain: least-recently-used, excluding the last GRAIN_RECENT_WINDOW ──────────────────

function normStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The grain universe: the baked six UNION the ledger's own distinct grain values, in a
 *  stable order (baked first, then novel ledger values in first-seen order). */
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

/**
 * The least-recently-used grain family that does NOT appear in the last
 * GRAIN_RECENT_WINDOW renders. "Least recently used" = the family whose most-recent
 * appearance is oldest; a family that never appeared is maximally stale and wins. Ties
 * break by universe order (baked-list order first), so the choice is fully deterministic.
 * When every universe family happens to sit in the recent window (a tiny corpus), the
 * exclusion is relaxed rather than returning nothing.
 */
export function assignGrain(entries: LedgerEntry[]): string {
  const universe = grainUniverse(entries);
  const recent = new Set(
    entries
      .slice(0, GRAIN_RECENT_WINDOW)
      .map((e) => normStr(e.grain))
      .filter((g): g is string => g !== null),
  );

  // most-recent-appearance index per family (0 = newest); Infinity = never appeared.
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

  // Pick the STALEST (largest lastSeen); universe order is the deterministic tiebreak,
  // so iterate in universe order and take strictly-greater to keep the first on a tie.
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

// ── Register: largest deficit vs target over the last REGISTER_WINDOW ────────────────────

function asRegister(value: unknown): VideoRegister | null {
  return typeof value === "string" && (REGISTERS as readonly string[]).includes(value)
    ? (value as VideoRegister)
    : null;
}

/**
 * The register carrying the largest DEFICIT against its target share over the last
 * REGISTER_WINDOW renders. Deficit = target_count − actual_count, where
 * target_count = target_share × window_size. The collapse case (24/26 representational →
 * the recent window is all representational) yields a large positive deficit for BOTH
 * abstract and framed and a negative one for representational, so the pick is abstract or
 * framed — exactly the swing the evidence demands. Ties break toward whatever the
 * immediate neighbour is NOT, then by REGISTERS order.
 */
export function assignRegister(
  entries: LedgerEntry[],
  targets = DEFAULT_REGISTER_TARGETS,
): VideoRegister {
  const window = entries
    .slice(0, REGISTER_WINDOW)
    .map((e) => asRegister(e.register))
    .filter((r): r is VideoRegister => r !== null);
  const windowSize = window.length;

  const actual: Record<VideoRegister, number> = { abstract: 0, framed: 0, representational: 0 };
  for (const r of window) {
    actual[r] += 1;
  }

  // The immediate neighbour's register (newest entry that declares one) — the tiebreak.
  const neighbour = entries.map((e) => asRegister(e.register)).find((r) => r !== null) ?? null;

  const deficitOf = (r: VideoRegister): number => targets[r] * windowSize - actual[r];

  let best: VideoRegister = REGISTERS[0];
  for (const r of REGISTERS) {
    const d = deficitOf(r);
    const bd = deficitOf(best);
    if (d > bd) {
      best = r;
    } else if (d === bd && r !== best) {
      // Tie: prefer whichever is NOT the immediate neighbour; else keep REGISTERS order.
      if (best === neighbour && r !== neighbour) {
        best = r;
      }
    }
  }
  return best;
}

// ── Palette: a negative directive from what is worn ─────────────────────────────────────

/** The most-repeated non-null value in a list, plus its count. */
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

/**
 * A NEGATIVE palette directive derived from the recent window, or null when nothing is
 * clearly worn. Two paths, and the data-driven one takes over as palette provenance fills
 * in (piece 3 of the diversity slice records it):
 *   - DATA-DRIVEN: when the last PALETTE_RECENT_WINDOW renders carry palette buckets and one
 *     bucket dominates (≥2), direct the next render OFF that hue bucket.
 *   - FALLBACK (no palette recorded yet): the amber/halftone basin is what we know is worn
 *     (07-13), so when the recent window is amber-textured — a halftone/dither grain
 *     appears, or ≥2 of the last three share ANY grain family — name it spent.
 */
export function assignPaletteAvoid(entries: LedgerEntry[]): string | null {
  const window = entries.slice(0, PALETTE_RECENT_WINDOW);

  // Data-driven: a dominant palette bucket in the recent window.
  const buckets = window.map((e) => normStr(e.palette));
  const topBucket = topRepeat(buckets);
  if (topBucket && topBucket.count >= 2) {
    return `${topBucket.value} is the worn palette in the recent window — swing the hue clearly away from it`;
  }

  // Fallback: no palette provenance yet — steer off the known amber/halftone basin.
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

// ── Compose ─────────────────────────────────────────────────────────────────────────────

export function computeAssignment(
  entries: LedgerEntry[],
  targets = DEFAULT_REGISTER_TARGETS,
): Assignment {
  return {
    grain: assignGrain(entries),
    paletteAvoid: assignPaletteAvoid(entries),
    register: assignRegister(entries, targets),
  };
}

/** Parse the vehicles-ledger stdin payload into entries, or null when malformed (the
 *  fail-open signal). Accepts the `{ ok, vehicles: [...] }` envelope the CLI emits, and a
 *  bare array as a lenient fallback. */
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

/** The env-line output the conductor appends to /dev/shm/fluncle.env. Single-quoted so a
 *  directive with spaces/slashes sources cleanly (the box does `set -a; . fluncle.env`).
 *  The assigner controls the exact strings, so none contains a single quote. */
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
