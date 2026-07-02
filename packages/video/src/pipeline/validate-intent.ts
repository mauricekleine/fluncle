// Strict RenderIntent validator (schema `fluncle.render-intent/1`) with PRECISE
// per-field errors — the authoring-time counterpart to intent.ts's defensive
// `validateRenderIntent` (which only returns null/RenderIntent and can't say WHY).
//
// The deterministic metrics run warn-and-stub on a bad intent; this makes the bug
// legible before that: it checks EVERY field (including the ones the runtime
// validator skips — register, textureFamily, arcSource, motionModel, climax, each
// binding's band/axis enum, and the optional doctrine fields) and reports the exact
// path + reason for each violation.
//
// CLI: bun src/pipeline/validate-intent.ts <intent.json> [--json]
// Exit 0 = valid, 1 = invalid (errors printed), 2 = usage/read error.

import { existsSync, readFileSync } from "node:fs";

import {
  ALL_AXES,
  ALL_BANDS,
  ARC_SOURCES,
  MOTION_MODELS,
  REGISTERS,
  RENDER_INTENT_SCHEMA,
  type RenderIntent,
  TEXTURE_FAMILIES,
} from "./intent";

export type IntentError = { path: string; message: string };

export type ValidateIntentResult = {
  valid: boolean;
  errors: IntentError[];
  /** the parsed intent when valid, else null. */
  intent: RenderIntent | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Strict, error-collecting validation of an already-parsed value. */
export function validateIntentStrict(raw: unknown): ValidateIntentResult {
  const errors: IntentError[] = [];
  const err = (path: string, message: string): void => {
    errors.push({ message, path });
  };

  if (!isRecord(raw)) {
    return {
      errors: [{ message: "intent must be a JSON object", path: "$" }],
      intent: null,
      valid: false,
    };
  }

  if (raw.schema !== RENDER_INTENT_SCHEMA) {
    err("schema", `must equal "${RENDER_INTENT_SCHEMA}" (got ${JSON.stringify(raw.schema)})`);
  }

  const reqString = (key: string): void => {
    if (typeof raw[key] !== "string") {
      err(key, `must be a string (got ${JSON.stringify(raw[key])})`);
    } else if ((raw[key] as string).length === 0) {
      err(key, "must be a non-empty string");
    }
  };
  reqString("trackId");
  reqString("vehicle");
  reqString("concept");

  if (!(typeof raw.logId === "string" || raw.logId === null)) {
    err("logId", `must be a string or null (got ${JSON.stringify(raw.logId)})`);
  }

  const enumField = (key: string, allowed: readonly string[]): void => {
    if (typeof raw[key] !== "string" || !allowed.includes(raw[key] as string)) {
      err(key, `must be one of ${allowed.join(" | ")} (got ${JSON.stringify(raw[key])})`);
    }
  };
  enumField("textureFamily", TEXTURE_FAMILIES);
  enumField("register", REGISTERS);
  enumField("arcSource", ARC_SOURCES);
  enumField("motionModel", MOTION_MODELS);

  if (typeof raw.dropMs !== "number" || !Number.isFinite(raw.dropMs)) {
    err("dropMs", `must be a finite number (got ${JSON.stringify(raw.dropMs)})`);
  } else if (raw.dropMs < 0) {
    err("dropMs", "must be >= 0");
  }

  // climax
  if (!isRecord(raw.climax)) {
    err("climax", "must be an object { form, colour, atMs }");
  } else {
    if (typeof raw.climax.form !== "string") {
      err("climax.form", "must be a string");
    }
    if (typeof raw.climax.colour !== "string") {
      err("climax.colour", "must be a string");
    }
    if (typeof raw.climax.atMs !== "number" || !Number.isFinite(raw.climax.atMs)) {
      err("climax.atMs", "must be a finite number");
    }
  }

  // bindings
  if (!Array.isArray(raw.bindings)) {
    err("bindings", "must be an array");
  } else {
    raw.bindings.forEach((b, i) => {
      const p = `bindings[${i}]`;
      if (!isRecord(b)) {
        err(p, "must be an object { band, element, axis, intendedStrength }");
        return;
      }
      if (typeof b.element !== "string" || b.element.length === 0) {
        err(`${p}.element`, "must be a non-empty string");
      }
      if (typeof b.band !== "string" || !ALL_BANDS.includes(b.band as never)) {
        err(`${p}.band`, `must be one of ${ALL_BANDS.join(" | ")} (got ${JSON.stringify(b.band)})`);
      }
      if (typeof b.axis !== "string" || !ALL_AXES.includes(b.axis as never)) {
        err(`${p}.axis`, `must be one of ${ALL_AXES.join(" | ")} (got ${JSON.stringify(b.axis)})`);
      }
      if (b.intendedStrength !== "subtle" && b.intendedStrength !== "strong") {
        err(
          `${p}.intendedStrength`,
          `must be "subtle" | "strong" (got ${JSON.stringify(b.intendedStrength)})`,
        );
      }
    });
  }

  // Optional fields — type-checked only when present.
  if (raw.secondaryPeaks !== undefined) {
    if (
      !Array.isArray(raw.secondaryPeaks) ||
      !raw.secondaryPeaks.every((n) => typeof n === "number")
    ) {
      err("secondaryPeaks", "when present, must be an array of numbers");
    }
  }
  if (
    raw.representationalSubject !== undefined &&
    typeof raw.representationalSubject !== "string"
  ) {
    err("representationalSubject", "when present, must be a string");
  }
  if (raw.depthMechanism !== undefined && typeof raw.depthMechanism !== "string") {
    err("depthMechanism", "when present, must be a string");
  }
  if (raw.focalPoint !== undefined && typeof raw.focalPoint !== "string") {
    err("focalPoint", "when present, must be a string");
  }

  const valid = errors.length === 0;
  return { errors, intent: valid ? (raw as RenderIntent) : null, valid };
}

/** Read + strict-validate an intent file. Read/parse failures surface as errors. */
export function validateIntentFile(file: string): ValidateIntentResult {
  if (!existsSync(file)) {
    return {
      errors: [{ message: `file not found: ${file}`, path: "$" }],
      intent: null,
      valid: false,
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
      intent: null,
      valid: false,
    };
  }
  return validateIntentStrict(parsed);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: validate-intent <intent.json> [--json]");
    process.exit(2);
  }
  const result = validateIntentFile(file);
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.valid) {
    console.log(`✓ intent: ${file} is a valid ${RENDER_INTENT_SCHEMA}`);
  } else {
    console.error(`✗ intent: ${file} is INVALID (${result.errors.length} error(s)):`);
    for (const e of result.errors) {
      console.error(`  ${e.path}: ${e.message}`);
    }
  }
  process.exit(result.valid ? 0 : 1);
}
