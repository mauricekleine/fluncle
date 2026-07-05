// The scene contract (`fluncle.scene/1`) — the replay manifest for a finding's
// shader body (RFC: Live + Longform, Unit S). Sibling of intent.ts: intent.json
// is the DESCRIPTIVE record the judge reads; scene.json is the EXECUTABLE record a
// host (offline `SceneHost`, live `LiveSceneHost`) re-runs. The offline pipeline
// authors + certifies; the runtime replays, never authors.
//
// The manifest carries a fully RESOLVED fragment body (every `${GLSL.*}` dependency
// inlined by the emitter), the four palette stops, the grain floor, and the
// optional bloom/reactivity post-config — everything a host needs to reproduce the
// world with NO composition module in reach. `cleared` folds the ship-time gate
// verdicts (the QA stamp — "cleared", never "certified", which is Fluncle's
// protected verb). `liveReady` records whether the body reads HEADER UNIFORMS ONLY
// (the scripted-clock law made mechanical): a body with custom clip-time uniforms
// still ships everything else, but a live host cannot drive those uniforms, so it
// is marked not-live-ready with the reason.
//
// This module owns the schema + the pure emitter helpers (module-evaluating the
// composition source against the imported `GLSL` object, the `${GLSL.*}`-only
// interpolation guard, the custom-uniform static scan, the cleared/bloom/reactivity
// folds). ship.ts wires them; validate-scene.ts is the strict authoring-time CLI.

import { luminance } from "../remotion/color";

export const SCENE_SCHEMA = "fluncle.scene/1" as const;

// Pins the CORE_UNIFORMS contract the resolved body was authored against. A host
// that injects a different header version must refuse the body rather than guess.
export const SCENE_HEADER_VERSION = "cosmos.header/1" as const;

// The metrics contract the `cleared` block conforms to — the fallback when the
// gate report (out/<trackId>.metrics.json) carries no explicit `metricsVersion`.
export const SCENE_METRICS_VERSION = "cosmos.metrics/1" as const;

// The authoritative CORE_UNIFORMS name set — MUST mirror the `CORE_UNIFORMS` block
// in remotion/journey/shader-layer.tsx (pinned by SCENE_HEADER_VERSION). A
// live-ready body reads ONLY these names (plus its own declared textures). The
// emitter's live-ready scan flags any OTHER `uniform` declaration in the body. Keep
// this list in lockstep with the header; SceneHost injects via the same ShaderLayer,
// so a drift shows up as a compile error, not silent divergence.
export const CORE_UNIFORM_NAMES: readonly string[] = [
  "u_time",
  "u_res",
  "u_progress",
  "u_energy",
  "u_bass",
  "u_mid",
  "u_treble",
  "u_beatPulse",
  "u_onsetPulse",
  "u_audioHit",
  "u_audioSwell",
  "u_audioDrop",
  "u_audioDisturbance",
  "u_energyFast",
  "u_bassFast",
  "u_midFast",
  "u_trebleFast",
  "u_flux",
  "u_sub",
  "u_kickHit",
  "u_snareHit",
  "u_air",
  "u_downbeatPulse",
  "u_seed",
  "u_palette",
];

// The Warm Dark ceiling (DESIGN.md "The Warm Dark Rule"): a scene GROUND
// (palette[0]) must sit near-black. Read with the package's perceptual `luminance`
// (0.299/0.587/0.114). Canon grounds clear it comfortably — deepField #090a0b ≈
// 0.04, tapeBlack #171611 ≈ 0.09 — while any mid-tone (a rose #cc5374 ≈ 0.48) or
// cream (#f4ead7 ≈ 0.91) trips it. The one load-time lint the taste pass kept.
export const WARM_DARK_CEILING = 0.14;

export type SceneKind = "finding" | "default" | "holding";

/**
 * Where a host resolves a declared texture sampler from. All three are
 * host-resolvable without the composition module in reach:
 *   - `artwork`          — the matched finding's cover (CORS-clear).
 *   - `plate`            — the bundle's plate-lane photographic plate, the durable
 *                          `<log-id>/plate.png` R2 key (found.fluncle.com).
 *   - `plate-background` — the plate's subject-removed background for true
 *                          parallax, `<log-id>/plate.background.png`.
 */
export type SceneTextureSource = "artwork" | "plate" | "plate-background";

export const SCENE_TEXTURE_SOURCES: readonly SceneTextureSource[] = [
  "artwork",
  "plate",
  "plate-background",
];

export type SceneTexture = {
  name: string;
  source: SceneTextureSource;
};

/**
 * The sampler-name convention that lets the emitter resolve a texture's SOURCE
 * statically (the textures prop's values are runtime expressions, so the NAME is
 * the contract): a plate-lane composition samples its plate as `u_plate` and the
 * subject-removed background as `u_plateBackground` — those names map to the
 * bundle's own `plate.png` / `plate.background.png`; any other sampler name reads
 * as the finding's artwork.
 */
export function textureSourceForName(name: string): SceneTextureSource {
  if (name === "u_plate") {
    return "plate";
  }
  if (name === "u_plateBackground") {
    return "plate-background";
  }
  return "artwork";
}

export type SceneGlsl = {
  /** The fully RESOLVED fragment body (`${GLSL.*}` deps inlined; no interpolations left). */
  body: string;
  /** Pins the CORE_UNIFORMS contract — SCENE_HEADER_VERSION. */
  headerVersion: string;
  /** WebGL2 / GLSL ES 3.00 body (writes `out vec4 fragColor`). */
  glsl3: boolean;
  /** Declared texture samplers, present only when the body samples artwork. */
  textures?: SceneTexture[];
};

export type ScenePalette = [string, string, string, string];

export type SceneGrain = {
  /** The grain-family id (e.g. `grainChemicalDye`), or `unknown` when unstated. */
  family: string;
  /** The grain floor amount the host applies at minimum. */
  amount: number;
};

export type SceneBloom = {
  threshold: number;
  intensity: number;
  radius: number;
};

export type SceneReactivity = {
  /** The drop envelope SHAPE. `peakTimeMs` is deliberately absent — live detects the
   *  peak; offline injects it per render. */
  drop: { riseMs: number; holdMs: number; fallMs: number };
  swellBeatWeight: number;
};

/** A folded gate verdict: pass/fail from the hard gates, inconclusive/unknown otherwise. */
export type SceneClearedVerdict = "pass" | "fail" | "inconclusive" | "unknown";

export type SceneCleared = {
  beatPull: SceneClearedVerdict;
  flash: SceneClearedVerdict;
  arc: SceneClearedVerdict;
  metricsVersion: string;
  /** ISO-8601 stamp of when the gate report was folded (ship time). */
  at: string;
};

export type Scene = {
  schema: typeof SCENE_SCHEMA;
  /** logId for findings; member id for defaults/holding. */
  id: string;
  kind: SceneKind;
  glsl: SceneGlsl;
  palette: ScenePalette;
  grain: SceneGrain;
  bloom?: SceneBloom;
  reactivity?: SceneReactivity;
  cleared: SceneCleared;
  /** The body reads HEADER UNIFORMS ONLY (a live host can drive it exactly). */
  liveReady: boolean;
  /** Why a scene is not live-ready (custom clip-time uniforms). Empty when ready. */
  liveReadyReasons: string[];
};

// The public read base for stored bundle artifacts (found.fluncle.com serves the
// R2 bundle keyed by log-id) — where a host resolves the plate-lane textures from.
const FOUND_BASE = "https://found.fluncle.com";

export type SceneTextureUrls = {
  /** The matched finding's artwork (binds every `source: "artwork"` sampler). */
  artworkUrl?: string;
  /** Override for `source: "plate"`; defaults to the finding bundle's plate.png. */
  plateUrl?: string;
  /** Override for `source: "plate-background"`; defaults to plate.background.png. */
  plateBackgroundUrl?: string;
};

/**
 * Resolve a scene's declared texture samplers to concrete URLs for a host —
 * the pure half of SceneHost's `textures` prop. Per-source: `artwork` binds the
 * caller's artworkUrl; `plate` / `plate-background` bind the caller's override or,
 * for a finding, the bundle's own durable R2 key (the same URL the composition
 * rendered from — the upload-first order guarantees it exists before any render).
 * Entries with no resolvable URL are omitted (never a throw); undefined when
 * nothing resolves, so a texture-less ShaderLayer path stays untouched.
 */
export function resolveSceneTextures(
  scene: Pick<Scene, "glsl" | "id" | "kind">,
  urls: SceneTextureUrls,
): Record<string, string> | undefined {
  const declared = scene.glsl.textures;
  if (!declared || declared.length === 0) {
    return undefined;
  }
  const bundleBase = scene.kind === "finding" ? `${FOUND_BASE}/${scene.id}` : undefined;
  const resolved: Record<string, string> = {};
  for (const texture of declared) {
    const url =
      texture.source === "plate"
        ? (urls.plateUrl ?? (bundleBase ? `${bundleBase}/plate.png` : undefined))
        : texture.source === "plate-background"
          ? (urls.plateBackgroundUrl ??
            (bundleBase ? `${bundleBase}/plate.background.png` : undefined))
          : urls.artworkUrl;
    if (url) {
      resolved[texture.name] = url;
    }
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHexTriquad(value: unknown): value is ScenePalette {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((v) => typeof v === "string" && v.length > 0)
  );
}

/**
 * Defensive parse of an unknown (parsed JSON) into a Scene. Returns null on
 * anything malformed so a host can treat a bad/missing scene as a degrade (fall
 * back to the tag-mapped default), never a crash — the counterpart to
 * validateSceneStrict (which says WHY). Mirrors intent.ts's validateRenderIntent.
 */
export function validateScene(raw: unknown): Scene | null {
  if (!isRecord(raw) || raw.schema !== SCENE_SCHEMA) {
    return null;
  }
  const glsl = raw.glsl;
  const grain = raw.grain;
  const cleared = raw.cleared;
  if (!isRecord(glsl) || !isRecord(grain) || !isRecord(cleared)) {
    return null;
  }
  if (
    typeof raw.id !== "string" ||
    (raw.kind !== "finding" && raw.kind !== "default" && raw.kind !== "holding") ||
    typeof glsl.body !== "string" ||
    typeof glsl.headerVersion !== "string" ||
    typeof glsl.glsl3 !== "boolean" ||
    !isHexTriquad(raw.palette) ||
    typeof grain.family !== "string" ||
    typeof grain.amount !== "number" ||
    typeof cleared.metricsVersion !== "string" ||
    typeof cleared.at !== "string" ||
    typeof raw.liveReady !== "boolean" ||
    !Array.isArray(raw.liveReadyReasons)
  ) {
    return null;
  }
  return raw as Scene;
}

/**
 * The ONE load-time lint (RFC: "palette[0] under the warm-dark ceiling"). Returns a
 * list of warnings — empty when the ground is dark enough. A host runs this on load
 * and warns; it is not a hard reject (a scene that already cleared the ship gates
 * ships). Kept a warning by design so a borderline artwork ground is legible, not
 * silently swapped.
 */
export function lintScenePalette(scene: Pick<Scene, "palette">): string[] {
  const warnings: string[] = [];
  const ground = scene.palette[0];
  const l = luminance(ground);
  if (l > WARM_DARK_CEILING) {
    warnings.push(
      `palette[0] ${ground} has luminance ${l.toFixed(3)} > the Warm Dark ceiling ${WARM_DARK_CEILING} — a scene ground must sit near-black (The Warm Dark Rule).`,
    );
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// The emitter — module evaluation, not text extraction (RFC Unit S, D2).
//
// The body is resolved by locating the composition's fragment template literal and
// substituting each `${GLSL.member}` with the corresponding string on the IMPORTED
// `GLSL` object (evaluation, not a regex slice of the snippet library). Any
// interpolation that is not a bare `GLSL` member is REFUSED with a clear error: it
// cannot be resolved from the GLSL object, so there is no valid body to ship. Ship
// degrades gracefully on a refusal (warns, emits no scene.json) — it NEVER fails.
// ---------------------------------------------------------------------------

export type ResolveGlslResult = { ok: true; body: string } | { ok: false; error: string };

/** Every `${GLSL.member}` interpolation must be a bare member of this shape. */
const GLSL_MEMBER_RE = /^GLSL\.([A-Za-z_$][A-Za-z0-9_$]*)$/;
const INTERPOLATION_RE = /\$\{([^}]*)\}/g;

/**
 * Locate the fragment template literal in a composition's source text: the
 * backtick-delimited literal that contains `void main(`. Composition GLSL bodies
 * never contain a backtick (the memory rule: a backtick in a GLSL comment closes
 * the literal), so backticks strictly alternate open/close and the pairing is
 * unambiguous. Returns the RAW inner text (interpolations intact) or an error.
 */
export function locateFragmentLiteral(
  source: string,
): { ok: true; raw: string } | { ok: false; error: string } {
  const ticks: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "`" && source[i - 1] !== "\\") {
      ticks.push(i);
    }
  }
  for (let i = 0; i + 1 < ticks.length; i += 2) {
    const inner = source.slice(ticks[i] + 1, ticks[i + 1]);
    if (inner.includes("void main(")) {
      return { ok: true, raw: inner };
    }
  }
  return {
    error: "no fragment template literal found (no backtick-delimited body contains `void main(`)",
    ok: false,
  };
}

/**
 * Resolve a raw fragment literal into a complete GLSL body by substituting each
 * `${GLSL.member}` from the imported `GLSL` object. Refuses (ok:false) any
 * interpolation that is not a bare `GLSL` member, or a member absent from the
 * object — there is nothing valid to emit, so the scene is not shipped.
 */
export function resolveGlslBody(raw: string, glsl: Record<string, string>): ResolveGlslResult {
  const bad: string[] = [];
  const body = raw.replace(INTERPOLATION_RE, (match, exprRaw: string) => {
    const expr = exprRaw.trim();
    const m = GLSL_MEMBER_RE.exec(expr);
    if (!m) {
      bad.push(`\${${expr}} is not a bare GLSL member`);
      return match;
    }
    const member = m[1];
    const snippet = glsl[member];
    if (typeof snippet !== "string") {
      bad.push(`\${GLSL.${member}} is not a member of the GLSL object`);
      return match;
    }
    return snippet;
  });
  if (bad.length > 0) {
    return {
      error: `unresolvable interpolation(s): ${bad.join("; ")} — only bare \${GLSL.*} refs are allowed`,
      ok: false,
    };
  }
  return { body, ok: true };
}

const UNIFORM_DECL_RE = /\buniform\s+\w+\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*;/g;

/**
 * The live-ready static scan: every `uniform` DECLARED in the body (the header
 * uniforms are injected separately, so a body only declares its OWN customs).
 * Returns the names beyond CORE_UNIFORM_NAMES and the declared textures — a
 * non-empty list means the body is driven by clip-time JS and cannot replay live.
 */
export function scanCustomUniforms(body: string, textureNames: string[] = []): string[] {
  const allowed = new Set<string>(CORE_UNIFORM_NAMES);
  for (const name of textureNames) {
    allowed.add(name);
    allowed.add(`${name}AspectRatio`);
  }
  const custom: string[] = [];
  UNIFORM_DECL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = UNIFORM_DECL_RE.exec(body)) !== null) {
    const name = match[1];
    if (!allowed.has(name) && !custom.includes(name)) {
      custom.push(name);
    }
  }
  return custom;
}

/**
 * Slice a balanced `{...}` region starting at (or after) `from`. Returns the
 * substring INCLUDING the outer braces, or null when unbalanced. Used to read a
 * JSX prop's object-literal value (`bloom={{ … }}`) out of the source.
 */
function sliceBalancedBraces(text: string, from: number): string | null {
  const start = text.indexOf("{", from);
  if (start < 0) {
    return null;
  }
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") {
      depth += 1;
    } else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Parse `key: <number>` literal pairs from a snippet (non-literal values are skipped). */
function numericFields(snippet: string): Record<string, number> {
  const out: Record<string, number> = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) {
    out[m[1]] = Number(m[2]);
  }
  return out;
}

/** True when the composition opts the ShaderLayer into WebGL2 / GLSL3. */
export function detectGlsl3(source: string): boolean {
  return /\bglsl3(?:\s*=\s*\{\s*true\s*\}|[\s/>])/.test(source);
}

/**
 * The texture sampler names the ShaderLayer is given (`textures={{ name: … }}`).
 * Each name resolves to its SOURCE via the sampler-name convention
 * (`textureSourceForName`): `u_plate` / `u_plateBackground` are the plate-lane
 * bundle files; every other name is the finding's artwork.
 */
export function extractTextureNames(source: string): string[] {
  const idx = source.indexOf("textures=");
  if (idx < 0) {
    return [];
  }
  const block = sliceBalancedBraces(source, idx);
  if (!block) {
    return [];
  }
  // The value is `{{ name: expr, … }}`; read the inner object's keys.
  const inner = sliceBalancedBraces(block, 1);
  if (!inner) {
    return [];
  }
  const names: string[] = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner.slice(1, -1))) !== null) {
    names.push(m[1]);
  }
  return names;
}

/** Read the ShaderLayer `bloom={{ … }}` config, if present (best-effort, literals only). */
export function extractBloom(source: string): SceneBloom | undefined {
  const idx = source.indexOf("bloom=");
  if (idx < 0) {
    return undefined;
  }
  const block = sliceBalancedBraces(source, idx);
  if (!block) {
    return undefined;
  }
  const fields = numericFields(block);
  if (
    fields.threshold === undefined &&
    fields.intensity === undefined &&
    fields.radius === undefined
  ) {
    return undefined;
  }
  // ShaderLayer's own defaults (BloomOptions) fill any omitted knob.
  return {
    intensity: fields.intensity ?? 0.8,
    radius: fields.radius ?? 1,
    threshold: fields.threshold ?? 0.7,
  };
}

/**
 * Read the ShaderLayer `reactivity={{ drop: { … } }}` envelope, if present. Keeps
 * only the SHAPE (riseMs/holdMs/fallMs) + swellBeatWeight; peakTimeMs/floor are
 * deliberately dropped (the live host detects the peak, the offline host injects
 * it per render — RFC).
 */
export function extractReactivity(source: string): SceneReactivity | undefined {
  const idx = source.indexOf("reactivity=");
  if (idx < 0) {
    return undefined;
  }
  const block = sliceBalancedBraces(source, idx);
  if (!block) {
    return undefined;
  }
  const dropIdx = block.indexOf("drop");
  if (dropIdx < 0) {
    return undefined;
  }
  const dropBlock = sliceBalancedBraces(block, dropIdx);
  if (!dropBlock) {
    return undefined;
  }
  const drop = numericFields(dropBlock);
  if (drop.riseMs === undefined && drop.holdMs === undefined && drop.fallMs === undefined) {
    return undefined;
  }
  const top = numericFields(block.replace(dropBlock, ""));
  return {
    drop: {
      fallMs: drop.fallMs ?? 0,
      holdMs: drop.holdMs ?? 0,
      riseMs: drop.riseMs ?? 0,
    },
    swellBeatWeight: top.swellBeatWeight ?? 0,
  };
}

/** Extract the grain floor amount the body applies (the leading literal on `.amount =`). */
export function extractGrainAmount(source: string): number | undefined {
  const m = /\.amount\s*=\s*(-?\d+(?:\.\d+)?)/.exec(source);
  return m ? Number(m[1]) : undefined;
}

/**
 * Fold the ship-time gate report (parsed out/<trackId>.metrics.json) into the
 * `cleared` stamp. Maps the two HARD gates (flash, beat-pull) + the arc gate to
 * pass/fail/inconclusive; anything missing reads `unknown` (the report is
 * optional — ship never fails because a gate report was absent).
 */
export function foldCleared(report: unknown, at: string): SceneCleared {
  const r = isRecord(report) ? report : {};
  const beatPull = isRecord(r.beatPull) ? r.beatPull : {};
  const flash = isRecord(r.flashSafety) ? r.flashSafety : {};
  const arc = isRecord(r.arc) ? r.arc : {};

  const beatVerdict: SceneClearedVerdict =
    typeof beatPull.beatLocked === "boolean" ? (beatPull.beatLocked ? "fail" : "pass") : "unknown";
  const flashVerdict: SceneClearedVerdict =
    flash.verdict === "safe" ? "pass" : flash.verdict === "unsafe" ? "fail" : "unknown";
  const arcVerdict: SceneClearedVerdict =
    arc.verdict === "evolving"
      ? "pass"
      : arc.verdict === "dead"
        ? "fail"
        : arc.verdict === "inconclusive"
          ? "inconclusive"
          : "unknown";

  const metricsVersion =
    typeof r.metricsVersion === "string" ? r.metricsVersion : SCENE_METRICS_VERSION;

  return { arc: arcVerdict, at, beatPull: beatVerdict, flash: flashVerdict, metricsVersion };
}

export type BuildSceneInput = {
  id: string;
  kind: SceneKind;
  /** The composition source text (composition.tsx) to emit from. */
  source: string;
  /** The imported GLSL snippet object (`GLSL` from remotion/journey/glsl). */
  glsl: Record<string, string>;
  /** The finding's four palette stops (props.json CosmosPalette, dark→light). */
  palette: ScenePalette;
  /** The grain family id (ship's --grain / render manifest), or null. */
  grainFamily: string | null;
  /** The parsed gate report (out/<trackId>.metrics.json), or null when absent. */
  metricsReport: unknown;
  /** ISO stamp folded into `cleared.at`. */
  at: string;
};

export type BuildSceneResult = {
  /** The scene, or null when the body could not be resolved (ship degrades + warns). */
  scene: Scene | null;
  /** Non-fatal diagnostics — always surfaced so a skipped scene is never silent. */
  warnings: string[];
};

/**
 * Assemble a scene.json from a composition's source + the GLSL object + the gate
 * report. Returns scene:null (with a warning) only when the body is unresolvable —
 * every other gap (missing bloom/reactivity/grain/report) degrades to a sane
 * default so a partial scene still ships. Pure + deterministic (given `at`).
 */
export function buildScene(input: BuildSceneInput): BuildSceneResult {
  const warnings: string[] = [];

  const located = locateFragmentLiteral(input.source);
  if (!located.ok) {
    return { scene: null, warnings: [`scene emission skipped: ${located.error}`] };
  }
  const resolved = resolveGlslBody(located.raw, input.glsl);
  if (!resolved.ok) {
    return {
      scene: null,
      warnings: [`scene emission skipped (not live-ready): ${resolved.error}`],
    };
  }

  const glsl3 = detectGlsl3(input.source);
  const textureNames = extractTextureNames(input.source);
  const customUniforms = scanCustomUniforms(resolved.body, textureNames);

  const liveReadyReasons: string[] = [];
  if (customUniforms.length > 0) {
    liveReadyReasons.push(
      `body declares custom uniform(s) beyond the header: ${customUniforms.join(", ")} — a live host cannot drive clip-time JS uniforms`,
    );
  }

  const bloom = extractBloom(input.source);
  const reactivity = extractReactivity(input.source);
  const grainAmount = extractGrainAmount(input.source);
  if (grainAmount === undefined) {
    warnings.push("grain amount not found in source — defaulting to 0.05");
  }
  if (!input.grainFamily) {
    warnings.push("grain family unset — recording `unknown`");
  }

  const glsl: SceneGlsl = {
    body: resolved.body,
    glsl3,
    headerVersion: SCENE_HEADER_VERSION,
    ...(textureNames.length > 0
      ? { textures: textureNames.map((name) => ({ name, source: textureSourceForName(name) })) }
      : {}),
  };

  const scene: Scene = {
    cleared: foldCleared(input.metricsReport, input.at),
    glsl,
    grain: { amount: grainAmount ?? 0.05, family: input.grainFamily ?? "unknown" },
    id: input.id,
    kind: input.kind,
    liveReady: liveReadyReasons.length === 0,
    liveReadyReasons,
    palette: input.palette,
    schema: SCENE_SCHEMA,
    ...(bloom ? { bloom } : {}),
    ...(reactivity ? { reactivity } : {}),
  };

  warnings.push(...lintScenePalette(scene));

  return { scene, warnings };
}
