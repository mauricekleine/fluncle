// Static lint for the global-vs-internal motion law (out/overnight/INSIGHTS.md):
// GLOBAL translation must be an audio-free constant-speed clock; ALL audio reactivity
// belongs in INTERNAL deformation. This catches, at author time, the two whole-vehicle
// JUMP bugs the round-2 labels traced — cheaper + more reliable than a post-render metric:
//
//   1. "no constant base"   — an audio uniform drives a translation term with NO
//      u_time/sec/arc clock term (e.g. `float drift = u_audioSwell * 0.10;`): drift
//      velocity = k·d(swell)/dt, which goes negative whenever swell dips → DJ scratch.
//   2. "audio exceeds clock" — an audio coefficient ≥ the constant-clock coefficient on
//      a translation term (e.g. `drift = sec*0.85 + swell*1.4 + drop*0.5;`): with swell
//      uncapped (Part I, 0.64→1.0) its derivative surges the drift → the whole frame jumps.
//
// Heuristic line scanner over the composition source (JS + GLSL). Advisory: it flags
// translation-term lines that bind audio over (or without) a dominant constant base.
// It cannot prove intent — review each finding — but it catches the named bugs reliably.

import { readFileSync } from "node:fs";

// Translation/coordinate-advance term: the LHS or the mutated thing is a global drift.
const TRANSLATION_LHS =
  /\b(drift|travel|scroll|advance|glide|slide|pan|gust|flow)\b\s*=|(?:\b(?:p|q|uv|coord|coords|st|pos|position)\b\s*\+=)|\+=\s*[a-zA-Z_]*[dD]ir\b/;

// Audio-reactive tokens (the things that must stay OFF translation).
const AUDIO_TOKEN =
  /\bu_audio[A-Za-z]+\b|\bu_bass(?:Fast)?\b|\bu_mid(?:Fast)?\b|\bu_treble(?:Fast)?\b|\bu_energy(?:Fast)?\b|\bu_beatPulse\b|\bu_onsetPulse\b|\bu_flux\b|\b(?:swell|drop|hit|onset|bass|mid|treble|energy|flux|beat)(?:Fast)?\b/g;

// Constant-clock / journey-arc tokens (audio-free; a legitimate translation base) are
// probed for an explicit coefficient in clockCoeffOnLine() below.

export type LintFinding = {
  line: number;
  text: string;
  reason: "no-constant-base" | "audio-exceeds-clock";
  audioTokens: string[];
  audioCoeff: number;
  clockCoeff: number;
};

/** The numeric coefficient multiplying `token` on a line: `token * 0.5` or `0.5 * token`.
 *  A non-numeric (variable) coefficient is treated as 1.0 — conservatively significant. */
function coeffFor(line: string, token: string): number {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let max = 0;
  let found = false;
  const after = new RegExp(`${esc}\\s*\\*\\s*([0-9]*\\.?[0-9]+)`, "g");
  const before = new RegExp(`([0-9]*\\.?[0-9]+)\\s*\\*\\s*${esc}`, "g");
  for (const m of line.matchAll(after)) {
    found = true;
    max = Math.max(max, Number(m[1]));
  }
  for (const m of line.matchAll(before)) {
    found = true;
    max = Math.max(max, Number(m[1]));
  }
  // The token is present but multiplied by a variable / added bare → assume coeff 1.0.
  return found ? max : 1.0;
}

function clockCoeffOnLine(line: string): number {
  let max = 0;
  let any = false;
  // Probe each clock token family for an explicit coefficient.
  for (const tok of ["u_time", "sec", "u_progress", "u_rise", "u_open", "u_flowBend", "arc"]) {
    if (new RegExp(`\\b${tok}\\b`).test(line)) {
      any = true;
      max = Math.max(max, coeffFor(line, tok));
    }
  }
  return any ? max : 0;
}

export function lintComposition(source: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Strip line comments so a commented-out term never trips the lint.
    const line = raw.replace(/\/\/.*$/, "");
    if (!TRANSLATION_LHS.test(line)) {
      continue;
    }
    const audioMatches = [...line.matchAll(AUDIO_TOKEN)].map((m) => m[0]);
    if (audioMatches.length === 0) {
      continue;
    }
    const audioTokens = Array.from(new Set(audioMatches));
    let audioCoeff = 0;
    for (const tok of audioTokens) {
      audioCoeff = Math.max(audioCoeff, coeffFor(line, tok));
    }
    const clockCoeff = clockCoeffOnLine(line);
    if (clockCoeff === 0) {
      findings.push({
        audioCoeff,
        audioTokens,
        clockCoeff,
        line: i + 1,
        reason: "no-constant-base",
        text: raw.trim(),
      });
    } else if (audioCoeff >= clockCoeff) {
      findings.push({
        audioCoeff,
        audioTokens,
        clockCoeff,
        line: i + 1,
        reason: "audio-exceeds-clock",
        text: raw.trim(),
      });
    }
  }
  return findings;
}

// CLI: bun src/pipeline/lint-composition.ts <composition.tsx> [--json]
// Exits non-zero when any translation term binds audio over/without a constant base.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: lint-composition <composition.tsx> [--json]");
    process.exit(2);
  }
  const findings = lintComposition(readFileSync(file, "utf8"));
  if (asJson) {
    console.log(JSON.stringify({ findings, pass: findings.length === 0 }, null, 2));
  } else if (findings.length === 0) {
    console.log(
      "✓ motion lint: no audio on a global translation term (global drift stays a clock).",
    );
  } else {
    console.error(
      `✗ MOTION LINT — ${findings.length} translation term(s) bind audio over/without a constant clock (the whole-vehicle JUMP bug). Move the reactivity into in-place internal deformation; keep global drift an audio-free constant clock (doctrine 7 / INSIGHTS.md).`,
    );
    for (const f of findings) {
      console.error(
        `  L${f.line} [${f.reason}] audio ${f.audioTokens.join(",")} (coeff ${f.audioCoeff}) vs clock coeff ${f.clockCoeff}\n    ${f.text}`,
      );
    }
  }
  process.exit(findings.length === 0 ? 0 : 1);
}
