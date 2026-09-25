#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";
const EMBED_SCRIPT =
  process.env.FLUNCLE_EMBED_SCRIPT ?? new URL("embed-track.py", import.meta.url).pathname;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const R2_ACCESS_KEY_ID = process.env.FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET = process.env.FLUNCLE_SOURCE_AUDIO_R2_BUCKET ?? "fluncle-source-audio";
const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const DOWNLOAD_CONCURRENCY = Number(process.env.FLUNCLE_EMBED_DOWNLOAD_CONCURRENCY ?? "6");

export const MAX_QUEUE_LIMIT = 200;

export const MAX_PAGE = 100;

export const DEFAULT_MINUTES = 55;

export const FIRST_PAGE_TRACK_MS = Number(process.env.FLUNCLE_EMBED_FIRST_PAGE_TRACK_MS ?? "60000");

export const CALIBRATION_TRACKS = Math.max(
  1,
  Number(process.env.FLUNCLE_EMBED_CALIBRATION_TRACKS ?? "1"),
);

export const SAFETY_FACTOR = Number(process.env.FLUNCLE_EMBED_SAFETY_FACTOR ?? "1.25");

const log = (message: string) => console.error(`[embed-batch] ${message}`);

export type WorkItem = {
  artists?: string[];
  certified?: boolean;
  logId?: null | string;
  sourceAudioKey?: null | string;
  title?: string;
  trackId?: string;
};

export type EmbedResult = { embedding: number[]; id: string };
export type EmbedError = { error: string; id: string };
export type EmbedOutput = { errors?: EmbedError[]; results?: EmbedResult[] };

export type BatchArgs = {
  dryRun: boolean;

  limit: number;
  minutes: number;
  scope: "all" | "catalogue" | "findings";
};

export type PageAudio = {
  entries: Array<{ id: string; path: string }>;
  workdir: string;
};

export type QueuePage = {
  debtPending?: boolean;

  queued?: number;
  tracks: WorkItem[];
};

export type StopReason = "budget_spent" | "embed_failed" | "queue_blocked" | "queue_dry";

export type BatchSummary = {
  abandoned: number;
  catalogue: number;
  downloadFailed: number;
  downloaded: number;

  embedded: number;

  failed: number;
  findings: number;
  minutes: number;
  pages: number;

  remaining: null | number;
  scope: string;
  stopReason: StopReason;
  tracksPerMinute: number;
  writeFailed: number;
};

export type BatchDeps = {
  discard: (audio: PageAudio) => void;
  download: (items: WorkItem[], workdir: string) => Promise<PageAudio["entries"]>;
  embed: (audio: PageAudio) => Promise<EmbedOutput>;
  fetchQueue: (options: { count: boolean; limit: number }) => Promise<QueuePage>;
  log: (message: string) => void;
  mkWorkdir: () => string;
  now: () => number;
  write: (trackId: string, embedding: number[]) => Promise<void>;
};

export class EmbedScriptError extends Error {}

export function parseBatchArgs(argv: string[]): BatchArgs {
  const args: BatchArgs = {
    dryRun: false,
    limit: MAX_PAGE,
    minutes: envMinutes(),
    scope: "all",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--limit") {
      const value = Number(argv[index + 1]);

      if (Number.isFinite(value) && value > 0) {
        args.limit = Math.min(Math.trunc(value), MAX_PAGE);
      }

      index += 1;
    } else if (arg === "--minutes") {
      const value = Number(argv[index + 1]);

      if (Number.isFinite(value) && value > 0) {
        args.minutes = Math.trunc(value);
      }

      index += 1;
    } else if (arg === "--scope") {
      const value = argv[index + 1];

      if (value === "all" || value === "catalogue" || value === "findings") {
        args.scope = value;
      }

      index += 1;
    }
  }

  return args;
}

function envMinutes(): number {
  const value = Number(process.env.FLUNCLE_EMBED_RUN_MINUTES ?? "");

  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : DEFAULT_MINUTES;
}

export function sourceAudioExt(key: string): string {
  const base = key.slice(key.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");

  if (dot <= 0 || dot === base.length - 1) {
    return ".audio";
  }

  return base.slice(dot).toLowerCase();
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<null | R>> {
  const results: Array<null | R> = Array.from({ length: items.length }, () => null);
  const width = Math.max(1, Math.trunc(concurrency));
  let next = 0;

  async function pump(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;

      if (index >= items.length) {
        return;
      }

      const item = items[index];

      if (item === undefined) {
        continue;
      }

      try {
        results[index] = await worker(item);
      } catch {
        results[index] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(width, items.length) }, () => pump()));

  return results;
}

export function affordableTracks(options: {
  at: number;
  deadline: number;
  page: number;
  perTrackMs: number;
}): number {
  const left = options.deadline - options.at;

  if (left <= 0 || options.perTrackMs <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(options.page, Math.floor(left / options.perTrackMs)));
}

export async function runBatch(args: BatchArgs, deps: BatchDeps): Promise<BatchSummary> {
  const startedAt = deps.now();
  const deadline = startedAt + args.minutes * 60_000;

  const claimed = new Set<string>();

  const summary: BatchSummary = {
    abandoned: 0,
    catalogue: 0,
    downloadFailed: 0,
    downloaded: 0,
    embedded: 0,
    failed: 0,
    findings: 0,
    minutes: 0,
    pages: 0,
    remaining: null,
    scope: args.scope,
    stopReason: "queue_dry",
    tracksPerMinute: 0,
    writeFailed: 0,
  };

  let pageMs = 0;
  let pageTracks = 0;
  let queueStop: null | StopReason = null;

  const perTrackMs = (): number =>
    pageTracks > 0 ? (pageMs / pageTracks) * SAFETY_FACTOR : FIRST_PAGE_TRACK_MS;

  const calibrated = (): boolean => pageTracks > 0;

  const affordable = (at: number): number =>
    affordableTracks({ at, deadline, page: args.limit, perTrackMs: perTrackMs() });

  const nextPageSize = (at: number): number =>
    Math.min(affordable(at), calibrated() ? args.limit : CALIBRATION_TRACKS);

  async function claimPage(desired: number): Promise<null | PageAudio> {
    const want = Math.max(1, Math.min(desired, args.limit));
    const readLimit = Math.min(MAX_QUEUE_LIMIT, claimed.size + want);
    const { tracks } = await deps.fetchQueue({ count: false, limit: readLimit });

    const fresh = tracks
      .filter(
        (item): item is WorkItem & { sourceAudioKey: string; trackId: string } =>
          Boolean(item.trackId) && Boolean(item.sourceAudioKey) && !claimed.has(item.trackId ?? ""),
      )
      .slice(0, want);

    if (fresh.length === 0) {
      queueStop = tracks.length > 0 ? "queue_blocked" : "queue_dry";

      return null;
    }

    for (const item of fresh) {
      claimed.add(item.trackId);

      if (item.certified) {
        summary.findings += 1;
      } else {
        summary.catalogue += 1;
      }
    }

    const workdir = deps.mkWorkdir();
    const entries = await deps.download(fresh, workdir);

    summary.downloadFailed += fresh.length - entries.length;
    summary.downloaded += entries.length;

    return { entries, workdir };
  }

  async function embedPage(audio: PageAudio): Promise<void> {
    const at = deps.now();
    const output = await deps.embed(audio);

    for (const result of output.results ?? []) {
      try {
        await deps.write(result.id, result.embedding);
        summary.embedded += 1;
      } catch (error) {
        summary.writeFailed += 1;
        deps.log(
          `${result.id}: write-back failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    for (const failure of output.errors ?? []) {
      summary.failed += 1;
      deps.log(`${failure.id}: embed error — ${failure.error}`);
    }

    pageMs += deps.now() - at;
    pageTracks += audio.entries.length;
  }

  const finish = async (stopReason: StopReason): Promise<BatchSummary> => {
    try {
      const { queued } = await deps.fetchQueue({ count: true, limit: 1 });

      summary.remaining = queued ?? null;
    } catch (error) {
      deps.log(`remaining count failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const minutes = (deps.now() - startedAt) / 60_000;

    summary.stopReason = stopReason;
    summary.minutes = Math.round(minutes * 10) / 10;
    summary.tracksPerMinute =
      minutes > 0 ? Math.round((summary.embedded / minutes) * 100) / 100 : 0;

    return summary;
  };

  let pending: null | Promise<null | PageAudio> = null;

  let prefetched = false;

  const dropPending = async (): Promise<void> => {
    if (pending === null) {
      return;
    }

    await pending.then(
      (orphan) => {
        if (orphan) {
          summary.abandoned += orphan.entries.length;
          deps.discard(orphan);
        }
      },
      () => undefined,
    );

    pending = null;
  };

  for (;;) {
    if (pending === null) {
      const size = nextPageSize(deps.now());

      if (size === 0) {
        return await finish("budget_spent");
      }

      pending = claimPage(size);
    }

    let page: null | PageAudio;

    try {
      page = await pending;
    } catch (error) {
      deps.log(`queue read failed: ${error instanceof Error ? error.message : String(error)}`);

      return await finish("queue_blocked");
    }

    pending = null;

    if (page === null) {
      if (prefetched) {
        prefetched = false;
        queueStop = null;
        continue;
      }

      return await finish(queueStop ?? "queue_dry");
    }

    prefetched = false;

    if (page.entries.length === 0) {
      deps.discard(page);
      continue;
    }

    summary.pages += 1;

    const allowed = affordable(deps.now());

    if (allowed === 0) {
      summary.abandoned += page.entries.length;
      deps.discard(page);

      return await finish("budget_spent");
    }

    const trimmed = allowed < page.entries.length;
    const entries = trimmed ? page.entries.slice(0, allowed) : page.entries;

    if (trimmed) {
      summary.abandoned += page.entries.length - entries.length;
      deps.log(`budget: trimming this page to ${entries.length} track(s) — the hour is nearly up`);
    }

    if (!trimmed && calibrated()) {
      const projectedEnd = deps.now() + entries.length * perTrackMs();
      const next = nextPageSize(projectedEnd);

      pending = next > 0 ? claimPage(next) : null;
      prefetched = pending !== null;
    }

    try {
      await embedPage({ entries, workdir: page.workdir });
    } catch (error) {
      deps.discard(page);
      deps.log(`embed step failed: ${error instanceof Error ? error.message : String(error)}`);
      await dropPending();

      return await finish(error instanceof EmbedScriptError ? "embed_failed" : "queue_blocked");
    }

    deps.discard(page);

    if (trimmed) {
      return await finish("budget_spent");
    }

    deps.log(
      `page ${summary.pages}: ${summary.embedded} embedded · ${Math.max(0, Math.round((deadline - deps.now()) / 60_000))} min left · ~${Math.round(perTrackMs() / 1000)}s/track`,
    );
  }
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

async function signS3Get(url: string): Promise<Record<string, string>> {
  const parsed = new URL(url);
  const now = new Date();
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = stamp.slice(0, 8);
  const payloadHash = await sha256Hex(new Uint8Array());
  const headers: Record<string, string> = {
    host: parsed.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    "GET",
    canonicalUri(parsed.pathname),
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(canonicalRequest)].join(
    "\n",
  );

  let signingKey: ArrayBuffer | Uint8Array = encoder.encode(`AWS4${R2_SECRET_ACCESS_KEY}`);

  for (const part of [dateStamp, "auto", "s3", "aws4_request"]) {
    signingKey = await hmac(signingKey, part);
  }

  const signature = toHex(await hmac(signingKey, stringToSign));
  const { host: _host, ...sent } = headers;

  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function r2Get(key: string): Promise<Uint8Array> {
  const url = `${R2_ENDPOINT}/${R2_BUCKET}/${encodeKey(key)}`;
  const res = await fetch(url, { headers: await signS3Get(url), method: "GET" });

  if (!res.ok) {
    throw new Error(`R2 GET ${key} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  return new Uint8Array(await res.arrayBuffer());
}

async function fetchEmbedQueue(
  scope: BatchArgs["scope"],
  options: { count: boolean; limit: number },
): Promise<QueuePage> {
  const params = new URLSearchParams({
    kind: "embed",
    limit: String(Math.min(Math.max(1, options.limit), MAX_QUEUE_LIMIT)),
    scope,
  });

  if (options.count) {
    params.set("count", "true");
    params.set("debtAware", "true");
  }

  const res = await fetch(`${API_BASE_URL}/api/v1/admin/tracks/work?${params.toString()}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`embed queue read failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  const body = (await res.json()) as QueuePage;

  if (body.debtPending === true) {
    throw new Error("embed queue read deferred: due-work repair is still converging");
  }

  return { queued: body.queued, tracks: Array.isArray(body.tracks) ? body.tracks : [] };
}

async function writeEmbedding(trackId: string, embedding: number[]): Promise<void> {
  const url = `${API_BASE_URL}/api/v1/admin/tracks/${encodeURIComponent(trackId)}`;
  const res = await fetch(url, {
    body: JSON.stringify({ embedding }),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "content-type": "application/json",
    },
    method: "PATCH",
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(
      `update_track ${trackId} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
}

function runEmbedScript(audio: PageAudio): Promise<EmbedOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [EMBED_SCRIPT], { stdio: ["pipe", "pipe", "inherit"] });
    let stdout = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.on("error", (error) => reject(new EmbedScriptError(String(error))));

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new EmbedScriptError(`embed-track exited ${code}`));

        return;
      }

      try {
        resolve(JSON.parse(stdout) as EmbedOutput);
      } catch {
        reject(new EmbedScriptError(`embed-track did not return JSON: ${stdout.slice(0, 200)}`));
      }
    });

    child.stdin.end(JSON.stringify(audio.entries));
  });
}

function podDeps(args: BatchArgs): BatchDeps {
  return {
    discard: (audio) => rmSync(audio.workdir, { force: true, recursive: true }),
    download: async (items, workdir) => {
      const downloaded = await mapWithConcurrency(items, DOWNLOAD_CONCURRENCY, async (item) => {
        const key = item.sourceAudioKey;
        const id = item.trackId;

        if (!key || !id) {
          return null;
        }

        const path = join(workdir, `${id}${sourceAudioExt(key)}`);
        writeFileSync(path, await r2Get(key));

        return { id, path };
      });

      return downloaded.filter((entry): entry is { id: string; path: string } => entry !== null);
    },
    embed: runEmbedScript,
    fetchQueue: (options) => fetchEmbedQueue(args.scope, options),
    log,
    mkWorkdir: () => mkdtempSync(join(tmpdir(), "fluncle-embed-batch-")),
    now: () => Date.now(),
    write: writeEmbedding,
  };
}

async function main(): Promise<void> {
  const args = parseBatchArgs(process.argv.slice(2));

  if (!API_TOKEN) {
    console.log(JSON.stringify({ ok: false, reason: "missing_api_token" }));
    process.exitCode = 1;

    return;
  }

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.log(JSON.stringify({ ok: false, reason: "missing_r2_credentials" }));
    process.exitCode = 1;

    return;
  }

  if (args.dryRun) {
    const { queued, tracks } = await fetchEmbedQueue(args.scope, {
      count: true,
      limit: args.limit,
    });

    log(`dry run — ${queued ?? "?"} track(s) queued (${args.scope})`);
    log(`  budget ${args.minutes} min · page ${args.limit} · first page assumes`);
    log(`  ${Math.round(FIRST_PAGE_TRACK_MS / 1000)}s/track until the run measures the real rate`);

    for (const item of tracks) {
      log(
        `  ${item.logId ?? `${item.trackId} · catalogue`} — ${(item.artists ?? []).join(", ")} — ${item.title ?? "?"}`,
      );
    }

    console.log(
      JSON.stringify({
        dryRun: true,
        minutes: args.minutes,
        ok: true,
        page: args.limit,
        queued: queued ?? null,
        scope: args.scope,
      }),
    );

    return;
  }

  log(`run: ${args.minutes} min budget · page ${args.limit} · scope ${args.scope}`);

  const deps = podDeps(args);
  const summary = await runBatch(args, deps);

  log(
    summary.remaining === 0
      ? `done — the ${args.scope} embed queue is drained.`
      : `${summary.remaining ?? "?"} still queued. ${summary.stopReason === "budget_spent" ? "Rent another block to keep going." : ""}`,
  );

  console.log(JSON.stringify({ ok: summary.stopReason !== "embed_failed", ...summary }));

  if (summary.stopReason === "embed_failed") {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    console.log(JSON.stringify({ ok: false, reason: "fatal" }));
    process.exitCode = 1;
  });
}
