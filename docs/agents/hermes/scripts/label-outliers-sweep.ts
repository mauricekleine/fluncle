#!/usr/bin/env bun

import { type Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDatabaseAdmissionPhaseAsync } from "./database-admission-phase";
import {
  type Admitted,
  buildScoringFile,
  createScoringFile,
  type FetchedPage,
  INPUTS_PAGE_LIMIT,
  type InputsRead,
  type PageFetch,
  parseInputsPage,
} from "./label-outliers-inputs";
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

const INPUTS_PATH = "/api/v1/admin/label-outliers/inputs";
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

export type { Admitted };

export type ScoredCorpus = {
  embeddedTracks: number;
  readAt: string;
  run: LabelOutlierRun;
};

export type LabelOutliersSummary = {
  alertAcknowledged: boolean | null;
  checked: null | number;
  elapsedMs?: number;
  embeddedTracks: null | number;
  error?: string;
  errors: number;
  flagged: null | number;
  inputBytes: null | number;
  inputPages: null | number;
  inputReadMs: null | number;
  inputsReadAt: null | string;
  labelsScored: null | number;
  notified: boolean;
  ok: boolean;
  payloadStarted: boolean;
  pendingAlerts: null | number;
  produced: null | number;
  reason?: string;
  tracksScored: null | number;
};

export function emptySummary(): LabelOutliersSummary {
  return {
    alertAcknowledged: null,
    checked: null,
    embeddedTracks: null,
    errors: 0,
    flagged: null,
    inputBytes: null,
    inputPages: null,
    inputReadMs: null,
    inputsReadAt: null,
    labelsScored: null,
    notified: false,
    ok: true,
    payloadStarted: false,
    pendingAlerts: null,
    produced: null,
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

export function corpusFloorViolation(scored: ScoredCorpus, floor: CorpusFloor): string | null {
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

export type ScoringInputs = {
  artistsByTrack: Map<string, string[]>;
  dnbTaggedAlbumIds: Set<string>;
  embeddedTracks: number;
  globalSum: Float64Array;
  groups: () => Iterable<LabelGroup>;
};

export function readScoringInputs(database: Database): ScoringInputs {
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

export type ScoreOutcome =
  | ({ kind: "scored"; read: InputsRead } & ScoredCorpus)
  | { kind: "yielded"; read: InputsRead; reason: string | null };

export async function scoreFromPages(
  scoringFile: string,
  fetchPage: PageFetch,
  options: { maxPages?: number; now?: () => Date } = {},
): Promise<ScoreOutcome> {
  const readAt = (options.now ?? (() => new Date()))().toISOString();
  await rm(scoringFile, { force: true });
  const database = createScoringFile(scoringFile);

  try {
    const built = await buildScoringFile(database, fetchPage, { maxPages: options.maxPages });
    const read: InputsRead = {
      bytes: built.bytes,
      durationMs: built.durationMs,
      pages: built.pages,
      tracks: built.tracks,
    };

    if (built.kind === "yielded") {
      return { kind: "yielded", read, reason: built.reason };
    }

    const inputs = readScoringInputs(database);
    const run = scoreCatalogue({ ...inputs, groups: inputs.groups() });

    return {
      embeddedTracks: inputs.embeddedTracks,
      kind: "scored",
      read,
      readAt,
      run,
    };
  } finally {
    database.close();
    await rm(scoringFile, { force: true });
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

  summary.inputBytes = scored.read.bytes;
  summary.inputPages = scored.read.pages;
  summary.inputReadMs = scored.read.durationMs;

  if (scored.kind === "yielded") {
    return { ...summary, reason: admissionReason(scored.reason) };
  }

  summary.checked = scored.run.unitsScored;
  summary.embeddedTracks = scored.embeddedTracks;
  summary.labelsScored = scored.run.labelsScored;
  summary.tracksScored = scored.run.tracksScored;
  summary.inputsReadAt = scored.readAt;

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

  const payload = toPayload(scored.run, scored.readAt);
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

async function scoringFilePath(): Promise<string> {
  const home = process.env.HOME ?? "/opt/data/home";
  const stateDirectory = process.env.LABEL_OUTLIERS_STATE_DIR ?? join(home, "label-outliers");
  await mkdir(stateDirectory, { recursive: true });

  return join(stateDirectory, "scoring-inputs.db");
}

async function getInputsPage(cursor: string | null): Promise<string> {
  const url = new URL(`${API_BASE_URL}${INPUTS_PATH}`);
  url.searchParams.set("limit", String(INPUTS_PAGE_LIMIT));

  if (cursor !== null) {
    url.searchParams.set("cursor", cursor);
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`list_label_outlier_inputs failed (${response.status}): ${body.slice(0, 200)}`);
  }

  return body;
}

async function admittedInputsPage(cursor: string | null): Promise<Admitted<FetchedPage>> {
  const result = await runDatabaseAdmissionPhaseAsync({
    command: [
      process.execPath,
      import.meta.filename,
      "--admission-phase",
      "inputs",
      ...(cursor === null ? [] : ["--cursor", cursor]),
    ],
    owner: ADMISSION_OWNER,
    yieldRetries: 1,
  });

  if (result.kind === "yielded") {
    return { kind: "yielded", reason: result.yieldReason };
  }

  return {
    kind: "completed",
    response: { bytes: result.stdout.length, page: parseInputsPage(JSON.parse(result.stdout)) },
  };
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
    score: async () => scoreFromPages(await scoringFilePath(), admittedInputsPage),
  });

  return { ...summary, elapsedMs: Date.now() - started };
}

async function runPhase(args: string[]): Promise<void> {
  if (args[1] === "inputs") {
    const cursorIndex = args.indexOf("--cursor");
    process.stdout.write(
      await getInputsPage(cursorIndex >= 0 ? (args[cursorIndex + 1] ?? null) : null),
    );
    return;
  }

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
