// Fluncle's Logbook — the Worker-side store + voice gate + the nightly sweep's
// gap/gather query. The public /logbook pages read `listLogbookEntries` /
// `getLogbookEntry`; the admin ops (../orpc/admin-logbook) call `createLogbookEntry`
// (agent, fill-empty-only) / `updateLogbookEntry` (operator, overwrite) /
// `listLogbookGaps` (the sweep's self-healing window + material). See
// docs/agents/logbook-agent.md.

import { type LogbookEntryDTO, type LogbookGap } from "@fluncle/contracts";
import { parseSectorParam, sectorDateISO, sectorDay, sectorRange } from "../log-id-shared";
import { trackMedia } from "../media";
import { parseArtistsJson } from "./artists";
import { getDb, typedRow, typedRows } from "./db";
import { scanObservationScript } from "./observation";
import { ApiError } from "./spotify";

// A logbook body is LONG-FORM (a day's travelogue), not the note's one line — so the
// bounds are generous. The floor is over the token-STRIPPED prose so a body that is
// only figure tokens (no actual writing) fails; the ceiling is over the whole body.
const BODY_MIN_PROSE_CHARS = 80;
const BODY_MAX_CHARS = 12_000;
const TITLE_MAX_CHARS = 140;

// The figure-token shape, matched anywhere (a whole line or inline) so the voice
// scan and the prose-length floor see only the actual writing, never a coordinate.
const FIGURE_TOKEN_GLOBAL_RE = /\[\[[A-Za-z0-9.]+\]\]/g;

type LogbookRow = {
  body: string;
  generated_at: string;
  generated_by: "agent" | "operator";
  sector: number;
  title: string;
};

// The material a gap's finding carries — the admin-tier gather (internal fuel too).
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

// ── Voice gate (the shared written-note gate over the prose) ──────────────────

/** Strip the figure tokens so the voice scan + length floor see only the prose. */
function stripFigureTokens(body: string): string {
  return body.replace(FIGURE_TOKEN_GLOBAL_RE, " ");
}

/**
 * Validate + voice-gate an agent/operator-authored entry TITLE, returning the trimmed
 * title. The title is a public Fluncle-voice line, so it clears the same shared
 * banned-word / earthly-geography / exclamation / "we"-as-company scan the body does.
 */
export function gateLogbookTitle(value: unknown): string {
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

  gateVoice(stripFigureTokens(trimmed), "title");

  return trimmed;
}

/**
 * Validate + voice-gate an entry BODY, returning the trimmed body (figure tokens
 * intact — the renderer needs them). The prose (tokens stripped) clears the shared
 * voice scan and the min-length floor; the whole body is capped at BODY_MAX_CHARS.
 * The body lands straight on the public /logbook surface, so a violation hard-fails
 * the store before it is ever shown.
 */
export function gateLogbookBody(value: unknown): string {
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

  gateVoice(prose, "body");

  return trimmed;
}

function gateVoice(prose: string, field: "body" | "title"): void {
  const violations = scanObservationScript(prose);

  if (violations.length > 0) {
    throw new ApiError(
      "voice_gate",
      `The ${field} fails the voice gate: ${violations.map((violation) => violation.reason).join("; ")}`,
      422,
    );
  }
}

// ── Reads (public + neighbor nav) ─────────────────────────────────────────────

/** The public index: every entry, newest sector first. */
export async function listLogbookEntries({ limit = 500 }: { limit?: number } = {}): Promise<
  LogbookEntryDTO[]
> {
  const db = await getDb();
  const result = await db.execute({
    args: [Math.min(Math.max(limit, 1), 1000)],
    sql: `${ENTRY_SELECT} order by sector desc limit ?`,
  });

  return typedRows<LogbookRow>(result.rows).map(rowToEntry);
}

/** One entry by its sector, or undefined. */
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

/**
 * The adjacent EXISTING entries for prev/next nav: `older` is the nearest entry at a
 * lower sector, `newer` the nearest at a higher sector (gaps between authored days
 * are skipped, so nav always lands on a real page).
 */
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

/**
 * The day's findings (title + artists) keyed by Log ID — the figure-caption map the
 * public entry page resolves `[[logId]]` tokens against. Findings whose `added_at`
 * falls in the sector-day's range, oldest first.
 */
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

// ── Writes ────────────────────────────────────────────────────────────────────

export type LogbookInput = { body?: unknown; title?: unknown };

/**
 * Author a sector's entry — the FILL-EMPTY-ONLY create (agent tier). A sector that
 * already has an entry (agent- OR operator-authored) is a no-op (`skipped: true`);
 * the operator override always wins, enforced here server-side by the PK insert. On
 * an empty sector, voice-gate the title + body and insert `generated_by = 'agent'`.
 */
export async function createLogbookEntry(
  sector: number,
  input: LogbookInput,
): Promise<{ entry: LogbookEntryDTO; skipped: boolean }> {
  const existing = await getLogbookEntry(sector);

  if (existing) {
    // The cardinal guarantee: never clobber an existing entry.
    return { entry: existing, skipped: true };
  }

  const title = gateLogbookTitle(input.title);
  const body = gateLogbookBody(input.body);
  const now = new Date().toISOString();
  const db = await getDb();

  // The PK insert is the race-safe guard: a concurrent create loses on the conflict
  // rather than double-writing (DO NOTHING), and we re-read to return the winner.
  await db.execute({
    args: [sector, title, body, "agent", now, now, now],
    sql: `insert into logbook_entries
            (sector, title, body, generated_by, generated_at, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?)
          on conflict(sector) do nothing`,
  });

  const stored = await getLogbookEntry(sector);

  if (!stored) {
    throw new ApiError("logbook_write_failed", "Entry could not be stored", 500);
  }

  // A lost race means someone else's entry stands — report it as a skip, no clobber.
  return { entry: stored, skipped: stored.generatedAt !== now };
}

/**
 * Create-or-overwrite a sector's entry — the OPERATOR path. Unlike the agent create
 * it CAN replace an existing entry (that's the point), and it stamps
 * `generated_by = 'operator'` so the fill-empty-only agent create thereafter treats
 * it as sacred. Voice-gates title + body.
 */
export async function updateLogbookEntry(
  sector: number,
  input: LogbookInput,
): Promise<LogbookEntryDTO> {
  const title = gateLogbookTitle(input.title);
  const body = gateLogbookBody(input.body);
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

// ── The sweep's self-healing window (gap + gather) ────────────────────────────

/**
 * Every past sector-day (before today, at/after the epoch) that has ≥1 published
 * finding and NO logbook entry, OLDEST FIRST, bounded by `limit` — each with the
 * day's findings and their authoring material (public note + internal context_note +
 * observation script + poster URL). ONE call gives the box's `fluncle-logbook` sweep
 * both its worklist AND the fuel, so it picks a day and gathers in a single read.
 *
 * The current (in-progress) sector-day is excluded: an entry is authored only once a
 * day is COMPLETE, so `sector < todaySector`.
 */
export async function listLogbookGaps({ limit = 5 }: { limit?: number } = {}): Promise<
  LogbookGap[]
> {
  const bounded = Math.min(Math.max(limit, 1), 30);
  const db = await getDb();

  // Which sector-days HAVE a published finding, and which already have an entry.
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

    // A sector reached this list because it has ≥1 finding, but guard anyway.
    if (findings.length > 0) {
      gaps.push({ date: sectorDateISO(sector), findings, sector });
    }
  }

  return gaps;
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

/** Parse a `{sector}` route/path param into a sector number, or throw a clean 400. */
export function requireSector(value: string): number {
  const sector = parseSectorParam(value);

  if (sector === null) {
    throw new ApiError("invalid_sector", `Not a sector number: ${value}`, 400);
  }

  return sector;
}
