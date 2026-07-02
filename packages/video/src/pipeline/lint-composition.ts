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
// LAUNDERING GUARD (the taint pass). A naive token scan is defeated by JS-side
// RENAMING: `uniforms={{ u_flowBend: audioRx.swell }}` binds an audio bus value to a
// custom uniform name, then `float t = u_time + u_flowBend*1.1;` advances a phase
// variable by an audio term — and `t` drives coordinates — with NO literal audio
// token anywhere on the translation line. Two extra passes close that hole:
//   a) Uniform-bag taint: parse `uniforms={{ name: <expr> }}` object literals; any
//      custom uniform NAME whose value is an audio expression (audioRx.*, a bus field
//      like `.swell`, a `use*()` hook result, or a JS var that itself holds one)
//      is treated as an audio token inside the GLSL scan.
//   3. "audio-tainted phase" — a TIME/PHASE variable (`float t = u_time + <audio>*k`)
//      whose audio term is NOT dominated by a constant clock base, when `t` later
//      feeds coordinates: the audio invisibly advances the phase → the same JUMP.
//
// Heuristic line scanner over the composition source (JS + GLSL). Advisory: it flags
// translation-term lines that bind audio over (or without) a dominant constant base.
// It cannot prove intent — review each finding — but it catches the named bugs reliably.

import { readFileSync } from "node:fs";

// Translation/coordinate-advance term: the LHS or the mutated thing is a global drift.
const TRANSLATION_LHS =
  /\b(drift|travel|scroll|advance|glide|slide|pan|gust|flow)\b\s*=|(?:\b(?:p|q|uv|coord|coords|st|pos|position)\b\s*\+=)|\+=\s*[a-zA-Z_]*[dD]ir\b/;

// Coordinate-FEED term (broader than TRANSLATION_LHS): a coordinate/position var
// assigned OR advanced, or a *Dir/travel vector in play. Used to decide whether a
// tainted phase variable actually reaches the geometry.
const COORD_FEED =
  /\b(?:p|q|uv|coord|coords|st|pos|position)\b\s*(?:\+?=)|\b(drift|travel|scroll|advance|glide|slide|pan|gust|flow)\b\s*=|[a-zA-Z_]*[dD]ir\b/;

// Audio-reactive tokens (the things that must stay OFF translation). Extended with the
// incoming DSP band names (u_sub/sub, u_kickHit/kickHit, u_snareHit/snareHit, u_air/air,
// u_downbeatPulse) so a translation term binding a new band is caught the day it lands.
const AUDIO_TOKEN =
  /\bu_audio[A-Za-z]+\b|\bu_bass(?:Fast)?\b|\bu_mid(?:Fast)?\b|\bu_treble(?:Fast)?\b|\bu_energy(?:Fast)?\b|\bu_beatPulse\b|\bu_onsetPulse\b|\bu_flux\b|\bu_sub\b|\bu_kickHit\b|\bu_snareHit\b|\bu_air\b|\bu_downbeatPulse\b|\b(?:swell|drop|hit|onset|bass|mid|treble|energy|flux|beat|sub|kickHit|snareHit|air)(?:Fast)?\b/g;

// An audio-bearing EXPRESSION on a JS RHS (for taint discovery): the reactivity bus by
// object (`audioRx`, `reactivity`), a bus field access (`.swell`, `.bass`, …), or a
// `use*()` audio hook call. Distinct from AUDIO_TOKEN (which scans GLSL identifiers).
const AUDIO_EXPR =
  /\b(?:audioRx|reactivity)\b|\.\s*(?:swell|drop|hit|onset|bass|mid|treble|energy|flux|beat|sub|kickHit|snareHit|air|downbeatPulse)(?:Fast)?\b|\buse(?:Bass|Mid|Treble|Energy|Flux|Beat|Onset|AudioReactivity)\s*\(/;

// Constant-clock / journey-arc tokens (audio-free; a legitimate translation base).
const CLOCK_TOKENS = ["u_time", "sec", "u_progress", "u_rise", "u_open", "u_flowBend", "arc"];
// The subset of clock tokens that also name a real audio-free time source when probing
// a phase variable's base (u_flowBend is a *custom* name — excluded, it may be tainted).
const PHASE_CLOCK_TOKENS = ["u_time", "sec", "u_progress", "u_rise", "u_open", "arc"];

export type LintFinding = {
  line: number;
  text: string;
  reason: "no-constant-base" | "audio-exceeds-clock" | "audio-tainted-phase";
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

function clockCoeffOnLine(line: string, tokens: readonly string[] = CLOCK_TOKENS): number {
  let max = 0;
  let any = false;
  // Probe each clock token family for an explicit coefficient.
  for (const tok of tokens) {
    if (new RegExp(`\\b${tok}\\b`).test(line)) {
      any = true;
      max = Math.max(max, coeffFor(line, tok));
    }
  }
  return any ? max : 0;
}

/** Strip `//` line comments and `/* *​/` block comments so commented-out terms never trip. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** JS identifiers that HOLD an audio value: `const x = audioRx.swell`, `const x = useBass(…)`,
 *  or a destructured bus `const { swell, bass } = useAudioReactivity(…)`. Lets the uniform-bag
 *  taint follow one hop of indirection (a renamed local that is really an audio signal). */
function collectAudioVars(cleanSource: string): Set<string> {
  const vars = new Set<string>();
  // Destructured bus: const { a, b } = useAudioReactivity(...) OR = audioRx
  for (const m of cleanSource.matchAll(
    /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(use(?:AudioReactivity|Bass|Mid|Treble|Energy|Flux|Beat|Onset)\s*\(|audioRx\b|reactivity\b)/g,
  )) {
    for (const name of m[1].split(",")) {
      const id = name.split(":").pop()?.trim().replace(/\s.*$/, "");
      if (id && /^[A-Za-z_$][\w$]*$/.test(id)) {
        vars.add(id);
      }
    }
  }
  // Direct: const x = <audio expr>
  for (const m of cleanSource.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
    if (AUDIO_EXPR.test(m[2])) {
      vars.add(m[1]);
    }
  }
  return vars;
}

/** Whether an expression string carries an audio value (a bus expr, a hook, or an audio var). */
function exprIsAudio(expr: string, audioVars: Set<string>): boolean {
  if (AUDIO_EXPR.test(expr)) {
    return true;
  }
  AUDIO_TOKEN.lastIndex = 0;
  if (AUDIO_TOKEN.test(expr)) {
    return true;
  }
  for (const v of audioVars) {
    if (new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(expr)) {
      return true;
    }
  }
  return false;
}

/** Custom uniform NAMES bound to an audio value inside a `uniforms={{ … }}` object literal.
 *  Walks each `uniforms` occurrence to its balanced `{ … }` body, splits top-level `key: expr`
 *  pairs, and taints keys whose value is audio. These names re-enter the GLSL scan as tokens. */
function collectTaintedUniforms(cleanSource: string, audioVars: Set<string>): Set<string> {
  const tainted = new Set<string>();
  const re = /\buniforms\b\s*=?\s*\{\{?/g;
  for (let m = re.exec(cleanSource); m !== null; m = re.exec(cleanSource)) {
    // Walk from the first `{` after `uniforms` to its matching close brace.
    let i = cleanSource.indexOf("{", m.index);
    if (i < 0) {
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let j = i; j < cleanSource.length; j++) {
      const ch = cleanSource[j];
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) {
      continue;
    }
    let body = cleanSource.slice(i + 1, end);
    // JSX double-brace `={{ … }}`: the outer `{` is the expression container, so the
    // captured body is itself `{ …object… }`. Unwrap one balanced brace layer.
    const trimmed = body.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      body = trimmed.slice(1, -1);
    }
    // Split into top-level pairs on commas that are not nested in (), [], {}.
    const pairs: string[] = [];
    let d = 0;
    let start = 0;
    for (let k = 0; k < body.length; k++) {
      const ch = body[k];
      if (ch === "(" || ch === "[" || ch === "{") {
        d += 1;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        d -= 1;
      } else if (ch === "," && d === 0) {
        pairs.push(body.slice(start, k));
        start = k + 1;
      }
    }
    pairs.push(body.slice(start));
    for (const pair of pairs) {
      const colon = pair.indexOf(":");
      if (colon < 0) {
        continue;
      }
      const key = pair
        .slice(0, colon)
        .trim()
        .replace(/^["']|["']$/g, "");
      const value = pair.slice(colon + 1);
      if (/^[A-Za-z_$][\w$]*$/.test(key) && exprIsAudio(value, audioVars)) {
        tainted.add(key);
      }
    }
  }
  return tainted;
}

/** Audio tokens present on a GLSL line: literal AUDIO_TOKEN matches ∪ any tainted uniform name. */
function audioTokensOnLine(line: string, taintedUniforms: Set<string>): string[] {
  const found = new Set<string>();
  for (const m of line.matchAll(AUDIO_TOKEN)) {
    found.add(m[0]);
  }
  for (const name of taintedUniforms) {
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(line)) {
      found.add(name);
    }
  }
  return [...found];
}

/**
 * Audio-tainted PHASE variables. A `<type> name = <expr>` whose expr is a time/phase
 * expression (contains a clock token) AND carries an audio term that is NOT dominated by
 * the clock base (no base, or audio coeff ≥ clock coeff) is a laundered phase. If `name`
 * then feeds coordinates anywhere in the source, emit a finding at the DECLARATION line
 * (the real bug site). Mirrors the translation-line rules so a dominated bend is allowed.
 */
function detectTaintedPhases(lines: string[], taintedUniforms: Set<string>): LintFinding[] {
  const findings: LintFinding[] = [];
  const declRe = /\b(?:float|vec2|vec3|vec4)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+)/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\/\/.*$/, "");
    const decl = declRe.exec(line);
    if (!decl) {
      continue;
    }
    const name = decl[1];
    const rhs = decl[2];
    // Must be a TIME/PHASE expression: a real audio-free clock token present.
    const clockCoeff = clockCoeffOnLine(rhs, PHASE_CLOCK_TOKENS);
    if (clockCoeff === 0) {
      continue; // no clock base at all → not a "phase" (a pure-audio drift is caught by the main scan)
    }
    const audioTokens = audioTokensOnLine(rhs, taintedUniforms);
    if (audioTokens.length === 0) {
      continue; // a clean clock phase
    }
    let audioCoeff = 0;
    for (const tok of audioTokens) {
      audioCoeff = Math.max(audioCoeff, coeffFor(rhs, tok));
    }
    if (audioCoeff < clockCoeff) {
      continue; // a DOMINATED bend on the phase is allowed (like a bent translation speed)
    }
    // Violating tainted phase — does `name` reach the geometry anywhere?
    const nameRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    let feedsCoords = false;
    for (let j = 0; j < lines.length; j++) {
      if (j === i) {
        continue;
      }
      const other = lines[j].replace(/\/\/.*$/, "");
      if (COORD_FEED.test(other) && nameRe.test(other)) {
        feedsCoords = true;
        break;
      }
    }
    if (feedsCoords) {
      findings.push({
        audioCoeff,
        audioTokens,
        clockCoeff,
        line: i + 1,
        reason: "audio-tainted-phase",
        text: lines[i].trim(),
      });
    }
  }
  return findings;
}

export function lintComposition(source: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const clean = stripComments(source);
  const audioVars = collectAudioVars(clean);
  const taintedUniforms = collectTaintedUniforms(clean, audioVars);

  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Strip line comments so a commented-out term never trips the lint.
    const line = raw.replace(/\/\/.*$/, "");
    if (!TRANSLATION_LHS.test(line)) {
      continue;
    }
    const audioTokens = audioTokensOnLine(line, taintedUniforms);
    if (audioTokens.length === 0) {
      continue;
    }
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

  // The taint pass: laundered phase variables that reach the geometry.
  findings.push(...detectTaintedPhases(lines, taintedUniforms));
  findings.sort((a, b) => a.line - b.line);
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
