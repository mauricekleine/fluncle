#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
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
const ACKNOWLEDGE_PATH = "/api/v1/admin/label-outliers/alerts";
const BOARD_URL = "https://www.fluncle.com/admin/label-outliers";
const ADMISSION_OWNER = "fluncle-label-outliers";
const EMBEDDING_BYTES = EMBEDDING_DIMENSIONS * 4;
const DISCORD_NAME_LIMIT = 8;

export const MAX_RECORDED_OUTLIERS = 2000;

export const CORPUS_FLOOR = { minTracks: 10_000, minUsableFraction: 0.95 } as const;

export type CorpusFloor = { minTracks: number; minUsableFraction: number };

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
  totalFlagged: number;
  tracksScored: number;
  unitsScored: number;
};

export type PendingAlert = { albumName: string | null; labelName: string | null; title: string };

export type AlertedUnit = { fingerprint: string; unitId: string };

export type RecordResponse = {
  flagged?: number;
  ok?: boolean;
  pendingAlertUnits?: AlertedUnit[];
  pendingAlerts?: PendingAlert[];
  removed?: number;
};

export type AcknowledgeResponse = { acknowledged?: number; ok?: boolean };

export type Admitted<T> =
  | { kind: "completed"; response: T }
  | { kind: "yielded"; reason: string | null };

export type ScoredReplica = {
  embeddedTracks: number;
  replicaSyncedAt: string | null;
  run: LabelOutlierRun;
};

export type LabelOutliersSummary = {
  alertAcknowledged: boolean | null;
  lockHeldMs?: null | number;
  checked: null | number;
  elapsedMs?: number;
  embeddedTracks: null | number;
  error?: string;
  errors: number;
  flagged: null | number;
  labelsScored: null | number;
  notified: boolean;
  ok: boolean;
  payloadStarted: boolean;
  pendingAlerts: null | number;
  produced: null | number;
  reason?: string;
  replicaSyncedAt: null | string;
  tracksScored: null | number;
};

export function emptySummary(): LabelOutliersSummary {
  return {
    alertAcknowledged: null,
    checked: null,
    embeddedTracks: null,
    errors: 0,
    flagged: null,
    labelsScored: null,
    notified: false,
    ok: true,
    payloadStarted: false,
    pendingAlerts: null,
    produced: null,
    replicaSyncedAt: null,
    tracksScored: null,
  };
}

export function toPayload(run: LabelOutlierRun, replicaSyncedAt: string | null): RecordPayload {
  return {
    labelsScored: run.labelsScored,
    outliers: run.flagged.map((unit) => ({
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
    totalFlagged: run.flagged.length,
    tracksScored: run.tracksScored,
    unitsScored: run.unitsScored,
  };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function corpusFloorViolation(scored: ScoredReplica, floor: CorpusFloor): string | null {
  const usable = scored.run.tracksScored;

  if (usable < floor.minTracks) {
    return `only ${usable} usable embedded tracks (floor ${floor.minTracks})`;
  }

  if (scored.embeddedTracks > 0 && usable / scored.embeddedTracks < floor.minUsableFraction) {
    return `only ${usable} of ${scored.embeddedTracks} embedded tracks carried a usable vector (floor ${Math.round(floor.minUsableFraction * 100)}%)`;
  }

  return null;
}

export function discordMessage(
  named: readonly PendingAlert[],
  count: number,
  total: number,
): string {
  const shown = named.slice(0, DISCORD_NAME_LIMIT);
  const names = shown.map((item) => {
    const where = item.labelName ? ` on ${item.labelName}` : "";

    return `• ${item.albumName ?? item.title}${where}`;
  });
  const more = count > shown.length ? [`…and ${count - shown.length} more`] : [];

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
  const vector = new Float32Array(copy.buffer);
  let norm = 0;

  for (const value of vector) {
    if (!Number.isFinite(value)) {
      return null;
    }
    norm += value * value;
  }

  return norm > 0 ? vector : null;
}

const CATALOGUE_EMBEDDED = `from tracks t
  join track_embeddings e on e.track_id = t.track_id
  where t.is_catalogue = 1`;

const EMBEDDINGS_FIRST = `from track_embeddings e
  cross join tracks t on t.track_id = e.track_id
  where t.is_catalogue = 1`;

export type ReplicaInputs = {
  artistsByTrack: Map<string, string[]>;
  dnbTaggedAlbumIds: Set<string>;
  embeddedTracks: number;
  globalSum: Float64Array;
  groups: () => Iterable<LabelGroup>;
};

export function readReplicaInputs(database: Database): ReplicaInputs {
  const globalSum = new Float64Array(EMBEDDING_DIMENSIONS);
  let embeddedTracks = 0;

  for (const row of database
    .query<{ embedding_blob: unknown }, []>(`select e.embedding_blob ${CATALOGUE_EMBEDDED}`)
    .iterate()) {
    embeddedTracks += 1;
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

  return { artistsByTrack, dnbTaggedAlbumIds, embeddedTracks, globalSum, groups };
}

export type ReplicaSnapshot = { close: () => void; inputs: ReplicaInputs };

export function openReplicaSnapshot(path: string): ReplicaSnapshot {
  const database = new Database(path, { readonly: true, strict: true });

  try {
    database.run("BEGIN");
    const inputs = readReplicaInputs(database);

    return {
      close: () => {
        if (database.inTransaction) {
          database.run("COMMIT");
        }
        database.close();
      },
      inputs,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export function scoreSnapshotFile(path: string): Omit<ScoredReplica, "replicaSyncedAt"> {
  const snapshot = openReplicaSnapshot(path);

  try {
    const run = scoreCatalogue({ ...snapshot.inputs, groups: snapshot.inputs.groups() });

    return { embeddedTracks: snapshot.inputs.embeddedTracks, run };
  } finally {
    snapshot.close();
  }
}

const COPY_SCHEMA = [
  `create table tracks (track_id text primary key, label_id text, album_id text,
     is_catalogue integer not null, has_embedding integer not null)`,
  "create table track_embeddings (track_id text primary key, embedding_blob blob not null)",
  "create table track_artists (track_id text not null, artist_id text not null)",
  "create table albums (id text primary key, discogs_styles text)",
];

export function copyScoringInputs(source: Database, target: Database): number {
  for (const statement of COPY_SCHEMA) {
    target.run(statement);
  }

  const insertTrack = target.prepare(
    "insert into tracks (track_id, label_id, album_id, is_catalogue, has_embedding) values (?, ?, ?, ?, ?)",
  );
  const insertEmbedding = target.prepare(
    "insert into track_embeddings (track_id, embedding_blob) values (?, ?)",
  );
  const insertArtist = target.prepare(
    "insert into track_artists (track_id, artist_id) values (?, ?)",
  );
  const insertAlbum = target.prepare("insert into albums (id, discogs_styles) values (?, ?)");
  let copied = 0;

  target.run("BEGIN");

  for (const row of source
    .query<
      {
        album_id: string | null;
        embedding_blob: Uint8Array;
        has_embedding: number;
        is_catalogue: number;
        label_id: string | null;
        track_id: string;
      },
      []
    >(
      `select t.track_id, t.label_id, t.album_id, t.is_catalogue, t.has_embedding, e.embedding_blob
         ${EMBEDDINGS_FIRST}`,
    )
    .iterate()) {
    insertTrack.run(row.track_id, row.label_id, row.album_id, row.is_catalogue, row.has_embedding);
    insertEmbedding.run(row.track_id, row.embedding_blob);
    copied += 1;
  }

  for (const row of source
    .query<{ artist_id: string; track_id: string }, []>(
      `select ta.track_id, ta.artist_id from track_embeddings e
         cross join tracks t on t.track_id = e.track_id
         cross join track_artists ta on ta.track_id = e.track_id
        where t.is_catalogue = 1`,
    )
    .iterate()) {
    insertArtist.run(row.track_id, row.artist_id);
  }

  for (const row of source
    .query<{ discogs_styles: string; id: string }, []>(
      "select id, discogs_styles from albums where discogs_styles is not null",
    )
    .iterate()) {
    insertAlbum.run(row.id, row.discogs_styles);
  }

  target.run("COMMIT");
  target.run("create index tracks_label_id_idx on tracks (label_id)");

  return copied;
}

export type CopyOutcome =
  | { heldMs: number; kind: "copied" }
  | { kind: "busy" }
  | { kind: "missing" };

export async function copyReplicaUnderMirrorLock(
  replicaFile: string,
  lockDir: string,
  copyFile: string,
  now: () => number = () => performance.now(),
): Promise<CopyOutcome> {
  if (!(await stat(replicaFile).catch(() => undefined))) {
    return { kind: "missing" };
  }

  try {
    await mkdir(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { kind: "busy" };
    }
    throw error;
  }

  const lockedAt = now();

  try {
    const source = new Database(replicaFile, { readonly: true, strict: true });
    const target = new Database(copyFile, { create: true, strict: true });

    try {
      target.run("PRAGMA journal_mode = OFF");
      target.run("PRAGMA synchronous = OFF");
      source.run("BEGIN");
      copyScoringInputs(source, target);
      source.run("COMMIT");
    } finally {
      target.close();
      source.close();
    }
  } finally {
    await rmdir(lockDir);
  }

  return { heldMs: Math.round(now() - lockedAt), kind: "copied" };
}

export type ScoreOutcome =
  | ({ kind: "scored"; lockHeldMs: number | null } & ScoredReplica)
  | { kind: "busy" }
  | { kind: "missing" };

export async function scoreReplicaCopy(
  replicaFile: string,
  lockDir: string,
): Promise<ScoreOutcome> {
  const replicaStat = await stat(replicaFile).catch(() => undefined);
  const directory = await mkdtemp(join(tmpdir(), "label-outliers-copy-"));
  const copyFile = join(directory, "scoring-inputs.db");

  try {
    const copy = await copyReplicaUnderMirrorLock(replicaFile, lockDir, copyFile);

    if (copy.kind !== "copied") {
      if (copy.kind === "missing") {
        log(`no device-mirror replica at ${replicaFile}`);
      }
      return copy;
    }

    return {
      ...scoreSnapshotFile(copyFile),
      kind: "scored",
      lockHeldMs: copy.heldMs,
      replicaSyncedAt: replicaStat ? new Date(replicaStat.mtimeMs).toISOString() : null,
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export type SweepDeps = {
  acknowledge: (units: AlertedUnit[]) => Promise<Admitted<AcknowledgeResponse>>;
  notify: (message: string) => Promise<boolean>;
  record: (payload: RecordPayload) => Promise<Admitted<RecordResponse>>;
  score: () => Promise<ScoreOutcome>;
};

function admissionReason(reason: string | null): string {
  return reason ? `admission_${reason}` : "admission_yield";
}

async function alertAndAcknowledge(
  deps: SweepDeps,
  response: RecordResponse,
  summary: LabelOutliersSummary,
): Promise<void> {
  const pendingUnits = Array.isArray(response.pendingAlertUnits) ? response.pendingAlertUnits : [];
  const named = Array.isArray(response.pendingAlerts) ? response.pendingAlerts : [];

  summary.pendingAlerts = pendingUnits.length;

  if (pendingUnits.length === 0) {
    return;
  }

  summary.notified = await deps.notify(
    discordMessage(named, pendingUnits.length, response.flagged ?? pendingUnits.length),
  );

  if (!summary.notified) {
    summary.alertAcknowledged = false;
    return;
  }

  try {
    const acknowledged = await deps.acknowledge(pendingUnits);
    summary.alertAcknowledged =
      acknowledged.kind === "completed" && acknowledged.response.ok === true;
  } catch (error) {
    summary.alertAcknowledged = false;
    log(
      `alert acknowledgement failed; the next run re-sends it: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function runLabelOutliersSweep(
  deps: SweepDeps,
  floor: CorpusFloor = CORPUS_FLOOR,
): Promise<LabelOutliersSummary> {
  const summary = emptySummary();
  const scored = await deps.score();

  if (scored.kind === "missing") {
    return { ...summary, errors: 1, ok: false, reason: "replica_missing" };
  }

  if (scored.kind === "busy") {
    return { ...summary, reason: "replica_busy" };
  }

  summary.lockHeldMs = scored.lockHeldMs;

  summary.checked = scored.run.unitsScored;
  summary.embeddedTracks = scored.embeddedTracks;
  summary.labelsScored = scored.run.labelsScored;
  summary.tracksScored = scored.run.tracksScored;
  summary.replicaSyncedAt = scored.replicaSyncedAt;

  const violation = corpusFloorViolation(scored, floor);

  if (violation) {
    return { ...summary, error: violation, errors: 1, ok: false, reason: "corpus_below_floor" };
  }

  if (scored.run.flagged.length > MAX_RECORDED_OUTLIERS) {
    return {
      ...summary,
      error: `${scored.run.flagged.length} units flagged, more than the ${MAX_RECORDED_OUTLIERS} one run may record; nothing written`,
      errors: 1,
      flagged: scored.run.flagged.length,
      ok: false,
      reason: "too_many_outliers",
    };
  }

  const payload = toPayload(scored.run, scored.replicaSyncedAt);
  const recorded = await deps.record(payload);

  if (recorded.kind === "yielded") {
    return { ...summary, reason: admissionReason(recorded.reason) };
  }

  summary.payloadStarted = true;

  const response = recorded.response;

  if (response.ok !== true || typeof response.flagged !== "number") {
    return { ...summary, error: "record_label_outliers returned no result", errors: 1, ok: false };
  }

  summary.flagged = response.flagged;
  summary.produced = payload.outliers.length;
  await alertAndAcknowledge(deps, response, summary);

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

async function putJson<T>(path: string, body: unknown, what: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
    method: "PUT",
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(
      `${what} failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
    );
  }

  return (await response.json()) as T;
}

type PhaseName = "acknowledge" | "record";

const PHASES: Record<PhaseName, { path: string; what: string }> = {
  acknowledge: { path: ACKNOWLEDGE_PATH, what: "acknowledge_label_outlier_alerts" },
  record: { path: RECORD_PATH, what: "record_label_outliers" },
};

async function admittedPut<T>(phase: PhaseName, body: unknown): Promise<Admitted<T>> {
  const directory = await mkdtemp(join(tmpdir(), "label-outliers-"));
  const file = join(directory, "payload.json");

  try {
    await writeFile(file, JSON.stringify(body));
    const result = await runDatabaseAdmissionPhaseAsync({
      command: [
        process.execPath,
        import.meta.filename,
        "--admission-phase",
        phase,
        "--payload",
        file,
      ],
      owner: ADMISSION_OWNER,
      yieldRetries: 1,
    });

    if (result.kind === "yielded") {
      return { kind: "yielded", reason: result.yieldReason };
    }

    return { kind: "completed", response: JSON.parse(result.stdout) as T };
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
      log(`discord post returned ${response.status}; the alert stays pending for the next run`);
    }

    return response.ok;
  } catch (error) {
    log(
      `discord post failed; the alert stays pending for the next run: ${error instanceof Error ? error.message : String(error)}`,
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
    acknowledge: (units) => admittedPut<AcknowledgeResponse>("acknowledge", { units }),
    notify: notifyDiscord,
    record: (payload) => admittedPut<RecordResponse>("record", payload),
    score: () => scoreReplicaCopy(replicaPath(), replicaLockDir()),
  });

  return { ...summary, elapsedMs: Date.now() - started };
}

async function runPhase(args: string[]): Promise<void> {
  const phase = args[1] === "acknowledge" || args[1] === "record" ? args[1] : undefined;
  const payloadIndex = args.indexOf("--payload");
  const payloadFile = payloadIndex >= 0 ? args[payloadIndex + 1] : undefined;

  if (!phase || !payloadFile) {
    log("an admission phase needs a known phase name and --payload");
    process.exit(2);
  }

  const body: unknown = JSON.parse(await readFile(payloadFile, "utf8"));
  console.log(JSON.stringify(await putJson(PHASES[phase].path, body, PHASES[phase].what)));
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--admission-phase") {
    await runPhase(args);
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
