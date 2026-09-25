import { type LogbookEntryDTO, type LogbookGap, type LogbookSpentEntry } from "@fluncle/contracts";
import { parseSectorParam, sectorDateISO, sectorDay, sectorRange } from "../log-id-shared";
import { trackMedia } from "../media";
import { parseArtistsJson } from "./artists";
import { getDb, typedRow, typedRows } from "./db";
import {
  getLogbookEchoThresholds,
  type LogbookEchoNeighbor,
  logbookBodyEchoError,
  scoreLogbookEcho,
} from "./logbook-echo";
import { maskSubjectNames, scanObservationScript } from "./observation";
import { ApiError } from "./spotify";

const BODY_MIN_PROSE_CHARS = 80;
const BODY_MAX_CHARS = 12_000;
const TITLE_MAX_CHARS = 140;

const ECHO_NEIGHBOR_LIMIT = 6;

const SPENT_MOVES_LIMIT = 12;

const FIGURE_TOKEN_GLOBAL_RE = /\[\[[A-Za-z0-9.]+\]\]/g;

type LogbookRow = {
  body: string;
  generated_at: string;
  generated_by: "agent" | "operator";
  sector: number;
  title: string;
};

type GapFindingRow = {
  added_at: string;
  artists_json: string;
  context_note: string | null;
  log_id: string;
  note: string | null;
  observation_script: string | null;
  title: string;
};

const ENTRY_SELECT = `select sector, title, body, generated_at, generated_by from logbook_entries`;

function rowToEntry(row: LogbookRow): LogbookEntryDTO {
  return {
    body: row.body,
    generatedAt: row.generated_at,
    generatedBy: row.generated_by,
    sector: row.sector,
    title: row.title,
  };
}

function stripFigureTokens(body: string): string {
  return body.replace(FIGURE_TOKEN_GLOBAL_RE, " ");
}

export async function sectorSubjectNames(sector: number): Promise<string[]> {
  const { endMs, startMs } = sectorRange(sector);
  const db = await getDb();
  const result = await db.execute({
    args: [new Date(startMs).toISOString(), new Date(endMs).toISOString()],
    sql: `select tracks.title, tracks.artists_json
          from findings join tracks on tracks.track_id = findings.track_id
          where findings.log_id is not null
            and findings.added_at >= ? and findings.added_at < ?`,
  });

  return typedRows<{ artists_json: string; title: string }>(result.rows).flatMap((row) => [
    row.title,
    ...parseArtistsJson(row.artists_json),
  ]);
}

export function gateLogbookTitle(value: unknown, subjectNames: readonly string[]): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("no_title", "A logbook entry `title` is required", 400);
  }

  const trimmed = value.trim();

  if (trimmed.length > TITLE_MAX_CHARS) {
    throw new ApiError(
      "title_too_long",
      `The title is too long (${trimmed.length} > ${TITLE_MAX_CHARS} chars)`,
      422,
    );
  }

  gateVoice(stripFigureTokens(trimmed), "title", subjectNames);

  return trimmed;
}

export function gateLogbookBody(value: unknown, subjectNames: readonly string[]): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("no_body", "A logbook entry `body` is required", 400);
  }

  const trimmed = value.trim();

  if (trimmed.length > BODY_MAX_CHARS) {
    throw new ApiError(
      "body_too_long",
      `The body is too long (${trimmed.length} > ${BODY_MAX_CHARS} chars)`,
      422,
    );
  }

  const prose = stripFigureTokens(trimmed).replace(/\s+/g, " ").trim();

  if (prose.length < BODY_MIN_PROSE_CHARS) {
    throw new ApiError(
      "body_too_short",
      `The body prose is too short (${prose.length} < ${BODY_MIN_PROSE_CHARS} chars)`,
      422,
    );
  }

  gateVoice(prose, "body", subjectNames);

  return trimmed;
}

function gateVoice(prose: string, field: "body" | "title", subjectNames: readonly string[]): void {
  const violations = scanObservationScript(maskSubjectNames(prose, subjectNames));

  if (violations.length > 0) {
    throw new ApiError(
      "voice_gate",
      `The ${field} fails the voice gate: ${violations.map((violation) => violation.reason).join("; ")}`,
      422,
    );
  }
}

const INDEX_SELECT = `select sector, title from logbook_entries`;

export type LogbookIndexEntry = Pick<LogbookEntryDTO, "sector" | "title">;

export async function listLogbookIndexEntries({ limit = 500 }: { limit?: number } = {}): Promise<
  LogbookIndexEntry[]
> {
  const db = await getDb();
  const result = await db.execute({
    args: [Math.min(Math.max(limit, 1), 1000)],
    sql: `${INDEX_SELECT} order by sector desc limit ?`,
  });

  return typedRows<{ sector: number; title: string }>(result.rows).map((row) => ({
    sector: row.sector,
    title: row.title,
  }));
}

export async function getLogbookEntry(sector: number): Promise<LogbookEntryDTO | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [sector],
    sql: `${ENTRY_SELECT} where sector = ? limit 1`,
  });
  const row = typedRow<LogbookRow>(result.rows);

  return row ? rowToEntry(row) : undefined;
}

export type LogbookNeighbor = { sector: number; title: string };

export async function getLogbookNeighbors(
  sector: number,
): Promise<{ newer?: LogbookNeighbor; older?: LogbookNeighbor }> {
  const db = await getDb();
  const [olderResult, newerResult] = await Promise.all([
    db.execute({
      args: [sector],
      sql: `select sector, title from logbook_entries where sector < ? order by sector desc limit 1`,
    }),
    db.execute({
      args: [sector],
      sql: `select sector, title from logbook_entries where sector > ? order by sector asc limit 1`,
    }),
  ]);
  const older = typedRow<LogbookNeighbor>(olderResult.rows);
  const newer = typedRow<LogbookNeighbor>(newerResult.rows);

  return { ...(newer ? { newer } : {}), ...(older ? { older } : {}) };
}

export async function getSectorFindings(
  sector: number,
): Promise<Record<string, { artists: string[]; title: string }>> {
  const { endMs, startMs } = sectorRange(sector);
  const db = await getDb();
  const result = await db.execute({
    args: [new Date(startMs).toISOString(), new Date(endMs).toISOString()],
    sql: `select findings.log_id, tracks.title, tracks.artists_json from findings join tracks on tracks.track_id = findings.track_id
          where findings.log_id is not null
            and findings.added_at >= ? and findings.added_at < ?`,
  });

  const map: Record<string, { artists: string[]; title: string }> = {};

  for (const row of typedRows<{ artists_json: string; log_id: string; title: string }>(
    result.rows,
  )) {
    map[row.log_id] = { artists: parseArtistsJson(row.artists_json), title: row.title };
  }

  return map;
}

function normalizeTitle(title: string): string {
  return stripFigureTokens(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function assertTitleUnique(title: string, exceptSector?: number): Promise<void> {
  const normalized = normalizeTitle(title);

  if (!normalized) {
    return;
  }

  const db = await getDb();
  const result = await db.execute({
    sql: `select sector, title from logbook_entries`,
  });

  for (const row of typedRows<LogbookNeighbor>(result.rows)) {
    if (row.sector === exceptSector) {
      continue;
    }

    if (normalizeTitle(row.title) === normalized) {
      throw new ApiError(
        "title_echoes_logbook",
        `The title "${title}" repeats sector ${row.sector}'s "${row.title}" — every logbook title is taken once and stays taken. Give this day its own title.`,
        422,
      );
    }
  }
}

async function recentEchoNeighbors(
  exceptSector: number,
  limit = ECHO_NEIGHBOR_LIMIT,
): Promise<LogbookEchoNeighbor[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [exceptSector, Math.min(Math.max(limit, 1), 50)],
    sql: `select sector, body from logbook_entries where sector != ? order by sector desc limit ?`,
  });

  return typedRows<{ body: string; sector: number }>(result.rows).map((row) => ({
    body: stripFigureTokens(row.body).replace(/\s+/g, " ").trim(),
    sector: row.sector,
  }));
}

async function gateBodyEcho(sector: number, body: string): Promise<void> {
  const neighbors = await recentEchoNeighbors(sector);

  if (neighbors.length === 0) {
    return;
  }

  const prose = stripFigureTokens(body).replace(/\s+/g, " ").trim();
  const thresholds = await getLogbookEchoThresholds();
  const echo = scoreLogbookEcho(prose, neighbors, thresholds);

  if (echo.echoes) {
    throw logbookBodyEchoError(echo);
  }
}

export type LogbookInput = {
  body?: unknown;

  promptVersion?: number | null;
  title?: unknown;
};

export async function createLogbookEntry(
  sector: number,
  input: LogbookInput,
): Promise<{ entry: LogbookEntryDTO; skipped: boolean }> {
  const existing = await getLogbookEntry(sector);

  if (existing) {
    return { entry: existing, skipped: true };
  }

  const subjectNames = await sectorSubjectNames(sector);
  const title = gateLogbookTitle(input.title, subjectNames);
  const body = gateLogbookBody(input.body, subjectNames);

  await assertTitleUnique(title);
  await gateBodyEcho(sector, body);

  const now = new Date().toISOString();
  const db = await getDb();

  await db.execute({
    args: [sector, title, body, "agent", input.promptVersion ?? null, now, now, now],
    sql: `insert into logbook_entries
            (sector, title, body, generated_by, prompt_version, generated_at, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(sector) do nothing`,
  });

  const stored = await getLogbookEntry(sector);

  if (!stored) {
    throw new ApiError("logbook_write_failed", "Entry could not be stored", 500);
  }

  return { entry: stored, skipped: stored.generatedAt !== now };
}

export async function updateLogbookEntry(
  sector: number,
  input: LogbookInput,
): Promise<LogbookEntryDTO> {
  const subjectNames = await sectorSubjectNames(sector);
  const title = gateLogbookTitle(input.title, subjectNames);
  const body = gateLogbookBody(input.body, subjectNames);

  await assertTitleUnique(title, sector);

  const now = new Date().toISOString();
  const db = await getDb();

  await db.execute({
    args: [sector, title, body, now, now, now],
    sql: `insert into logbook_entries
            (sector, title, body, generated_by, generated_at, created_at, updated_at)
          values (?, ?, ?, 'operator', ?, ?, ?)
          on conflict(sector) do update set
            title = excluded.title,
            body = excluded.body,
            generated_by = 'operator',
            generated_at = excluded.generated_at,
            updated_at = excluded.updated_at`,
  });

  const stored = await getLogbookEntry(sector);

  if (!stored) {
    throw new ApiError("logbook_write_failed", "Entry could not be stored", 500);
  }

  return stored;
}

export async function listLogbookGaps({ limit = 5 }: { limit?: number } = {}): Promise<
  LogbookGap[]
> {
  const bounded = Math.min(Math.max(limit, 1), 30);
  const db = await getDb();

  const [findingsResult, entriesResult] = await Promise.all([
    db.execute({ sql: `select added_at from findings where log_id is not null` }),
    db.execute({ sql: `select sector from logbook_entries` }),
  ]);

  const todaySector = sectorDay(new Date().toISOString());
  const withFindings = new Set<number>();

  for (const row of typedRows<{ added_at: string }>(findingsResult.rows)) {
    const sector = sectorDay(row.added_at);

    if (sector < todaySector) {
      withFindings.add(sector);
    }
  }

  const authored = new Set(
    typedRows<{ sector: number }>(entriesResult.rows).map((row) => row.sector),
  );

  const gapSectors = [...withFindings]
    .filter((sector) => !authored.has(sector))
    .sort((a, b) => a - b)
    .slice(0, bounded);

  const gaps: LogbookGap[] = [];

  for (const sector of gapSectors) {
    const findings = await gatherSectorMaterial(sector);

    if (findings.length > 0) {
      gaps.push({ date: sectorDateISO(sector), findings, sector });
    }
  }

  return gaps;
}

export async function listSpentMoves(limit = SPENT_MOVES_LIMIT): Promise<LogbookSpentEntry[]> {
  const bounded = Math.min(Math.max(limit, 1), 50);
  const db = await getDb();
  const result = await db.execute({
    args: [bounded],
    sql: `select sector, title, body from logbook_entries order by sector desc limit ?`,
  });

  return typedRows<{ body: string; sector: number; title: string }>(result.rows).map((row) => {
    const { closer, opener } = openerCloser(row.body);

    return { closer, opener, sector: row.sector, title: row.title };
  });
}

function openerCloser(body: string): { closer: string; opener: string } {
  const prose = stripFigureTokens(body).replace(/\s+/g, " ").trim();

  const sentences = prose
    .split(/(?<=[.?!])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length === 0) {
    return { closer: "", opener: "" };
  }

  return {
    closer: sentences[sentences.length - 1] ?? "",
    opener: sentences[0] ?? "",
  };
}

async function gatherSectorMaterial(sector: number): Promise<LogbookGap["findings"]> {
  const { endMs, startMs } = sectorRange(sector);
  const db = await getDb();
  const result = await db.execute({
    args: [new Date(startMs).toISOString(), new Date(endMs).toISOString()],
    sql: `select findings.log_id, tracks.title, tracks.artists_json, findings.note,
                 findings.context_note, findings.observation_script, findings.added_at
          from findings join tracks on tracks.track_id = findings.track_id
          where findings.log_id is not null
            and findings.added_at >= ? and findings.added_at < ?
          order by findings.added_at asc`,
  });

  return typedRows<GapFindingRow>(result.rows).map((row) => ({
    artists: parseArtistsJson(row.artists_json),
    ...(row.context_note?.trim() ? { contextNote: row.context_note.trim() } : {}),
    logId: row.log_id,
    ...(row.note?.trim() ? { note: row.note.trim() } : {}),
    ...(row.observation_script?.trim() ? { observationScript: row.observation_script.trim() } : {}),
    posterUrl: trackMedia(row.log_id).posterUrl,
    title: row.title,
  }));
}

export function requireSector(value: string): number {
  const sector = parseSectorParam(value);

  if (sector === null) {
    throw new ApiError("invalid_sector", `Not a sector number: ${value}`, 400);
  }

  return sector;
}
