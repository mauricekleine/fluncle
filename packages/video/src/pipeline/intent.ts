// The render-intent spine (RFC: Video Aliveness, §B6 — FROZEN schema v1).
//
// `intent.json` is a RECORD of what the agent already chose for a render — never
// read back as a template by the next run (the package's founding law is
// divergence). The author hand-writes `out/<trackId>.intent.json` at concept
// time; `ship.ts` copies it into the bundle as `intent.json`; the deterministic
// metrics (analyze-motion.ts) and — later — the LLM judge read it to check
// pixels against declared intent.
//
// Load-bearing fields the deterministic checker consumes: `arcSource`,
// `motionModel`, `dropMs`, and `bindings[].{band, axis}` (the translation
// tripwire + the >=1-structural / >=1-light / >=1-texture axis-coverage check).
// The free-text `concept` / `climax.form` / `element` exist only for the judge;
// if the judge is deferred they are inert.

export const RENDER_INTENT_SCHEMA = "fluncle.render-intent/1" as const;

export type IntentTextureFamily =
  | "nebula"
  | "analog"
  | "dither"
  | "paint"
  | "fluent"
  | "duotone"
  | "smear";

export type IntentRegister = "abstract" | "representational";

export type IntentArcSource = "energyCurve" | "scripted";

export type IntentMotionModel = "constant-drift" | "directed-front" | "static-field";

export type IntentBand =
  | "bass"
  | "mid"
  | "treble"
  | "bassFast"
  | "midFast"
  | "trebleFast"
  | "energy"
  | "swell"
  | "drop"
  | "hit"
  | "onset"
  | "flux";

export type IntentAxis =
  // structural
  | "width"
  | "threshold"
  | "warpAmp"
  | "wallSharpness"
  | "density"
  | "radius"
  | "scale"
  | "curvature"
  // light
  | "brightness"
  | "exposure"
  | "glow"
  | "ignition"
  // texture
  | "grain"
  | "chroma"
  | "dither"
  | "edgeRough"
  // motion — MUST pair with a smoothed band (the checker's tripwire)
  | "translation";

export type IntentBinding = {
  band: IntentBand;
  element: string;
  axis: IntentAxis;
  intendedStrength: "subtle" | "strong";
};

export type RenderIntent = {
  schema: typeof RENDER_INTENT_SCHEMA;
  trackId: string;
  logId: string | null;
  /** == the --vehicle ledger tag (ship.ts sources both from one value). */
  vehicle: string;
  textureFamily: IntentTextureFamily;
  register: IntentRegister;
  /** e.g. "a murmuration" — lets the judge check the claim vs pixels. */
  representationalSubject?: string;
  /** free text (the judge reads this). */
  concept: string;
  arcSource: IntentArcSource;
  motionModel: IntentMotionModel;
  dropMs: number;
  climax: { form: string; colour: string; atMs: number };
  bindings: IntentBinding[];
  /** optional, future (judge fuel). */
  secondaryPeaks?: number[];
};

// Axis groups — one source of truth for the type, the validator, and the
// checker's >=1-each coverage rule (doctrine 9: structural + light + texture).
export const STRUCTURAL_AXES: readonly IntentAxis[] = [
  "width",
  "threshold",
  "warpAmp",
  "wallSharpness",
  "density",
  "radius",
  "scale",
  "curvature",
];
export const LIGHT_AXES: readonly IntentAxis[] = ["brightness", "exposure", "glow", "ignition"];
export const TEXTURE_AXES: readonly IntentAxis[] = ["grain", "chroma", "dither", "edgeRough"];
export const MOTION_AXES: readonly IntentAxis[] = ["translation"];

const ALL_AXES: readonly IntentAxis[] = [
  ...STRUCTURAL_AXES,
  ...LIGHT_AXES,
  ...TEXTURE_AXES,
  ...MOTION_AXES,
];

const ALL_BANDS: readonly IntentBand[] = [
  "bass",
  "mid",
  "treble",
  "bassFast",
  "midFast",
  "trebleFast",
  "energy",
  "swell",
  "drop",
  "hit",
  "onset",
  "flux",
];

// A fast band on `axis: "translation"` is a self-reported beat-pull. The
// smoothed bands are the only legitimate translation drivers.
export const SMOOTHED_BANDS: readonly IntentBand[] = ["energy", "swell", "drop"];

export function axisGroup(axis: IntentAxis): "structural" | "light" | "texture" | "motion" {
  if (STRUCTURAL_AXES.includes(axis)) {
    return "structural";
  }
  if (LIGHT_AXES.includes(axis)) {
    return "light";
  }
  if (TEXTURE_AXES.includes(axis)) {
    return "texture";
  }
  return "motion";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBinding(value: unknown): value is IntentBinding {
  if (!isRecord(value)) {
    return false;
  }
  const band = value.band;
  const axis = value.axis;
  const strength = value.intendedStrength;
  return (
    typeof value.element === "string" &&
    typeof band === "string" &&
    ALL_BANDS.includes(band as IntentBand) &&
    typeof axis === "string" &&
    ALL_AXES.includes(axis as IntentAxis) &&
    (strength === "subtle" || strength === "strong")
  );
}

/**
 * Defensive parse of an unknown (parsed JSON) into a RenderIntent. Returns null
 * on anything malformed so callers can treat a missing/invalid intent as a
 * warning (v1 is warn-and-stub, never a ship blocker — see ship.ts).
 */
export function validateRenderIntent(raw: unknown): RenderIntent | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (raw.schema !== RENDER_INTENT_SCHEMA) {
    return null;
  }
  const climax = raw.climax;
  if (!isRecord(climax)) {
    return null;
  }
  if (
    typeof raw.trackId !== "string" ||
    !(typeof raw.logId === "string" || raw.logId === null) ||
    typeof raw.vehicle !== "string" ||
    typeof raw.concept !== "string" ||
    typeof raw.dropMs !== "number" ||
    typeof climax.form !== "string" ||
    typeof climax.colour !== "string" ||
    typeof climax.atMs !== "number" ||
    !Array.isArray(raw.bindings) ||
    !raw.bindings.every(isBinding)
  ) {
    return null;
  }
  return raw as RenderIntent;
}

/**
 * A minimal, valid stub. `ship.ts` writes this when the author did not author an
 * intent.json (v1 warn-and-stub) so the bundle always carries one and the
 * checker/judge never hit a missing-file path.
 */
export function generateIntentStub(trackId: string, logId: string | null): RenderIntent {
  return {
    arcSource: "energyCurve",
    bindings: [],
    climax: { atMs: 0, colour: "(unknown)", form: "(unknown)" },
    concept: "(generated stub — the author did not declare an intent for this render)",
    dropMs: 0,
    logId,
    motionModel: "constant-drift",
    register: "abstract",
    schema: RENDER_INTENT_SCHEMA,
    secondaryPeaks: [],
    textureFamily: "nebula",
    trackId,
    vehicle: "unknown",
  };
}
