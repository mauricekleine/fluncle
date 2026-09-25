import { readFileSync } from "node:fs";

const TRANSLATION_LHS =
  /\b(drift|travel|scroll|advance|glide|slide|pan|gust|flow)\b\s*=|(?:\b(?:p|q|uv|coord|coords|st|pos|position)\b\s*\+=)|\+=\s*[a-zA-Z_]*[dD]ir\b/;

const COORD_FEED =
  /\b(?:p|q|uv|coord|coords|st|pos|position)\b\s*(?:\+?=)|\b(drift|travel|scroll|advance|glide|slide|pan|gust|flow)\b\s*=|[a-zA-Z_]*[dD]ir\b/;

const AUDIO_TOKEN =
  /\bu_audio[A-Za-z]+\b|\bu_bass(?:Fast)?\b|\bu_mid(?:Fast)?\b|\bu_treble(?:Fast)?\b|\bu_energy(?:Fast)?\b|\bu_beatPulse\b|\bu_onsetPulse\b|\bu_flux\b|\bu_sub\b|\bu_kickHit\b|\bu_snareHit\b|\bu_air\b|\bu_downbeatPulse\b|\b(?:swell|drop|hit|onset|bass|mid|treble|energy|flux|beat|sub|kickHit|snareHit|air)(?:Fast)?\b/g;

const AUDIO_EXPR =
  /\b(?:audioRx|reactivity)\b|\.\s*(?:swell|drop|hit|onset|bass|mid|treble|energy|flux|beat|sub|kickHit|snareHit|air|downbeatPulse)(?:Fast)?\b|\buse(?:Bass|Mid|Treble|Energy|Flux|Beat|Onset|AudioReactivity)\s*\(/;

const CLOCK_TOKENS = ["u_time", "sec", "u_progress", "u_rise", "u_open", "u_flowBend", "arc"];

const PHASE_CLOCK_TOKENS = ["u_time", "sec", "u_progress", "u_rise", "u_open", "arc"];

export type LintFinding = {
  line: number;
  text: string;
  reason: "no-constant-base" | "audio-exceeds-clock" | "audio-tainted-phase";
  audioTokens: string[];
  audioCoeff: number;
  clockCoeff: number;
};

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

  return found ? max : 1.0;
}

function clockCoeffOnLine(line: string, tokens: readonly string[] = CLOCK_TOKENS): number {
  let max = 0;
  let any = false;

  for (const tok of tokens) {
    if (new RegExp(`\\b${tok}\\b`).test(line)) {
      any = true;
      max = Math.max(max, coeffFor(line, tok));
    }
  }
  return any ? max : 0;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function collectAudioVars(cleanSource: string): Set<string> {
  const vars = new Set<string>();

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

  for (const m of cleanSource.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
    if (AUDIO_EXPR.test(m[2])) {
      vars.add(m[1]);
    }
  }
  return vars;
}

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

function collectTaintedUniforms(cleanSource: string, audioVars: Set<string>): Set<string> {
  const tainted = new Set<string>();
  const re = /\buniforms\b\s*=?\s*\{\{?/g;
  for (let m = re.exec(cleanSource); m !== null; m = re.exec(cleanSource)) {
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

    const trimmed = body.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      body = trimmed.slice(1, -1);
    }

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

    const clockCoeff = clockCoeffOnLine(rhs, PHASE_CLOCK_TOKENS);
    if (clockCoeff === 0) {
      continue;
    }
    const audioTokens = audioTokensOnLine(rhs, taintedUniforms);
    if (audioTokens.length === 0) {
      continue;
    }
    let audioCoeff = 0;
    for (const tok of audioTokens) {
      audioCoeff = Math.max(audioCoeff, coeffFor(rhs, tok));
    }
    if (audioCoeff < clockCoeff) {
      continue;
    }

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

  findings.push(...detectTaintedPhases(lines, taintedUniforms));
  findings.sort((a, b) => a.line - b.line);
  return findings;
}

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
