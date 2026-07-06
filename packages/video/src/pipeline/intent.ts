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

// The diversity register — how the vehicle reads. "framed" is the doctrine addition:
// a composed, bordered/matted read (vs a full-bleed abstract field or a
// representational subject). Kept a REQUIRED field (it predates this and every
// existing intent supplies one); the doctrine change is the third value.
export type IntentRegister = "abstract" | "representational" | "framed";

export type IntentArcSource = "energyCurve" | "scripted";

export type IntentMotionModel = "constant-drift" | "directed-front" | "static-field";

// ── The PRESENCE fields (OPTIONAL, backward compatible) ──────────────────────
// The presence direction puts a nameable SUBJECT in the frame (a colossus, a ruin,
// a passing hull) that the music does NOT touch — the world answers the music, the
// thing keeps its own clock. These optional fields let the intent DECLARE the
// subject so the judge (and the diversity ledger) can check the claim. None of them
// is load-bearing for the deterministic metrics today; validate-intent lints their
// cross-field consistency (see validate-intent.ts).

/** What the subject IS — a nameable, placed thing. "none" = an abstract field (no subject). */
export type IntentSubjectClass =
  | "colossus"
  | "ruin"
  | "vessel"
  | "flora"
  | "creature"
  | "terrain"
  | "figure"
  | "threshold"
  | "none";

/** Where the observer stands relative to the subject — the spatial relation. */
export type IntentViewpoint =
  | "approach"
  | "passage"
  | "overlook"
  | "beneath"
  | "threshold"
  | "adrift";

/** How much of the subject is shown, and when. "felt-from-frame-one" = present as a
 *  silhouette/mass from frame one; "resolved-at-drop" = the drop resolves it (occlusion,
 *  never absence — requires a drop binding); "full" = disclosed throughout. */
export type IntentDisclosure = "felt-from-frame-one" | "resolved-at-drop" | "full";

/** The subject's own clock. "constant" = audio-free drift/transit (indifference);
 *  "biological" = an in-place breath at its own rate (never on the beat). */
export type IntentSubjectClock = "constant" | "biological";

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
  /**
   * Doctrine additions (OPTIONAL, backward compatible — schema string unchanged).
   * They give the judge + the diversity metric fuel without breaking old intents.
   */
  /** The declared DEPTH MECHANISM — how the scene earns its third dimension (e.g.
   *  "parallax layers", "atmospheric haze", "occlusion", "focal blur"). Free text. */
  depthMechanism?: string;
  /** The FOCAL POINT — where the eye is meant to land (e.g. "centre bloom",
   *  "lower-third horizon", "the drifting mote"). Free text. */
  focalPoint?: string;
  /** PRESENCE (all optional). The nameable subject's class; its default "none" means
   *  an abstract field. A subject present (≠ "none") makes the intent a presence render:
   *  the environment must own the audio (no translation binding — validate-intent lints it). */
  subjectClass?: IntentSubjectClass;
  /** PRESENCE. The observer's spatial relation to the subject. */
  viewpoint?: IntentViewpoint;
  /** PRESENCE. How/when the subject is shown. "resolved-at-drop" requires a drop binding. */
  disclosure?: IntentDisclosure;
  /** PRESENCE. The subject's own audio-free clock (indifference). Declaring it marks a subject present. */
  subjectClock?: IntentSubjectClock;
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

export const ALL_AXES: readonly IntentAxis[] = [
  ...STRUCTURAL_AXES,
  ...LIGHT_AXES,
  ...TEXTURE_AXES,
  ...MOTION_AXES,
];

export const ALL_BANDS: readonly IntentBand[] = [
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

// Closed value sets for the remaining enum fields — the source of truth the strict
// validator (validate-intent.ts) checks against.
export const REGISTERS: readonly IntentRegister[] = ["abstract", "representational", "framed"];
export const ARC_SOURCES: readonly IntentArcSource[] = ["energyCurve", "scripted"];
export const MOTION_MODELS: readonly IntentMotionModel[] = [
  "constant-drift",
  "directed-front",
  "static-field",
];
export const TEXTURE_FAMILIES: readonly IntentTextureFamily[] = [
  "nebula",
  "analog",
  "dither",
  "paint",
  "fluent",
  "duotone",
  "smear",
];

// The presence value sets — the closed enums the strict validator checks against.
export const SUBJECT_CLASSES: readonly IntentSubjectClass[] = [
  "colossus",
  "ruin",
  "vessel",
  "flora",
  "creature",
  "terrain",
  "figure",
  "threshold",
  "none",
];
export const VIEWPOINTS: readonly IntentViewpoint[] = [
  "approach",
  "passage",
  "overlook",
  "beneath",
  "threshold",
  "adrift",
];
export const DISCLOSURES: readonly IntentDisclosure[] = [
  "felt-from-frame-one",
  "resolved-at-drop",
  "full",
];
export const SUBJECT_CLOCKS: readonly IntentSubjectClock[] = ["constant", "biological"];

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
    // The generated stub is an abstract field: no subject. Declaring it explicitly
    // keeps the presence fields exercised and the honest "no subject" state legible.
    subjectClass: "none",
    textureFamily: "nebula",
    trackId,
    vehicle: "unknown",
  };
}
