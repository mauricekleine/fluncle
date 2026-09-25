export const RENDER_INTENT_SCHEMA = "fluncle.render-intent/1" as const;

export type IntentTextureFamily =
  | "nebula"
  | "analog"
  | "dither"
  | "paint"
  | "fluent"
  | "duotone"
  | "smear";

export type IntentRegister = "abstract" | "representational" | "framed";

export type IntentArcSource = "energyCurve" | "scripted";

export type IntentMotionModel = "constant-drift" | "directed-front" | "static-field";

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

export type IntentViewpoint =
  | "approach"
  | "passage"
  | "overlook"
  | "beneath"
  | "threshold"
  | "adrift";

export type IntentDisclosure = "felt-from-frame-one" | "resolved-at-drop" | "full";

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
  | "width"
  | "threshold"
  | "warpAmp"
  | "wallSharpness"
  | "density"
  | "radius"
  | "scale"
  | "curvature"
  | "brightness"
  | "exposure"
  | "glow"
  | "ignition"
  | "grain"
  | "chroma"
  | "dither"
  | "edgeRough"
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

  vehicle: string;
  textureFamily: IntentTextureFamily;
  register: IntentRegister;

  representationalSubject?: string;

  concept: string;
  arcSource: IntentArcSource;
  motionModel: IntentMotionModel;
  dropMs: number;
  climax: { form: string; colour: string; atMs: number };
  bindings: IntentBinding[];

  secondaryPeaks?: number[];

  depthMechanism?: string;

  focalPoint?: string;

  subjectClass?: IntentSubjectClass;

  viewpoint?: IntentViewpoint;

  disclosure?: IntentDisclosure;

  subjectClock?: IntentSubjectClock;
};

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

export const SMOOTHED_BANDS: readonly IntentBand[] = ["energy", "swell", "drop"];

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

export function generateIntentStub(trackId: string, logId: string | null): RenderIntent {
  return {
    arcSource: "energyCurve",
    bindings: [],
    climax: { atMs: 0, colour: "(unknown)", form: "(unknown)" },
    concept: "(generated stub — the author did not declare an intent for this render)",
    dropMs: 0,
    logId,
    motionModel: "constant-drift",

    register: "representational",
    schema: RENDER_INTENT_SCHEMA,
    secondaryPeaks: [],

    subjectClass: "none",
    textureFamily: "nebula",
    trackId,
    vehicle: "unknown",
  };
}
