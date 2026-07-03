// Strict Scene validator (schema `fluncle.scene/1`) with PRECISE per-field errors —
// the authoring-time counterpart to scene.ts's defensive `validateScene` (which only
// returns null/Scene and can't say WHY). Mirrors validate-intent.ts.
//
// It checks EVERY field (schema, id, kind, the glsl block, the four palette stops,
// grain, the optional bloom/reactivity, the cleared stamp, liveReady) and reports
// the exact path + reason for each violation. It ALSO runs the one load-time lint
// (palette[0] under the Warm Dark ceiling) as a warning — a scene can be structurally
// valid yet trip the ground-luminance check.
//
// CLI: bun src/pipeline/validate-scene.ts <scene.json> [--json]
// Exit 0 = valid, 1 = invalid (errors printed), 2 = usage/read error.

import { existsSync, readFileSync } from "node:fs";

import { lintScenePalette, type Scene, SCENE_SCHEMA } from "./scene";

export type SceneError = { path: string; message: string };

export type ValidateSceneResult = {
  valid: boolean;
  errors: SceneError[];
  /** Non-fatal warnings (the Warm Dark palette lint). */
  warnings: string[];
  /** The parsed scene when valid, else null. */
  scene: Scene | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const CLEARED_VERDICTS = ["pass", "fail", "inconclusive", "unknown"] as const;

/** Strict, error-collecting validation of an already-parsed value. */
export function validateSceneStrict(raw: unknown): ValidateSceneResult {
  const errors: SceneError[] = [];
  const err = (path: string, message: string): void => {
    errors.push({ message, path });
  };

  if (!isRecord(raw)) {
    return {
      errors: [{ message: "scene must be a JSON object", path: "$" }],
      scene: null,
      valid: false,
      warnings: [],
    };
  }

  if (raw.schema !== SCENE_SCHEMA) {
    err("schema", `must equal "${SCENE_SCHEMA}" (got ${JSON.stringify(raw.schema)})`);
  }

  if (typeof raw.id !== "string" || raw.id.length === 0) {
    err("id", `must be a non-empty string (got ${JSON.stringify(raw.id)})`);
  }
  if (raw.kind !== "finding" && raw.kind !== "default" && raw.kind !== "holding") {
    err("kind", `must be one of finding | default | holding (got ${JSON.stringify(raw.kind)})`);
  }

  // glsl block
  if (!isRecord(raw.glsl)) {
    err("glsl", "must be an object { body, headerVersion, glsl3 }");
  } else {
    if (typeof raw.glsl.body !== "string" || raw.glsl.body.length === 0) {
      err("glsl.body", "must be a non-empty string");
    } else if (/\$\{/.test(raw.glsl.body)) {
      err("glsl.body", "must be fully RESOLVED — no `${…}` interpolations may remain");
    }
    if (typeof raw.glsl.headerVersion !== "string") {
      err("glsl.headerVersion", "must be a string");
    }
    if (typeof raw.glsl.glsl3 !== "boolean") {
      err("glsl.glsl3", "must be a boolean");
    }
    if (raw.glsl.textures !== undefined) {
      if (!Array.isArray(raw.glsl.textures)) {
        err("glsl.textures", "when present, must be an array");
      } else {
        raw.glsl.textures.forEach((t, i) => {
          if (!isRecord(t) || typeof t.name !== "string" || t.source !== "artwork") {
            err(`glsl.textures[${i}]`, 'must be { name: string, source: "artwork" }');
          }
        });
      }
    }
  }

  // palette
  if (
    !Array.isArray(raw.palette) ||
    raw.palette.length !== 4 ||
    !raw.palette.every((s) => typeof s === "string" && s.length > 0)
  ) {
    err("palette", "must be an array of exactly four non-empty hex strings (dark→light)");
  }

  // grain
  if (!isRecord(raw.grain)) {
    err("grain", "must be an object { family, amount }");
  } else {
    if (typeof raw.grain.family !== "string") {
      err("grain.family", "must be a string");
    }
    if (typeof raw.grain.amount !== "number" || !Number.isFinite(raw.grain.amount)) {
      err("grain.amount", "must be a finite number");
    }
  }

  // bloom (optional)
  if (raw.bloom !== undefined) {
    if (!isRecord(raw.bloom)) {
      err("bloom", "when present, must be an object { threshold, intensity, radius }");
    } else {
      for (const k of ["threshold", "intensity", "radius"] as const) {
        if (typeof raw.bloom[k] !== "number" || !Number.isFinite(raw.bloom[k])) {
          err(`bloom.${k}`, "must be a finite number");
        }
      }
    }
  }

  // reactivity (optional)
  if (raw.reactivity !== undefined) {
    if (!isRecord(raw.reactivity)) {
      err("reactivity", "when present, must be an object { drop, swellBeatWeight }");
    } else {
      if (!isRecord(raw.reactivity.drop)) {
        err("reactivity.drop", "must be an object { riseMs, holdMs, fallMs }");
      } else {
        for (const k of ["riseMs", "holdMs", "fallMs"] as const) {
          if (
            typeof raw.reactivity.drop[k] !== "number" ||
            !Number.isFinite(raw.reactivity.drop[k])
          ) {
            err(`reactivity.drop.${k}`, "must be a finite number");
          }
        }
        if ("peakTimeMs" in raw.reactivity.drop) {
          err(
            "reactivity.peakTimeMs",
            "must be ABSENT — live detects the peak, offline injects it per render",
          );
        }
      }
      if (
        typeof raw.reactivity.swellBeatWeight !== "number" ||
        !Number.isFinite(raw.reactivity.swellBeatWeight)
      ) {
        err("reactivity.swellBeatWeight", "must be a finite number");
      }
    }
  }

  // cleared
  if (!isRecord(raw.cleared)) {
    err("cleared", "must be an object { beatPull, flash, arc, metricsVersion, at }");
  } else {
    for (const k of ["beatPull", "flash", "arc"] as const) {
      if (!CLEARED_VERDICTS.includes(raw.cleared[k] as never)) {
        err(`cleared.${k}`, `must be one of ${CLEARED_VERDICTS.join(" | ")}`);
      }
    }
    if (typeof raw.cleared.metricsVersion !== "string") {
      err("cleared.metricsVersion", "must be a string");
    }
    if (typeof raw.cleared.at !== "string") {
      err("cleared.at", "must be an ISO-8601 string");
    }
  }

  // liveReady
  if (typeof raw.liveReady !== "boolean") {
    err("liveReady", "must be a boolean");
  }
  if (
    !Array.isArray(raw.liveReadyReasons) ||
    !raw.liveReadyReasons.every((r) => typeof r === "string")
  ) {
    err("liveReadyReasons", "must be an array of strings (empty when live-ready)");
  }

  const valid = errors.length === 0;
  const scene = valid ? (raw as Scene) : null;
  const warnings = scene ? lintScenePalette(scene) : [];
  return { errors, scene, valid, warnings };
}

/** Read + strict-validate a scene file. Read/parse failures surface as errors. */
export function validateSceneFile(file: string): ValidateSceneResult {
  if (!existsSync(file)) {
    return {
      errors: [{ message: `file not found: ${file}`, path: "$" }],
      scene: null,
      valid: false,
      warnings: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return {
      errors: [
        { message: `not valid JSON: ${e instanceof Error ? e.message : String(e)}`, path: "$" },
      ],
      scene: null,
      valid: false,
      warnings: [],
    };
  }
  return validateSceneStrict(parsed);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: validate-scene <scene.json> [--json]");
    process.exit(2);
  }
  const result = validateSceneFile(file);
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.valid) {
    console.log(`✓ scene: ${file} is a valid ${SCENE_SCHEMA}`);
    for (const w of result.warnings) {
      console.warn(`  ! ${w}`);
    }
  } else {
    console.error(`✗ scene: ${file} is INVALID (${result.errors.length} error(s)):`);
    for (const e of result.errors) {
      console.error(`  ${e.path}: ${e.message}`);
    }
  }
  process.exit(result.valid ? 0 : 1);
}
