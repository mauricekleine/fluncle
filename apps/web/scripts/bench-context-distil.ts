#!/usr/bin/env bun
/**
 * Frozen-corpus context-distil bench. One invocation evaluates one OpenRouter
 * model/effort pair, with three samples per track at production temperature.
 * It imports only pure graders and request-content builders; the OpenRouter fetch
 * is implemented here so no production cost event can be emitted.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Artifact,
  extractTextureDescriptors,
  measureTextureVocab,
  WORN_TEXTURE_WORDS,
} from "../src/lib/server/artifact-diversity";
import {
  APPLE_EDITORIAL_SNIPPET_LABEL,
  buildContextDistilUserContent,
  longestVerbatimTokenSpan,
  noteEchoesAppleEditorial,
  stripEditorialHtml,
} from "../src/lib/server/observation";
import { PROMPT_REGISTRY, resolvePrompt } from "../src/lib/server/prompts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(SCRIPT_DIR, "fixtures");
const CORPUS_PATH = join(FIXTURE_DIR, "distil-corpus.json");
const EXPECTED_PATH = join(FIXTURE_DIR, "distil-expected-facts.json");
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";
const DEFAULT_TIMEOUT_MS = 60_000;
const RUNS_PER_CASE = 3;

type CorpusFixture = {
  capturedAt: string;
  query: string;
  snippets: string[];
  sources: string[];
  trackId: string;
};
type ExpectedFixture = {
  appleFuel?: boolean;
  expectedFacts: string[];
  forbiddenClaims: string[];
  trackId: string;
};
type BenchCase = CorpusFixture & ExpectedFixture;
type PromptInfo = { body: string; source: "default" | "override"; version: number };
type CliOptions = { outPath?: string; timeoutMs: number };
type Usage = {
  completionTokens: number | null;
  costUsd: number | null;
  promptTokens: number | null;
};
type FactGrade = { fact: string; matched: boolean; overlap: number };
type MechanicalGrade = {
  headingFree: boolean;
  lengthWithinCap: boolean;
  listFree: boolean;
  paragraphCount: number;
  paragraphsValid: boolean;
  passed: boolean;
  sourceListFree: boolean;
  textureCount: number;
  textureItemCount: number;
  textureValid: boolean;
  violations: string[];
};
type OutputGrade = {
  appleEcho: boolean;
  appleFuelPresent: boolean;
  appleMaxVerbatimSpan: number;
  expectedFacts: FactGrade[];
  expectedFactsRecall: number;
  forbiddenClaims: FactGrade[];
  hallucination: boolean;
  mechanical: MechanicalGrade;
  textureDescriptors: string[];
};
type RunResult = {
  error: string | null;
  grade: OutputGrade | null;
  latencyMs: number;
  model: string;
  note: string | null;
  run: number;
  trackId: string;
  usage: Usage;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCorpusFixture(value: unknown): value is CorpusFixture {
  return (
    isRecord(value) &&
    typeof value.capturedAt === "string" &&
    typeof value.query === "string" &&
    isStringArray(value.snippets) &&
    isStringArray(value.sources) &&
    typeof value.trackId === "string"
  );
}

function isExpectedFixture(value: unknown): value is ExpectedFixture {
  return (
    isRecord(value) &&
    (value.appleFuel === undefined || typeof value.appleFuel === "boolean") &&
    isStringArray(value.expectedFacts) &&
    isStringArray(value.forbiddenClaims) &&
    typeof value.trackId === "string"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function fail(message: string): never {
  console.error(`bench-context-distil: ${message}`);
  process.exit(1);
}

function usage(): string {
  return `Usage: bun run --cwd apps/web bench:context-distil [--timeout-ms <positive integer>] [--out <path>]

OpenRouter runs when OPENROUTER_API_KEY is present.
Model/effort: OPENROUTER_BENCH_MODEL [OPENROUTER_BENCH_EFFORT]
Live prompt: TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (otherwise the baked prompt is graded).`;
}

function parseArgs(argv: string[]): CliOptions {
  let outPath: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }

    if (arg === "--out") {
      const value = argv[index + 1];

      if (!value) {
        fail("--out requires a path");
      }

      outPath = value;
      index += 1;
      continue;
    }

    if (arg === "--timeout-ms") {
      const value = argv[index + 1];

      if (!value) {
        fail("--timeout-ms requires a value");
      }

      timeoutMs = Number(value);

      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        fail(`--timeout-ms must be a positive integer, got ${JSON.stringify(value)}`);
      }

      index += 1;
      continue;
    }

    fail(`unknown argument ${JSON.stringify(arg)}\n\n${usage()}`);
  }

  return { outPath, timeoutMs };
}

async function readFixtures(): Promise<{
  cases: BenchCase[];
  notices: string[];
}> {
  let corpusValue: unknown;
  let expectedValue: unknown;

  try {
    [corpusValue, expectedValue] = await Promise.all([
      readFile(CORPUS_PATH, "utf8").then((raw) => JSON.parse(raw) as unknown),
      readFile(EXPECTED_PATH, "utf8").then((raw) => JSON.parse(raw) as unknown),
    ]);
  } catch (error) {
    fail(`fixture read failed: ${errorMessage(error)}`);
  }

  if (!Array.isArray(corpusValue) || !corpusValue.every(isCorpusFixture)) {
    fail("distil-corpus.json must be an array of captured corpus entries");
  }

  if (!Array.isArray(expectedValue) || !expectedValue.every(isExpectedFixture)) {
    fail("distil-expected-facts.json must be an array of expected-fact entries");
  }

  const notices: string[] = [];

  if (corpusValue.length === 0) {
    notices.push(
      "distil-corpus.json is empty; run capture:distil-corpus after filling the track list",
    );
  }

  if (
    expectedValue.length === 0 ||
    expectedValue.some(
      (entry) =>
        entry.trackId === "..." ||
        entry.expectedFacts.includes("...") ||
        entry.forbiddenClaims.includes("..."),
    )
  ) {
    notices.push("distil-expected-facts.json is still a placeholder");
  }

  const expectedById = new Map(expectedValue.map((entry) => [entry.trackId, entry]));
  const cases: BenchCase[] = [];

  for (const corpus of corpusValue) {
    const expected = expectedById.get(corpus.trackId);

    if (!expected) {
      notices.push(`${corpus.trackId} has corpus fuel but no expected-facts entry`);
      continue;
    }

    cases.push({ ...corpus, ...expected });
  }

  for (const expected of expectedValue) {
    if (
      expected.trackId !== "..." &&
      !corpusValue.some((item) => item.trackId === expected.trackId)
    ) {
      notices.push(`${expected.trackId} has expected facts but no captured corpus entry`);
    }
  }

  return { cases, notices };
}

async function resolveBenchPrompt(): Promise<PromptInfo> {
  const baked = PROMPT_REGISTRY.context_distil.defaultBody;
  const hasDbEnv = Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);

  if (!hasDbEnv) {
    console.error(
      "*** WARNING: TURSO_DATABASE_URL/TURSO_AUTH_TOKEN are absent. " +
        "The bench is grading the BAKED context_distil prompt. ***",
    );
    return { body: baked, source: "default", version: 0 };
  }

  try {
    const prompt = await resolvePrompt("context_distil");

    if (prompt.source === "default") {
      console.error(
        "*** NOTICE: no live context_distil override resolved; grading the baked prompt. ***",
      );
    }

    return { body: prompt.body, source: prompt.source, version: prompt.version };
  } catch (error) {
    console.error(
      `*** WARNING: live context_distil resolution failed (${errorMessage(error)}); grading the baked prompt. ***`,
    );
    return { body: baked, source: "default", version: 0 };
  }
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Tolerant fact heuristic: a fact matches on a normalized substring, or when at
 * least 70% of its unique alphanumeric tokens occur anywhere in the note. One-token
 * facts require that exact token; longer facts require at least two matching tokens.
 */
function gradeFact(note: string, fact: string): FactGrade {
  const normalizedNote = normalizeText(note);
  const normalizedFact = normalizeText(fact);
  const factTokens = [...new Set(normalizedFact.split(" ").filter(Boolean))];

  if (!normalizedFact || factTokens.length === 0) {
    return { fact, matched: false, overlap: 0 };
  }

  if (normalizedNote.includes(normalizedFact)) {
    return { fact, matched: true, overlap: 1 };
  }

  const noteTokens = new Set(normalizedNote.split(" ").filter(Boolean));
  const matchedTokens = factTokens.filter((token) => noteTokens.has(token)).length;
  const overlap = matchedTokens / factTokens.length;
  const matched =
    factTokens.length === 1 ? matchedTokens === 1 : matchedTokens >= 2 && overlap >= 0.7;

  return { fact, matched, overlap };
}

function mechanicalGrade(note: string): MechanicalGrade {
  const lines = note.split(/\r?\n/);
  const textureLines = lines.filter((line) => /^\s*texture\s*:/i.test(line));
  const lastNonEmpty = [...lines].reverse().find((line) => line.trim().length > 0);
  const textureDescriptors = extractTextureDescriptors(note);
  const textureValid =
    textureLines.length === 1 &&
    lastNonEmpty === textureLines[0] &&
    textureDescriptors.length >= 3 &&
    textureDescriptors.length <= 6;
  const prose = lines
    .filter((line) => !/^\s*texture\s*:/i.test(line))
    .join("\n")
    .trim();
  const paragraphCount = prose
    ? prose.split(/\n\s*\n/).filter((paragraph) => paragraph.trim().length > 0).length
    : 0;
  const paragraphsValid = paragraphCount >= 1 && paragraphCount <= 2;
  const listFree = !lines.some((line) => /^\s*(?:[-*+] |\d+[.)] )/.test(line));
  const headingFree = !lines.some((line) => /^\s*#{1,6}\s+/.test(line));
  const sourceListFree = !/https?:\/\/|^\s*sources?\s*:/im.test(note);
  const lengthWithinCap = note.length <= 2000;
  const violations: string[] = [];

  if (!paragraphsValid) {
    violations.push(`expected 1-2 prose paragraphs, got ${paragraphCount}`);
  }
  if (!textureValid) {
    violations.push(
      `expected one trailing Texture line with 3-6 items, got lines=${textureLines.length} items=${textureDescriptors.length}`,
    );
  }
  if (!listFree) {
    violations.push("contains a bullet or numbered-list line");
  }
  if (!headingFree) {
    violations.push("contains a Markdown heading");
  }
  if (!sourceListFree) {
    violations.push("contains a source URL or source-list label");
  }
  if (!lengthWithinCap) {
    violations.push(`exceeds the 2000-character cap (${note.length})`);
  }

  return {
    headingFree,
    lengthWithinCap,
    listFree,
    paragraphCount,
    paragraphsValid,
    passed: violations.length === 0,
    sourceListFree,
    textureCount: textureLines.length,
    textureItemCount: textureDescriptors.length,
    textureValid,
    violations,
  };
}

function appleTexts(benchCase: BenchCase): string[] {
  const prefix = `${APPLE_EDITORIAL_SNIPPET_LABEL}:`;

  return benchCase.snippets
    .filter((snippet) => snippet.startsWith(prefix))
    .map((snippet) => stripEditorialHtml(snippet.slice(prefix.length).trim()))
    .filter(Boolean);
}

function gradeOutput(benchCase: BenchCase, note: string): OutputGrade {
  const appleSources = appleTexts(benchCase);
  const expectedFacts = benchCase.expectedFacts.map((fact) => gradeFact(note, fact));
  const forbiddenClaims = benchCase.forbiddenClaims.map((fact) => gradeFact(note, fact));

  return {
    appleEcho: noteEchoesAppleEditorial(note, appleSources),
    appleFuelPresent: appleSources.length > 0,
    appleMaxVerbatimSpan: appleSources.reduce(
      (best, source) => Math.max(best, longestVerbatimTokenSpan(note, source)),
      0,
    ),
    expectedFacts,
    expectedFactsRecall:
      expectedFacts.length === 0
        ? 1
        : expectedFacts.filter((fact) => fact.matched).length / expectedFacts.length,
    forbiddenClaims,
    hallucination: forbiddenClaims.some((fact) => fact.matched),
    mechanical: mechanicalGrade(note),
    textureDescriptors: extractTextureDescriptors(note),
  };
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseOpenRouter(payload: unknown): { model: string | null; note: string; usage: Usage } {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new Error("OpenRouter response has no choices array");
  }

  const first = payload.choices[0];
  const content = isRecord(first) && isRecord(first.message) ? first.message.content : undefined;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenRouter response has no non-empty choices[0].message.content");
  }

  const responseUsage = isRecord(payload.usage) ? payload.usage : {};

  return {
    model: typeof payload.model === "string" ? payload.model : null,
    note: content.trim(),
    usage: {
      completionTokens: numberField(responseUsage.completion_tokens),
      costUsd: numberField(responseUsage.cost),
      promptTokens: numberField(responseUsage.prompt_tokens),
    },
  };
}

async function invokeOpenRouter(input: {
  apiKey: string;
  benchCase: BenchCase;
  effort?: string;
  model: string;
  prompt: string;
  timeoutMs: number;
}): Promise<{ model: string; note: string; usage: Usage }> {
  const response = await fetch(OPENROUTER_CHAT_URL, {
    body: JSON.stringify({
      messages: [
        { content: input.prompt, role: "system" },
        { content: buildContextDistilUserContent(input.benchCase), role: "user" },
      ],
      model: input.model,
      ...(input.effort ? { reasoning: { effort: input.effort } } : {}),
      temperature: 0.2,
      usage: { include: true },
    }),
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`OpenRouter HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  let payload: unknown;

  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`OpenRouter returned non-JSON HTTP ${response.status}`);
  }

  const parsed = parseOpenRouter(payload);

  return { ...parsed, model: parsed.model ?? input.model };
}

async function runSample(input: {
  apiKey: string;
  benchCase: BenchCase;
  effort?: string;
  model: string;
  prompt: string;
  run: number;
  timeoutMs: number;
}): Promise<RunResult> {
  const start = performance.now();

  try {
    const response = await invokeOpenRouter(input);

    return {
      error: null,
      grade: gradeOutput(input.benchCase, response.note),
      latencyMs: performance.now() - start,
      model: response.model,
      note: response.note,
      run: input.run,
      trackId: input.benchCase.trackId,
      usage: response.usage,
    };
  } catch (error) {
    return {
      error: errorMessage(error),
      grade: null,
      latencyMs: performance.now() - start,
      model: input.model,
      note: null,
      run: input.run,
      trackId: input.benchCase.trackId,
      usage: { completionTokens: null, costUsd: null, promptTokens: null },
    };
  }
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);

  return sorted[index] ?? null;
}

function round(value: number | null, digits = 3): number | null {
  return value === null ? null : Number(value.toFixed(digits));
}

function summarizeCase(benchCase: BenchCase, results: RunResult[]) {
  const grades = results.map((result) => result.grade).filter((grade) => grade !== null);
  const latencies = results.map((result) => result.latencyMs);
  const costs = results
    .map((result) => result.usage.costUsd)
    .filter((cost): cost is number => cost !== null);

  return {
    appleEchoRuns: grades.filter((grade) => grade.appleEcho).length,
    appleFuelExpected: benchCase.appleFuel ?? null,
    appleFuelPresent: appleTexts(benchCase).length > 0,
    costUsd: round(
      costs.reduce((sum, cost) => sum + cost, 0),
      6,
    ),
    errors: results.filter((result) => result.error !== null).length,
    hallucinationRuns: grades.filter((grade) => grade.hallucination).length,
    latencyMs: {
      max: round(latencies.length === 0 ? null : Math.max(...latencies), 1),
      min: round(latencies.length === 0 ? null : Math.min(...latencies), 1),
      p50: round(percentile(latencies, 0.5), 1),
    },
    mechanicalPassRuns: grades.filter((grade) => grade.mechanical.passed).length,
    recallMean:
      grades.length === 0
        ? null
        : round(grades.reduce((sum, grade) => sum + grade.expectedFactsRecall, 0) / grades.length),
    runs: results.length,
    successfulRuns: grades.length,
    trackId: benchCase.trackId,
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

function printTable(summaries: ReturnType<typeof summarizeCase>[]): void {
  console.log(
    `\n${pad("track", 23)} ${pad("ok", 5)} ${pad("rails", 7)} ${pad("recall", 8)} ${pad("hall", 5)} ${pad("echo", 5)} ${pad("latency min/p50/max ms", 24)} cost USD`,
  );
  console.log("-".repeat(103));

  for (const summary of summaries) {
    const latency = `${summary.latencyMs.min ?? "-"}/${summary.latencyMs.p50 ?? "-"}/${summary.latencyMs.max ?? "-"}`;
    console.log(
      `${pad(summary.trackId, 23)} ${pad(`${summary.successfulRuns}/${summary.runs}`, 5)} ${pad(`${summary.mechanicalPassRuns}/${summary.runs}`, 7)} ${pad(summary.recallMean === null ? "-" : `${(summary.recallMean * 100).toFixed(1)}%`, 8)} ${pad(String(summary.hallucinationRuns), 5)} ${pad(String(summary.appleEchoRuns), 5)} ${pad(latency, 24)} ${(summary.costUsd ?? 0).toFixed(6)}`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { cases, notices } = await readFixtures();
  const prompt = await resolveBenchPrompt();
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.OPENROUTER_BENCH_MODEL?.trim() || DEFAULT_MODEL;
  const effort = process.env.OPENROUTER_BENCH_EFFORT?.trim() || undefined;
  const results: RunResult[] = [];

  console.log(
    `bench-context-distil: cases=${cases.length} k=${RUNS_PER_CASE} model=${model} effort=${effort ?? "provider-default"} prompt=${prompt.source}@${prompt.version}`,
  );

  for (const notice of notices) {
    console.error(`FIXTURE: ${notice}`);
  }

  if (!apiKey) {
    console.error("SKIPPED: OpenRouter — missing OPENROUTER_API_KEY");
  }

  if (apiKey && cases.length > 0 && notices.every((notice) => !notice.includes("placeholder"))) {
    for (const [caseIndex, benchCase] of cases.entries()) {
      for (let run = 1; run <= RUNS_PER_CASE; run += 1) {
        console.error(
          `  ${caseIndex + 1}/${cases.length} ${benchCase.trackId} run ${run}/${RUNS_PER_CASE}`,
        );
        results.push(
          await runSample({
            apiKey,
            benchCase,
            effort,
            model,
            prompt: prompt.body,
            run,
            timeoutMs: options.timeoutMs,
          }),
        );
      }
    }
  } else {
    console.log("No runnable provider/case set; nothing was called.");
  }

  const summaries = cases.map((benchCase) =>
    summarizeCase(
      benchCase,
      results.filter((result) => result.trackId === benchCase.trackId),
    ),
  );
  const artifacts: Artifact[] = results
    .filter((result): result is RunResult & { note: string } => typeof result.note === "string")
    .map((result) => ({ id: `${result.trackId}:${result.run}`, text: result.note }));
  const textureVocab = measureTextureVocab(artifacts, { wornWords: WORN_TEXTURE_WORDS });
  const latencyValues = results.map((result) => result.latencyMs);
  const measuredCosts = results
    .map((result) => result.usage.costUsd)
    .filter((cost): cost is number => cost !== null);
  const overall = {
    costSamples: measuredCosts.length,
    latencyMs: {
      p50: round(percentile(latencyValues, 0.5), 1),
      p95: round(percentile(latencyValues, 0.95), 1),
    },
    textureVocab,
    totalCostUsd: round(
      measuredCosts.reduce((sum, cost) => sum + cost, 0),
      6,
    ),
  };

  if (summaries.length > 0) {
    printTable(summaries);
    console.log(
      `\nOverall: latency p50=${overall.latencyMs.p50 ?? "-"} ms p95=${overall.latencyMs.p95 ?? "-"} ms; cost=$${(overall.totalCostUsd ?? 0).toFixed(6)}; texture vocabulary=${textureVocab.vocabulary}; texture-bearing=${textureVocab.size}/${textureVocab.total}`,
    );
    console.log(
      `Worn texture docFreq: ${textureVocab.worn.map((item) => `${item.word}=${item.docFreq}`).join(", ")}`,
    );
  }

  if (options.outPath) {
    const output = {
      cases: cases.map((benchCase) => ({
        appleFuel: benchCase.appleFuel ?? null,
        capturedAt: benchCase.capturedAt,
        expectedFacts: benchCase.expectedFacts,
        forbiddenClaims: benchCase.forbiddenClaims,
        query: benchCase.query,
        snippets: benchCase.snippets,
        sources: benchCase.sources,
        trackId: benchCase.trackId,
      })),
      generatedAt: new Date().toISOString(),
      grading: {
        factMatch:
          "normalized substring OR >=70% unique alphanumeric expected-fact token overlap; multi-token facts require >=2 matching tokens",
        runsPerCase: RUNS_PER_CASE,
        temperature: 0.2,
      },
      notices,
      overall,
      prompt,
      provider: {
        configured: Boolean(apiKey),
        effort: effort ?? null,
        model,
      },
      results,
      summaries,
      timeoutMs: options.timeoutMs,
    };

    await writeFile(options.outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.log(`\nFull JSON results written to ${options.outPath}`);
  }
}

await main();
