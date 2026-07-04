// The STRUCTURAL classifier — the diversity axis the vehicle NAME cannot carry.
//
// The diversity ledger records each finding's self-reported vehicle NAME (a poetic
// identity: "crystal scaffold", "basalt organ", "tidal cell field"). Three of those
// three are the SAME structural primitive — a voronoi/cellular field — yet their
// names read as three different worlds, so a name-only diversity check let three
// cellular findings ship inside six (two consecutive). This module reads the CODE,
// not the label: it classifies a RESOLVED fragment body (every `${GLSL.*}` inlined)
// into a closed set of structural families by the fingerprints the algorithms leave
// in the shader — the min-distance voronoi loop, the ridged `1-abs(2n-1)` inversion,
// the domain-warp advection, the caustic sine accumulator, and so on.
//
// The families are the CHECKED CLAIM (the vehicle name stays free poetic identity):
//   - cellular : voronoi / worley — a nearest-site min-distance loop over hashed
//                cell points, F2−F1 edge/wall math, per-cell ids.
//   - flow     : fbm / domain-warp / curl advection — marbled, never-gridded fields.
//   - caustic  : the rotate+sin/cos sine-accumulator light filaments (Paper caustic /
//                neuroWeb) — interference webs, squared.
//   - filament : ridged noise — the `pow(1-abs(2n-1), k)` inversion that turns a
//                smooth field into sharp crests/threads/veins.
//   - lattice  : a REGULAR grid — `fract`/`mod` tiling, dot screens, halftone.
//   - radial   : polar / angular fields — `polarFold`, `atan`+`length(uv)` kaleido.
//   - metaball : SDF blends / raymarched bodies — `smin`, `raymarch`, `map(vec3)`.
//   - other    : no family cleared the floor.
//
// A body can carry several (a caustic web is often ridged); we report the DOMINANT
// family plus an optional SECONDARY and a 0..1 confidence. Pure + deterministic:
// no fs, no network, no clock. `classifyShaderStructure` takes a resolved body;
// `classifyCompositionStructure` wires the scene resolver (locate the fragment
// literal → inline `${GLSL.*}`) so a caller can hand it a raw composition source.
//
// Heuristics, calibrated against real shipped bodies (see shader-structure.test.ts):
// ALGORITHMIC signatures (the fingerprint the primitive leaves) carry the weight;
// NAMING (variable/function names in code, comments stripped first) only CORROBORATES
// a family that already showed an algorithmic signal, so a stray word never invents a
// phantom family. The one genuinely ambiguous case — a domain-warped field that is
// ALSO ridged — is resolved by dataflow: if the warp field is rendered as a smooth
// surface tone BEYOND the ridge it reads flow-dominant (the ridges are veins on a
// body); if the field feeds ONLY the ridge it reads filament-dominant (threads on a
// void).

import { locateFragmentLiteral, resolveGlslBody } from "./scene";

export const STRUCTURE_FAMILIES = [
  "cellular",
  "flow",
  "caustic",
  "filament",
  "lattice",
  "radial",
  "metaball",
  "other",
] as const;

export type StructureFamily = (typeof STRUCTURE_FAMILIES)[number];

/** A scored family with the human-readable evidence that earned the score. */
export type StructureSignal = {
  family: StructureFamily;
  score: number;
  evidence: string[];
};

export type StructureClassification = {
  /** The highest-scoring family, or `other` when nothing cleared the floor. */
  dominant: StructureFamily;
  /** The runner-up, when it is within range of the dominant (else omitted). */
  secondary?: StructureFamily;
  /** 0..1 — how cleanly the dominant separates from the rest (1 = uncontested). */
  confidence: number;
  /** Every family that scored above zero, dominant-first, with its evidence. */
  signals: StructureSignal[];
};

// A family must clear this to be named at all (below it → `other`).
const FAMILY_FLOOR = 1.5;
// The secondary must reach this fraction of the dominant's score to be reported.
const SECONDARY_RATIO = 0.35;

const GLSL_TYPE_KEYWORDS = new Set([
  "float",
  "vec2",
  "vec3",
  "vec4",
  "int",
  "uint",
  "mat2",
  "mat3",
  "mat4",
  "bool",
  "void",
]);

/** Strip GLSL/JS comments so classification reads CODE only (names, not prose). */
export function stripGlslComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Count CALL sites of `name` — occurrences of `name(` whose preceding token is not a
 * GLSL type keyword (which would make it a function DEFINITION header, e.g.
 * `vec3 voronoi(`). Definitions are inlined into a resolved body, so this keeps the
 * count to actual invocations plus internal recursion, never the declaration.
 */
function callCount(name: string, body: string): number {
  const re = new RegExp(`(\\w+)?\\s*\\b${name}\\s*\\(`, "g");
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = re.exec(body)) !== null) {
    if (!match[1] || !GLSL_TYPE_KEYWORDS.has(match[1])) {
      count += 1;
    }
  }
  return count;
}

function matchCount(re: RegExp, body: string): number {
  return (body.match(re) ?? []).length;
}

/**
 * The ridged-noise inversion `pow(1.0 - abs(2.0 * X - 1.0), k)` (or the bare
 * `1.0 - abs(2.0 * X - 1.0)`) — the filament fingerprint. Returns the field variable
 * `X` it inverts, so the caller can ask whether that field is ALSO rendered as a
 * surface (flow) or only ridged (filament).
 */
function detectRidge(body: string): { present: boolean; field: string | null } {
  const withPow = /pow\s*\(\s*1\.0\s*-\s*abs\s*\(\s*2\.0\s*\*\s*(\w+)/.exec(body);
  if (withPow) {
    return { field: withPow[1], present: true };
  }
  const bare = /1\.0\s*-\s*abs\s*\(\s*2\.0\s*\*\s*(\w+)/.exec(body);
  if (bare) {
    return { field: bare[1], present: true };
  }
  return { field: null, present: false };
}

/**
 * True when the ridge's own field variable is ALSO consumed as a smooth surface tone
 * (a `smoothstep(..., field)` or `paletteRamp(field)`) OUTSIDE the ridge expression —
 * the tell that the warp field is a rendered body and the ridges are veins on it
 * (flow-dominant), not threads on a void (filament-dominant).
 */
function ridgeFieldIsSurface(body: string, field: string | null): boolean {
  if (!field) {
    return false;
  }
  // Remove the ridge statement(s) so the field's OTHER uses are what remain.
  const withoutRidge = body.replace(
    /(?:pow\s*\(\s*)?1\.0\s*-\s*abs\s*\(\s*2\.0\s*\*\s*\w+[^;]*;/g,
    ";",
  );
  const smooth = new RegExp(`smoothstep\\s*\\([^;]*\\b${field}\\b`);
  const ramp = new RegExp(`paletteRamp(?:Ok)?\\s*\\(\\s*${field}\\b`);
  return smooth.test(withoutRidge) || ramp.test(withoutRidge);
}

type Detector = {
  family: Exclude<StructureFamily, "other">;
  score: number;
  evidence: string[];
};

/** Detect every family's raw signal in a comment-stripped body. */
function detectFamilies(body: string): {
  detectors: Detector[];
  ridge: { present: boolean; field: string | null };
  ridgeSurface: boolean;
} {
  const detectors: Detector[] = [];
  const add = (family: Detector["family"], score: number, evidence: string[]) => {
    if (score > 0) {
      detectors.push({ evidence, family, score });
    }
  };

  // ── cellular ────────────────────────────────────────────────────────────
  const voronoiCalls = callCount("voronoi", body) + callCount("voronoi3", body);
  const minDistLoop = /d\s*<\s*f1/.test(body) && /f2\s*=\s*f1/.test(body);
  const edgeMath = /f2\s*-\s*f1|vor\.y\s*-\s*vor\.x|F2\s*-\s*F1/.test(body);
  const worley = /worley/i.test(body);
  const cellularAlgo = voronoiCalls > 0 || minDistLoop || edgeMath || worley;
  {
    let score = 0;
    const evidence: string[] = [];
    if (voronoiCalls > 0) {
      score += 5 * Math.min(voronoiCalls, 2);
      evidence.push(`${voronoiCalls}× voronoi()/voronoi3() call`);
    }
    if (minDistLoop) {
      score += 4;
      evidence.push("nearest-site min-distance loop (d<f1; f2=f1)");
    }
    if (edgeMath) {
      score += 2;
      evidence.push("F2−F1 cell-wall edge math");
    }
    if (worley) {
      score += 2;
      evidence.push("worley naming");
    }
    if (cellularAlgo) {
      const names = Math.min(matchCount(/\bcell(?:s|Id|Hash|Scale)?\b/gi, body), 6);
      if (names > 0) {
        score += 0.3 * names;
        evidence.push(`${names}× cell* naming`);
      }
    }
    add("cellular", score, evidence);
  }

  // ── caustic (sine-accumulator interference webs) ──────────────────────────
  const causticCalls = callCount("caustic", body);
  const neuroCalls = callCount("neuroWeb", body);
  const causticSig = /N\.x\s*\+\s*N\.y/.test(body) || /sine_acc\s*\+=\s*sin/.test(body);
  const causticAlgo = causticCalls > 0 || neuroCalls > 0 || causticSig;
  {
    let score = 0;
    const evidence: string[] = [];
    if (causticCalls > 0) {
      score += 5 * Math.min(causticCalls, 2);
      evidence.push(`${causticCalls}× caustic() call`);
    }
    if (neuroCalls > 0) {
      score += 4 * Math.min(neuroCalls, 2);
      evidence.push(`${neuroCalls}× neuroWeb() call`);
    }
    if (causticSig) {
      score += 2;
      evidence.push("sine-accumulator interference signature");
    }
    if (causticAlgo) {
      const names = Math.min(matchCount(/caustic|neuro/gi, body), 4);
      if (names > 0) {
        score += 0.3 * names;
        evidence.push(`${names}× caustic/neuro naming`);
      }
    }
    add("caustic", score, evidence);
  }

  // ── filament (ridged-noise crests) ───────────────────────────────────────
  const ridge = detectRidge(body);
  const bareAbsInvert = /1\.0\s*-\s*abs\s*\(/.test(body) && !ridge.present;
  const filamentAlgo = ridge.present || bareAbsInvert;
  {
    let score = 0;
    const evidence: string[] = [];
    if (ridge.present) {
      score += 4;
      evidence.push("ridged inversion pow(1−abs(2n−1))");
    } else if (bareAbsInvert) {
      score += 1.5;
      evidence.push("abs()-inversion crease");
    }
    if (filamentAlgo) {
      const names = Math.min(matchCount(/ridge|filament|\bvein|thread|strand|fiber/gi, body), 6);
      if (names > 0) {
        score += 0.3 * names;
        evidence.push(`${names}× ridge/filament/vein naming`);
      }
    }
    add("filament", score, evidence);
  }

  // ── flow (fbm / domain-warp / curl advection) ────────────────────────────
  const flowCalls =
    callCount("domainWarp", body) +
    callCount("swirlWarp", body) +
    callCount("curlNoise", body) +
    callCount("curl3", body);
  const fbmCalls = callCount("fbm", body) + callCount("fbm3", body);
  const flowAlgo = flowCalls > 0 || fbmCalls >= 2;
  const ridgeSurface = ridgeFieldIsSurface(body, ridge.field);
  {
    let score = 0;
    const evidence: string[] = [];
    if (flowCalls > 0) {
      score += 2 * Math.min(flowCalls, 3);
      evidence.push(`${flowCalls}× domainWarp/swirlWarp/curl advection`);
    } else if (fbmCalls >= 2) {
      score += 1;
      evidence.push(`${fbmCalls}× fbm advection`);
    }
    if (flowAlgo) {
      const names = Math.min(
        matchCount(/marbl|liquid|\bflow|advect|\bwarp|smoke|\bfog|nebula/gi, body),
        6,
      );
      if (names > 0) {
        score += 0.3 * names;
        evidence.push(`${names}× flow/marble/warp naming`);
      }
      if (ridge.present && ridgeSurface) {
        score += 2;
        evidence.push("warp field rendered as a surface tone (body), not only ridged");
      }
    }
    add("flow", score, evidence);
  }

  // ── lattice (regular grid / dot screen) ──────────────────────────────────
  const dotCalls = callCount("dotField", body);
  const gridRepeat =
    /\bmod\s*\(/.test(body) &&
    /\bstep\s*\(/.test(body) &&
    !minDistLoop &&
    !ridge.present &&
    causticCalls === 0;
  const latticeAlgo = dotCalls > 0 || gridRepeat;
  {
    let score = 0;
    const evidence: string[] = [];
    if (dotCalls > 0) {
      score += 3 * Math.min(dotCalls, 2);
      evidence.push(`${dotCalls}× dotField() stipple screen`);
    }
    if (gridRepeat) {
      score += 2;
      evidence.push("mod()+step() regular grid repeat");
    }
    if (latticeAlgo) {
      const names = Math.min(matchCount(/lattice|\bgrid|weave|halftone|\bmesh\b/gi, body), 4);
      if (names > 0) {
        score += 0.3 * names;
        evidence.push(`${names}× lattice/grid/weave naming`);
      }
    }
    add("lattice", score, evidence);
  }

  // ── radial (polar / angular fields) ──────────────────────────────────────
  const polarCalls = callCount("polarFold", body);
  const polarMap = /atan\s*\(/.test(body) && /length\s*\(\s*uv/.test(body);
  const radialAlgo = polarCalls > 0 || polarMap;
  {
    let score = 0;
    const evidence: string[] = [];
    if (polarCalls > 0) {
      score += 4;
      evidence.push("polarFold() kaleido wedge");
    }
    if (polarMap) {
      score += 2;
      evidence.push("atan()+length(uv) polar mapping");
    }
    if (radialAlgo) {
      const names = Math.min(
        matchCount(/radial|polar|kaleid|mandala|\biris|concentric/gi, body),
        4,
      );
      if (names > 0) {
        score += 0.3 * names;
        evidence.push(`${names}× radial/polar/kaleido naming`);
      }
    }
    add("radial", score, evidence);
  }

  // ── metaball (SDF blend / raymarched body) ───────────────────────────────
  const sminCalls = callCount("smin", body);
  const raymarchCalls = callCount("raymarch", body);
  const mapDef = /float\s+map\s*\(\s*vec3/.test(body);
  const sdfCalls =
    callCount("sdCircle", body) + callCount("sdSphere3", body) + callCount("sdBox3", body);
  const metaballAlgo = sminCalls > 0 || raymarchCalls > 0 || mapDef || sdfCalls > 0;
  {
    let score = 0;
    const evidence: string[] = [];
    if (sminCalls > 0) {
      score += 3;
      evidence.push("smin() smooth-union blend");
    }
    if (raymarchCalls > 0) {
      score += 3;
      evidence.push("raymarch() sphere-tracer");
    }
    if (mapDef) {
      score += 3;
      evidence.push("map(vec3) SDF scene");
    }
    if (sdfCalls > 0) {
      score += 2 * Math.min(sdfCalls, 2);
      evidence.push(`${sdfCalls}× SDF primitive`);
    }
    if (metaballAlgo) {
      const names = Math.min(matchCount(/metaball|\bsdf\b|raymarch|blob/gi, body), 4);
      if (names > 0) {
        score += 0.3 * names;
        evidence.push(`${names}× sdf/metaball/raymarch naming`);
      }
    }
    add("metaball", score, evidence);
  }

  return { detectors, ridge, ridgeSurface };
}

/**
 * Classify a RESOLVED fragment body (every `${GLSL.*}` already inlined) into its
 * structural families. Pure + deterministic. When nothing clears the floor the
 * dominant is `other` with confidence 0.
 */
export function classifyShaderStructure(resolvedBody: string): StructureClassification {
  const body = stripGlslComments(resolvedBody);
  const { detectors, ridge, ridgeSurface } = detectFamilies(body);

  const scores = new Map<Exclude<StructureFamily, "other">, Detector>();
  for (const d of detectors) {
    scores.set(d.family, d);
  }

  // The one principled tiebreak: a domain-warped field that is ALSO ridged. If the
  // warp field is rendered as a surface tone beyond the ridge, flow leads (veins on a
  // body); if it feeds only the ridge, filament leads (threads on a void). Nudge the
  // loser just under the leader so the ranking reflects the dataflow, not tuning noise.
  const flow = scores.get("flow");
  const filament = scores.get("filament");
  if (ridge.present && flow && filament) {
    if (ridgeSurface && flow.score <= filament.score) {
      flow.score = filament.score + 0.5;
      flow.evidence.push("flow-dominant: field is a rendered surface, ridges are veins on it");
    } else if (!ridgeSurface && filament.score <= flow.score) {
      filament.score = flow.score + 0.5;
      filament.evidence.push("filament-dominant: field feeds only the ridge (threads on a void)");
    }
  }

  const ranked: StructureSignal[] = [...scores.values()]
    .map((d) => ({ evidence: d.evidence, family: d.family as StructureFamily, score: d.score }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  if (!top || top.score < FAMILY_FLOOR) {
    return { confidence: 0, dominant: "other", signals: ranked };
  }

  const second = ranked[1];
  const secondary =
    second && second.score >= SECONDARY_RATIO * top.score ? second.family : undefined;

  // Confidence: how much of the field's mass the dominant owns, floored by its raw
  // strength so an uncontested strong signal reads high and a near-tie reads low.
  const contender = secondary && second ? second.score : 0;
  const separation = top.score / (top.score + contender + 2);
  const confidence = Math.max(0, Math.min(1, separation));

  return {
    confidence: Number(confidence.toFixed(2)),
    dominant: top.family,
    signals: ranked,
    ...(secondary ? { secondary } : {}),
  };
}

/**
 * Resolve a raw composition source (locate its fragment template literal, inline
 * every `${GLSL.*}`) and classify the resolved body. Returns null (never throws)
 * when the body can't be located/resolved, so a caller degrades gracefully. `glsl`
 * is the imported `GLSL` snippet object.
 */
export function classifyCompositionStructure(
  source: string,
  glsl: Record<string, string>,
): StructureClassification | null {
  const located = locateFragmentLiteral(source);
  if (!located.ok) {
    return null;
  }
  const resolved = resolveGlslBody(located.raw, glsl);
  if (!resolved.ok) {
    return null;
  }
  return classifyShaderStructure(resolved.body);
}

/** The render.json `structure` block — dominant + optional secondary + confidence. */
export type StructureManifest = {
  dominant: StructureFamily;
  secondary?: StructureFamily;
  confidence: number;
};

/** Narrow a full classification to the render.json manifest shape. */
export function toStructureManifest(c: StructureClassification): StructureManifest {
  return {
    confidence: c.confidence,
    dominant: c.dominant,
    ...(c.secondary ? { secondary: c.secondary } : {}),
  };
}

/** `vehicle (structure)` — the paired display so a human reads through the poetry. */
export function labelWithStructure(
  vehicle: string | null | undefined,
  structure: StructureFamily | null | undefined,
): string {
  const v = vehicle && vehicle.trim() ? vehicle.trim() : "(no vehicle)";
  return structure ? `${v} (${structure})` : v;
}
