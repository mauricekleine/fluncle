#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDatabaseAdmissionPhaseAsync } from "./database-admission-phase";
import {
  addInto,
  EMBEDDING_DIMENSIONS,
  isDrumAndBassTagged,
  type LabelGroup,
  type LabelOutlierRun,
  type OutlierTrack,
  scoreCatalogue,
} from "./label-outliers";

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";
const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;

const RECORD_PATH = "/api/v1/admin/label-outliers";
const BOARD_URL = "https://www.fluncle.com/admin/label-outliers";
const ADMISSION_OWNER = "fluncle-label-outliers";
const MAX_RECORDED_OUTLIERS = 2000;
const EMBEDDING_BYTES = EMBEDDING_DIMENSIONS * 4;
const LOCK_STALE_MS = 15 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 60 * 1000;
const LOCK_POLL_MS = 15 * 1000;
const LOCK_WAIT_MS = 20 * 60 * 1000;
const DISCORD_NAME_LIMIT = 8;

const log = (message: string) => console.error(`[label-outliers-sweep] ${message}`);

export type RecordedOutlier = {
  albumId: string | null;
  artistSupport: number;
  fingerprint: string;
  labelId: string | null;
  reference: "catalogue" | "label";
  referenceMedian: number;
  score: number;
  singleTrackId: string | null;
  trackCount: number;
  unitId: string;
  z: number;
};

export type RecordPayload = {
  labelsScored: number;
  outliers: RecordedOutlier[];
  replicaSyncedAt: string | null;
  tracksScored: number;
  unitsScored: number;
};

export type NewlyFlagged = { albumName: string | null; labelName: string | null; title: string };

export type RecordResponse = {
  flagged?: number;
  newlyFlagged?: NewlyFlagged[];
  newlyFlaggedCount?: number;
  ok?: boolean;
  removed?: number;
};

export type LabelOutliersSummary = {
  checked: null | number;
  elapsedMs?: number;
  error?: string;
  errors: number;
  flagged: null | number;
  labelsScored: null | number;
  newlyFlagged: null | number;
  notified: boolean;
  ok: boolean;
  payloadStarted: boolean;
  produced: null | number;
  reason?: string;
  replicaSyncedAt: null | string;
  tracksScored: null | number;
};

export function emptySummary(): LabelOutliersSummary {
  return {
    checked: null,
    errors: 0,
    flagged: null,
    labelsScored: null,
    newlyFlagged: null,
    notified: false,
    ok: true,
    payloadStarted: false,
    produced: null,
    replicaSyncedAt: null,
    tracksScored: null,
  };
}

export function toPayload(run: LabelOutlierRun, replicaSyncedAt: string | null): RecordPayload {
  return {
    labelsScored: run.labelsScored,
    outliers: run.flagged.slice(0, MAX_RECORDED_OUTLIERS).map((unit) => ({
      albumId: unit.albumId,
      artistSupport: unit.artistSupport,
      fingerprint: unit.fingerprint,
      labelId: unit.labelId,
      reference: unit.reference,
      referenceMedian: round(unit.referenceMedian),
      score: round(unit.score),
      singleTrackId: unit.singleTrackId,
      trackCount: unit.trackCount,
      unitId: unit.unitId,
      z: round(unit.z),
    })),
    replicaSyncedAt,
    tracksScored: run.tracksScored,
    unitsScored: run.unitsScored,
  };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function discordMessage(
  newlyFlagged: readonly NewlyFlagged[],
  count: number,
  total: number,
): string {
  const named = newlyFlagged.slice(0, DISCORD_NAME_LIMIT);
  const names = named.map((item) => {
    const where = item.labelName ? ` on ${item.labelName}` : "";

    return `• ${item.albumName ?? item.title}${where}`;
  });
  const more = count > named.length ? [`…and ${count - named.length} more`] : [];

  return [
    `Label outliers: ${count} new to review (${total} on the board).`,
    ...names,
    ...more,
    BOARD_URL,
  ].join("\n");
}

export function readEmbedding(blob: unknown): Float32Array | null {
  if (!(blob instanceof Uint8Array) || blob.byteLength !== EMBEDDING_BYTES) {
    return null;
  }

  const copy = new Uint8Array(EMBEDDING_BYTES);
  copy.set(blob);

  return new Float32Array(copy.buffer);
}

const CATALOGUE_EMBEDDED = `from tracks t
  join track_embeddings e on e.track_id = t.track_id
  where t.is_catalogue = 1`;

export type ReplicaInputs = {
  artistsByTrack: Map<string, string[]>;
  dnbTaggedAlbumIds: Set<string>;
  globalSum: Float64Array;
  groups: () => Iterable<LabelGroup>;
};

export function readReplicaInputs(database: Database): ReplicaInputs {
  const globalSum = new Float64Array(EMBEDDING_DIMENSIONS);

  for (const row of database
    .query<{ embedding_blob: unknown }, []>(`select e.embedding_blob ${CATALOGUE_EMBEDDED}`)
    .iterate()) {
    const vector = readEmbedding(row.embedding_blob);

    if (vector) {
      addInto(globalSum, vector);
    }
  }

  const artistsByTrack = new Map<string, string[]>();

  for (const row of database
    .query<{ artist_id: string; track_id: string }, []>(
      `select ta.track_id, ta.artist_id from track_artists ta
         join tracks t on t.track_id = ta.track_id
        where t.is_catalogue = 1 and t.has_embedding = 1`,
    )
    .iterate()) {
    const list = artistsByTrack.get(row.track_id) ?? [];
    list.push(row.artist_id);
    artistsByTrack.set(row.track_id, list);
  }

  const dnbTaggedAlbumIds = new Set<string>();

  for (const row of database
    .query<{ discogs_styles: string | null; id: string }, []>(
      "select id, discogs_styles from albums where discogs_styles is not null",
    )
    .iterate()) {
    if (isDrumAndBassTagged(row.discogs_styles)) {
      dnbTaggedAlbumIds.add(row.id);
    }
  }

  const labelIds = database
    .query<{ label_id: string | null }, []>(
      `select distinct t.label_id as label_id ${CATALOGUE_EMBEDDED}`,
    )
    .all()
    .map((row) => row.label_id);

  const labeled = database.query<
    { album_id: string | null; embedding_blob: unknown; track_id: string },
    [string]
  >(`select t.track_id, t.album_id, e.embedding_blob ${CATALOGUE_EMBEDDED} and t.label_id = ?`);
  const unlabeled = database.query<
    { album_id: string | null; embedding_blob: unknown; track_id: string },
    []
  >(`select t.track_id, t.album_id, e.embedding_blob ${CATALOGUE_EMBEDDED} and t.label_id is null`);

  function* groups(): Generator<LabelGroup> {
    for (const labelId of labelIds) {
      const rows = labelId === null ? unlabeled.all() : labeled.all(labelId);
      const tracks: OutlierTrack[] = [];

      for (const row of rows) {
        const vector = readEmbedding(row.embedding_blob);

        if (vector) {
          tracks.push({ albumId: row.album_id, trackId: row.track_id, vector });
        }
      }

      yield { labelId, tracks };
    }
  }

  return { artistsByTrack, dnbTaggedAlbumIds, globalSum, groups };
}

export type ReplicaLock = { release: () => Promise<void> };

export async function acquireReplicaLock(
  lockDir: string,
  options: {
    now?: () => number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    waitMs?: number;
  } = {},
): Promise<ReplicaLock | null> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.waitMs ?? LOCK_WAIT_MS);

  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      const lockStat = await stat(lockDir).catch(() => undefined);

      if (lockStat && now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await rmdir(lockDir).catch(() => {});
        continue;
      }

      if (now() >= deadline) {
        return null;
      }

      await sleep(options.pollMs ?? LOCK_POLL_MS);
    }
  }

  const heartbeat = setInterval(() => {
    const stamp = new Date();
    utimes(lockDir, stamp, stamp).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();

  let released = false;

  return {
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      clearInterval(heartbeat);
      await rmdir(lockDir).catch((error: unknown) => {
        log(
          `could not release replica lock: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
  };
}

export type SweepDeps = {
  lock: () => Promise<ReplicaLock | null>;
  notify: (message: string) => Promise<boolean>;
  record: (
    payload: RecordPayload,
  ) => Promise<
    { kind: "recorded"; response: RecordResponse } | { kind: "yielded"; reason: string | null }
  >;
  score: () => Promise<{ replicaSyncedAt: string | null; run: LabelOutlierRun } | null>;
};

export async function runLabelOutliersSweep(deps: SweepDeps): Promise<LabelOutliersSummary> {
  const summary = emptySummary();
  const lock = await deps.lock();

  if (!lock) {
    return { ...summary, reason: "replica_busy" };
  }

  let scored: Awaited<ReturnType<SweepDeps["score"]>>;

  try {
    scored = await deps.score();
  } finally {
    await lock.release();
  }

  if (!scored) {
    return { ...summary, errors: 1, ok: false, reason: "replica_missing" };
  }

  summary.checked = scored.run.unitsScored;
  summary.labelsScored = scored.run.labelsScored;
  summary.tracksScored = scored.run.tracksScored;
  summary.replicaSyncedAt = scored.replicaSyncedAt;

  const payload = toPayload(scored.run, scored.replicaSyncedAt);
  const recorded = await deps.record(payload);

  if (recorded.kind === "yielded") {
    return {
      ...summary,
      reason: recorded.reason ? `admission_${recorded.reason}` : "admission_yield",
    };
  }

  summary.payloadStarted = true;

  const response = recorded.response;

  if (response.ok !== true || typeof response.flagged !== "number") {
    return { ...summary, error: "record_label_outliers returned no result", errors: 1, ok: false };
  }

  const newlyFlagged = Array.isArray(response.newlyFlagged) ? response.newlyFlagged : [];
  const newlyFlaggedCount =
    typeof response.newlyFlaggedCount === "number"
      ? response.newlyFlaggedCount
      : newlyFlagged.length;

  summary.flagged = response.flagged;
  summary.produced = payload.outliers.length;
  summary.newlyFlagged = newlyFlaggedCount;

  if (newlyFlaggedCount > 0) {
    summary.notified = await deps.notify(
      discordMessage(newlyFlagged, newlyFlaggedCount, response.flagged),
    );
  }

  return summary;
}

function replicaPath(): string {
  const home = process.env.HOME ?? "/opt/data/home";
  const stateDirectory = process.env.DEVICE_MIRROR_STATE_DIR ?? join(home, "device-mirror");

  return join(stateDirectory, "source-replica.db");
}

function replicaLockDir(): string {
  const home = process.env.HOME ?? "/opt/data/home";

  return process.env.DEVICE_MIRROR_LOCK_DIR ?? `${home}/.device-mirror.lock`;
}

async function scoreReplica(): Promise<{
  replicaSyncedAt: string | null;
  run: LabelOutlierRun;
} | null> {
  const path = replicaPath();
  const file = await stat(path).catch(() => undefined);

  if (!file) {
    log(`no device-mirror replica at ${path}`);
    return null;
  }

  const database = new Database(path, { readonly: true, strict: true });

  try {
    const inputs = readReplicaInputs(database);
    const run = scoreCatalogue({ ...inputs, groups: inputs.groups() });

    return { replicaSyncedAt: new Date(file.mtimeMs).toISOString(), run };
  } finally {
    database.close();
  }
}

async function postPayload(payload: RecordPayload): Promise<RecordResponse> {
  const response = await fetch(`${API_BASE_URL}${RECORD_PATH}`, {
    body: JSON.stringify(payload),
    headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
    method: "PUT",
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(
      `record_label_outliers failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
    );
  }

  return (await response.json()) as RecordResponse;
}

async function recordAdmitted(
  payload: RecordPayload,
): Promise<
  { kind: "recorded"; response: RecordResponse } | { kind: "yielded"; reason: string | null }
> {
  const directory = await mkdtemp(join(tmpdir(), "label-outliers-"));
  const file = join(directory, "payload.json");

  try {
    await writeFile(file, JSON.stringify(payload));
    const result = await runDatabaseAdmissionPhaseAsync({
      command: [
        process.execPath,
        import.meta.filename,
        "--admission-phase",
        "record",
        "--payload",
        file,
      ],
      owner: ADMISSION_OWNER,
      yieldRetries: 1,
    });

    if (result.kind === "yielded") {
      return { kind: "yielded", reason: result.yieldReason };
    }

    return { kind: "recorded", response: JSON.parse(result.stdout) as RecordResponse };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function notifyDiscord(content: string): Promise<boolean> {
  if (!DISCORD_ALERT_WEBHOOK) {
    return false;
  }

  try {
    const response = await fetch(DISCORD_ALERT_WEBHOOK, {
      body: JSON.stringify({ content }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      log(`discord post returned ${response.status} (best-effort, ignored)`);
    }

    return response.ok;
  } catch (error) {
    log(
      `discord post failed (best-effort, ignored): ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

async function main(): Promise<LabelOutliersSummary> {
  const started = Date.now();

  if (!API_TOKEN) {
    return { ...emptySummary(), errors: 1, ok: false, reason: "missing_api_token" };
  }

  const summary = await runLabelOutliersSweep({
    lock: () => acquireReplicaLock(replicaLockDir()),
    notify: notifyDiscord,
    record: recordAdmitted,
    score: scoreReplica,
  });

  return { ...summary, elapsedMs: Date.now() - started };
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--admission-phase" && args[1] === "record") {
    const payloadIndex = args.indexOf("--payload");
    const payloadFile = payloadIndex >= 0 ? args[payloadIndex + 1] : undefined;

    if (!payloadFile) {
      log("missing --payload for the record phase");
      process.exit(2);
    }

    const payload = JSON.parse(await readFile(payloadFile, "utf8")) as RecordPayload;
    console.log(JSON.stringify(await postPayload(payload)));
  } else {
    try {
      const summary = await main();
      console.log(JSON.stringify(summary));

      if (!summary.ok) {
        process.exit(1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`label-outliers-sweep failed: ${message}`);
      console.log(
        JSON.stringify({
          ...emptySummary(),
          error: message,
          errors: 1,
          ok: false,
          reason: "label_outliers_failed",
        }),
      );
      process.exit(1);
    }
  }
}
