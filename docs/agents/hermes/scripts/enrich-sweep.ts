#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxCostEvent, emitCost, selfSecondsCost } from "./cost-emit";
import {
  databaseAdmissionYieldSummary,
  runDatabaseAdmissionPhase,
} from "./database-admission-phase";
import {
  dueWorkRepairPendingGate,
  dueWorkRepairPendingSummary,
  failureBodyUnlessRepairPending,
  isDueWorkRepairPending,
  throwIfCliRepairPending,
} from "./due-work-repair-pending";

const BATCH_CAP = 4;
const QUEUE_LIMIT = 50;

const CATALOGUE_BATCH_CAP = Number(process.env.FLUNCLE_ENRICH_CATALOGUE_BATCH ?? "2");

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

const ANALYZE_SCRIPT =
  process.env.FLUNCLE_ANALYZE_SCRIPT ??
  "/opt/hermes-skills/fluncle-track-enrichment/scripts/analyze-track.ts";

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";
const BUN_BIN = process.env.BUN_BIN ?? "bun";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const R2_ACCESS_KEY_ID = process.env.FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET = process.env.FLUNCLE_SOURCE_AUDIO_R2_BUCKET ?? "fluncle-source-audio";
const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const log = (message: string) => console.error(`[enrich-sweep] ${message}`);

type QueueFinding = {
  artists?: string[];
  isrc?: string;
  logId?: string;

  sourceAudioKey?: string;
  title?: string;
  trackId?: string;
};

type AnalyzeOutput = {
  bpm: number | null;
  bpmConfidence: number | null;
  bpmSource: string | null;
  features: Record<string, unknown>;
  key: string | null;
  keyConfidence: number | null;
  keySource: string | null;
};

type Outcome = "done" | "failed" | "skipped";

type EnrichArm = "catalogue" | "finding";

type EnrichReadState = Readonly<{
  catalogue: CatalogueWorkItem[];
  findings: QueueFinding[];
  queued: number;

  repairPending: EnrichArm | null;
}>;

type PreparedEnrich = Readonly<{
  arm: EnrichArm;
  cost: BoxCostEvent | null;
  outcome: Outcome;
  trackId: string;
  updateArgs: string[] | null;
}>;

type EnrichWriteResult = Readonly<{
  costWriteFailures: number;
  results: ReadonlyArray<
    Readonly<{ arm: EnrichArm; outcome: Outcome; trackId: string; writeFailed: boolean }>
  >;
}>;

function run(bin: string, args: string[]): { code: number; stderr: string; stdout: string } {
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  if (result.error) {
    throw new Error(`failed to spawn ${bin}: ${result.error.message}`);
  }

  return {
    code: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function fluncleJson<T>(args: string[]): T {
  const { code, stderr, stdout } = run(FLUNCLE_BIN, [...args, "--json"]);

  if (code !== 0) {
    throwIfCliRepairPending(`fluncle ${args.join(" ")}`, code, stdout);
    throw new Error(`fluncle ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`fluncle ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
  }
}

export function buildAnalyzeArgs(
  script: string,
  fields: { artist: string; audioFilePath?: string; isrc?: string; title: string },
): string[] {
  const args = [script, "--artist", fields.artist, "--title", fields.title];

  if (fields.isrc) {
    args.push("--isrc", fields.isrc);
  }

  if (fields.audioFilePath) {
    args.push("--audio-file", fields.audioFilePath);
  }

  return args;
}

export function extFromKey(key: string): string {
  const base = key.slice(key.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");

  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "bin";
}

const encoder = new TextEncoder();

function webCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function toHex(buffer: ArrayBuffer): string {
  let hex = "";
  for (const byte of new Uint8Array(buffer)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = webCryptoBytes(typeof data === "string" ? encoder.encode(data) : data);
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key instanceof ArrayBuffer ? key : webCryptoBytes(key),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalUri(pathname: string): string {
  return pathname.split("/").map(encodeRfc3986).join("/");
}

async function signS3Request(options: {
  accessKeyId: string;
  body?: Uint8Array;
  contentType?: string;
  method: string;
  now: Date;
  region: string;
  secretAccessKey: string;
  service: string;
  url: string;
}): Promise<Record<string, string>> {
  const url = new URL(options.url);
  const stamp = options.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = stamp.slice(0, 8);
  const payloadHash = await sha256Hex(options.body ?? new Uint8Array());
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
  };
  if (options.contentType) {
    headers["content-type"] = options.contentType;
  }
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    options.method,
    canonicalUri(url.pathname),
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(canonicalRequest)].join(
    "\n",
  );
  let signingKey: ArrayBuffer | Uint8Array = encoder.encode(`AWS4${options.secretAccessKey}`);
  for (const part of [dateStamp, options.region, options.service, "aws4_request"]) {
    signingKey = await hmac(signingKey, part);
  }
  const signature = toHex(await hmac(signingKey, stringToSign));
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function r2Get(key: string): Promise<Uint8Array> {
  const url = `${R2_ENDPOINT}/${R2_BUCKET}/${encodeKey(key)}`;
  const headers = await signS3Request({
    accessKeyId: R2_ACCESS_KEY_ID,
    method: "GET",
    now: new Date(),
    region: "auto",
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: "s3",
    url,
  });
  const res = await fetch(url, { headers, method: "GET" });
  if (!res.ok) {
    throw new Error(`R2 GET ${key} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

function findingUpdateArgs(parsed: AnalyzeOutput, analyzedFrom: "full" | "preview"): string[] {
  const updateArgs: string[] = [];

  if (parsed.bpm !== null && parsed.bpm !== undefined) {
    updateArgs.push("--bpm", String(parsed.bpm));
    if (parsed.bpmSource) {
      updateArgs.push("--bpm-source", parsed.bpmSource);
    }
    if (parsed.bpmConfidence !== null && parsed.bpmConfidence !== undefined) {
      updateArgs.push("--bpm-confidence", String(parsed.bpmConfidence));
    }
  }

  if (parsed.key !== null && parsed.key !== undefined) {
    updateArgs.push("--key", parsed.key);
    if (parsed.keySource) {
      updateArgs.push("--key-source", parsed.keySource);
    }
    if (parsed.keyConfidence !== null && parsed.keyConfidence !== undefined) {
      updateArgs.push("--key-confidence", String(parsed.keyConfidence));
    }
  }

  updateArgs.push("--features", JSON.stringify(parsed.features ?? {}));
  updateArgs.push("--analyzed-from", analyzedFrom);
  updateArgs.push("--analyzed-at", new Date().toISOString());
  updateArgs.push("--status", "done");
  return updateArgs;
}

type CatalogueWorkItem = {
  artists?: string[];
  certified?: boolean;
  isrc?: null | string;
  sourceAudioKey?: null | string;
  title?: string;
  trackId?: string;
};

async function fetchCatalogueAnalyzeQueue(): Promise<CatalogueWorkItem[]> {
  const url = `${API_BASE_URL}/api/v1/admin/tracks/work?kind=analyze&scope=catalogue&limit=${QUEUE_LIMIT}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },

    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await failureBodyUnlessRepairPending(res, "catalogue analyze queue read");
    throw new Error(`catalogue analyze queue read failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const body = (await res.json()) as { tracks?: CatalogueWorkItem[] };

  return Array.isArray(body.tracks) ? body.tracks : [];
}

function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function phaseCommand(phase: "read" | "write", statePath: string): string[] {
  return [
    process.execPath,
    import.meta.path,
    "--admission-phase",
    phase,
    "--phase-state",
    statePath,
  ];
}

async function runEnrichReadPhase(statePath: string): Promise<void> {
  let response: { tracks?: QueueFinding[] };
  try {
    response = fluncleJson<{ tracks?: QueueFinding[] }>([
      "admin",
      "tracks",
      "enrich",
      "--queue",
      "--limit",
      String(QUEUE_LIMIT),
    ]);
  } catch (error) {
    if (!isDueWorkRepairPending(error)) {
      throw error;
    }

    log(error.message);
    const deferred: EnrichReadState = {
      catalogue: [],
      findings: [],
      queued: 0,
      repairPending: "finding",
    };
    writeFileSync(statePath, JSON.stringify(deferred), "utf8");
    return;
  }
  const queue = response.tracks ?? [];
  const findings: QueueFinding[] = [];

  for (const finding of queue.slice(0, BATCH_CAP)) {
    const id = finding.trackId ?? finding.logId;
    if (!id) {
      findings.push(finding);
      continue;
    }

    const canonical = fluncleJson<QueueFinding>(["tracks", "get", id]);
    findings.push({
      ...finding,
      ...canonical,
      artists: canonical.artists ?? finding.artists,
      isrc: canonical.isrc ?? finding.isrc,
      logId: canonical.logId ?? finding.logId,
      sourceAudioKey: canonical.sourceAudioKey ?? finding.sourceAudioKey,
      title: canonical.title ?? finding.title,
      trackId: canonical.trackId ?? finding.trackId,
    });
  }

  let catalogue: CatalogueWorkItem[] = [];
  let repairPending: EnrichArm | null = null;
  if (API_TOKEN) {
    try {
      catalogue = (await fetchCatalogueAnalyzeQueue()).slice(0, CATALOGUE_BATCH_CAP);
    } catch (error) {
      if (isDueWorkRepairPending(error)) {
        repairPending = "catalogue";
      }
      log(`catalogue arm skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const state: EnrichReadState = { catalogue, findings, queued: queue.length, repairPending };
  writeFileSync(statePath, JSON.stringify(state), "utf8");
}

async function prepareFinding(finding: QueueFinding): Promise<PreparedEnrich> {
  const trackId = finding.trackId;
  const artist = finding.artists?.[0];
  const title = finding.title;
  const isrc = finding.isrc;
  const sourceAudioKey = finding.sourceAudioKey;

  if (!trackId || !artist || !title) {
    log(`${trackId ?? finding.logId ?? "?"}: missing trackId/artist/title — skipping`);
    return {
      arm: "finding",
      cost: null,
      outcome: "skipped",
      trackId: trackId ?? finding.logId ?? "unknown",
      updateArgs: null,
    };
  }

  let audioTmpDir: string | undefined;
  let audioFilePath: string | undefined;
  if (sourceAudioKey) {
    try {
      const bytes = await r2Get(sourceAudioKey);
      audioTmpDir = mkdtempSync(join(tmpdir(), "fluncle-enrich-src-"));
      audioFilePath = join(audioTmpDir, `source.${extFromKey(sourceAudioKey)}`);
      writeFileSync(audioFilePath, bytes);
      log(`${trackId}: analyzing captured full song (${sourceAudioKey})`);
    } catch (error) {
      if (audioTmpDir) {
        rmSync(audioTmpDir, { force: true, recursive: true });
      }
      audioTmpDir = undefined;
      audioFilePath = undefined;
      log(
        `${trackId}: source-audio GET failed (${sourceAudioKey}) — falling back to preview: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  try {
    const analyzeStart = Date.now();
    const analysis = run(
      BUN_BIN,
      buildAnalyzeArgs(ANALYZE_SCRIPT, { artist, audioFilePath, isrc, title }),
    );
    const cost = selfSecondsCost({
      logId: finding.logId ?? null,
      occurredAt: new Date().toISOString(),
      seconds: (Date.now() - analyzeStart) / 1000,
      step: "enrich",
      trackId,
    });

    if (analysis.code === 2) {
      log(`${trackId}: no audio available → status=failed`);
      return {
        arm: "finding",
        cost,
        outcome: "failed",
        trackId,
        updateArgs: ["admin", "tracks", "update", trackId, "--status", "failed"],
      };
    }
    if (analysis.code !== 0) {
      log(`${trackId}: analyze-track exited ${analysis.code} — leaving queued`);
      return { arm: "finding", cost, outcome: "skipped", trackId, updateArgs: null };
    }

    let parsed: AnalyzeOutput;
    try {
      parsed = JSON.parse(analysis.stdout) as AnalyzeOutput;
    } catch {
      log(`${trackId}: analyze-track did not return JSON — leaving queued`);
      return { arm: "finding", cost, outcome: "skipped", trackId, updateArgs: null };
    }

    const analyzedFrom = audioFilePath ? "full" : "preview";
    return {
      arm: "finding",
      cost,
      outcome: "done",
      trackId,
      updateArgs: [
        "admin",
        "tracks",
        "update",
        trackId,
        ...findingUpdateArgs(parsed, analyzedFrom),
      ],
    };
  } finally {
    if (audioTmpDir) {
      rmSync(audioTmpDir, { force: true, recursive: true });
    }
  }
}

async function prepareCatalogue(item: CatalogueWorkItem): Promise<PreparedEnrich> {
  const trackId = item.trackId;
  const artist = item.artists?.[0];
  const title = item.title;
  const sourceAudioKey = item.sourceAudioKey;
  if (!trackId || !artist || !title || !sourceAudioKey) {
    log(`${trackId ?? "?"}: incomplete catalogue work item — leaving queued`);
    return {
      arm: "catalogue",
      cost: null,
      outcome: "skipped",
      trackId: trackId ?? "unknown",
      updateArgs: null,
    };
  }

  const directory = mkdtempSync(join(tmpdir(), "fluncle-enrich-cat-"));
  try {
    const audioFilePath = join(directory, `source.${extFromKey(sourceAudioKey)}`);
    writeFileSync(audioFilePath, await r2Get(sourceAudioKey));
    const analyzeStart = Date.now();
    const analysis = run(
      BUN_BIN,
      buildAnalyzeArgs(ANALYZE_SCRIPT, {
        artist,
        audioFilePath,
        isrc: item.isrc ?? undefined,
        title,
      }),
    );
    const cost = selfSecondsCost({
      logId: null,
      occurredAt: new Date().toISOString(),
      seconds: (Date.now() - analyzeStart) / 1000,
      step: "enrich",
      trackId,
    });
    if (analysis.code !== 0) {
      log(`${trackId}: analyze-track exited ${analysis.code} — leaving queued`);
      return { arm: "catalogue", cost, outcome: "skipped", trackId, updateArgs: null };
    }

    let parsed: AnalyzeOutput;
    try {
      parsed = JSON.parse(analysis.stdout) as AnalyzeOutput;
    } catch {
      log(`${trackId}: analyze-track did not return JSON — leaving queued`);
      return { arm: "catalogue", cost, outcome: "skipped", trackId, updateArgs: null };
    }

    const updateArgs = ["admin", "tracks", "update", trackId];
    if (parsed.bpm !== null && parsed.bpm !== undefined) {
      updateArgs.push("--bpm", String(parsed.bpm));
      if (parsed.bpmSource) {
        updateArgs.push("--bpm-source", parsed.bpmSource);
      }
      if (parsed.bpmConfidence !== null && parsed.bpmConfidence !== undefined) {
        updateArgs.push("--bpm-confidence", String(parsed.bpmConfidence));
      }
    }
    if (parsed.key !== null && parsed.key !== undefined) {
      updateArgs.push("--key", parsed.key);
      if (parsed.keySource) {
        updateArgs.push("--key-source", parsed.keySource);
      }
      if (parsed.keyConfidence !== null && parsed.keyConfidence !== undefined) {
        updateArgs.push("--key-confidence", String(parsed.keyConfidence));
      }
    }
    updateArgs.push(
      "--features",
      JSON.stringify(parsed.features ?? {}),
      "--analyzed-from",
      "full",
      "--analyzed-at",
      new Date().toISOString(),
    );
    return { arm: "catalogue", cost, outcome: "done", trackId, updateArgs };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

async function runEnrichWritePhase(statePath: string): Promise<void> {
  const prepared = readJsonFile<PreparedEnrich[]>(statePath);
  const results: Array<{
    arm: EnrichArm;
    outcome: Outcome;
    trackId: string;
    writeFailed: boolean;
  }> = [];
  const costs: BoxCostEvent[] = [];

  for (const item of prepared) {
    let writeFailed = false;
    if (item.updateArgs) {
      try {
        fluncleJson(item.updateArgs);
      } catch (error) {
        writeFailed = true;
        log(
          `write failed for ${item.trackId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!writeFailed && item.cost) {
      costs.push(item.cost);
    }
    results.push({
      arm: item.arm,
      outcome: writeFailed ? "skipped" : item.outcome,
      trackId: item.trackId,
      writeFailed,
    });
  }

  const costWriteFailures = (await emitCost(costs)).failed;
  const result: EnrichWriteResult = { costWriteFailures, results };
  writeFileSync(`${statePath}.result`, JSON.stringify(result), "utf8");
}

async function runPhasedEnrichMain(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "enrich-phases-"));
  const readStatePath = join(directory, "read.json");

  try {
    const readPhase = runDatabaseAdmissionPhase({
      command: phaseCommand("read", readStatePath),
      owner: "fluncle-enrich",
      yieldRetries: 0,
    });
    if (readPhase.kind === "yielded") {
      console.log(
        JSON.stringify(
          databaseAdmissionYieldSummary({ checked: 0, queueDepth: null, queued: null }),
        ),
      );
      return;
    }

    const state = readJsonFile<EnrichReadState>(readStatePath);
    if (state.repairPending === "finding") {
      console.log(
        JSON.stringify(dueWorkRepairPendingSummary({ checked: 0, queueDepth: null, queued: null })),
      );
      return;
    }

    const withCatalogueDeferral = (line: Record<string, unknown>): Record<string, unknown> =>
      state.repairPending === "catalogue" ? { ...line, ...dueWorkRepairPendingGate(line) } : line;
    const summary = {
      batch: state.findings.length,
      catalogueDone: 0,
      checked: 0,
      done: 0,
      errors: 0,
      failed: 0,
      produced: 0,
      queued: state.queued,
      skipped: 0,
    };
    const prepared: PreparedEnrich[] = [];

    for (const finding of state.findings) {
      summary.checked += 1;
      try {
        prepared.push(await prepareFinding(finding));
      } catch (error) {
        summary.skipped += 1;
        summary.failed += 1;
        log(
          `error on ${finding.trackId ?? finding.logId ?? "?"}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    for (const item of state.catalogue) {
      summary.checked += 1;
      try {
        prepared.push(await prepareCatalogue(item));
      } catch (error) {
        summary.skipped += 1;
        summary.failed += 1;
        log(
          `error on catalogue ${item.trackId ?? "?"}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (prepared.length === 0) {
      console.log(
        JSON.stringify(withCatalogueDeferral({ costWriteFailures: 0, ok: true, ...summary })),
      );
      return;
    }

    const writeStatePath = join(directory, "write.json");
    writeFileSync(writeStatePath, JSON.stringify(prepared), "utf8");
    const writePhase = runDatabaseAdmissionPhase({
      command: phaseCommand("write", writeStatePath),
      owner: "fluncle-enrich",

      yieldRetries: 0,
    });
    if (writePhase.kind === "yielded") {
      console.log(
        JSON.stringify(
          databaseAdmissionYieldSummary({
            ...summary,
            produced: 0,
            writesPending: prepared.length,
          }),
        ),
      );
      return;
    }

    const writeResult = readJsonFile<EnrichWriteResult>(`${writeStatePath}.result`);
    for (const result of writeResult.results) {
      if (result.writeFailed) {
        summary.failed += 1;
        summary.skipped += 1;
      } else if (result.arm === "catalogue") {
        if (result.outcome === "done") {
          summary.catalogueDone += 1;
          summary.produced += 1;
        } else {
          summary.skipped += 1;
        }
      } else {
        summary[result.outcome] += 1;
        if (result.outcome === "done") {
          summary.produced += 1;
        }
      }
    }
    console.log(
      JSON.stringify(
        withCatalogueDeferral({
          costWriteFailures: writeResult.costWriteFailures,
          ok: true,
          ...summary,
        }),
      ),
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const admissionPhase = argumentValue(argv, "--admission-phase");
  const phaseStatePath = argumentValue(argv, "--phase-state");

  if (admissionPhase) {
    if (!phaseStatePath || (admissionPhase !== "read" && admissionPhase !== "write")) {
      throw new Error("invalid enrich admission phase invocation");
    }
    if (admissionPhase === "read") {
      await runEnrichReadPhase(phaseStatePath);
    } else {
      await runEnrichWritePhase(phaseStatePath);
    }
    return;
  }

  await runPhasedEnrichMain();
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`enrich sweep failed: ${message}`);

    console.log(JSON.stringify({ error: message, errors: 1, ok: false, reason: "enrich_failed" }));
    process.exit(1);
  });
}
