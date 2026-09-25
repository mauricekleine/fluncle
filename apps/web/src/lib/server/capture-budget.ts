import { getDb, typedRow } from "./db";
import { getSetting, setSetting } from "./settings";

export const CATALOGUE_CAPTURE_PAUSED_KEY = "catalogue_capture_paused";

export const CATALOGUE_CAPTURE_DAILY_TRACKS_KEY = "catalogue_capture_daily_tracks";

export const CATALOGUE_CAPTURE_DAILY_BYTES_KEY = "catalogue_capture_daily_bytes";

const HOUR_MS = 60 * 60 * 1000;

export const CAPTURE_WINDOW_MS = 24 * HOUR_MS;
export const CAPTURE_WINDOW_HOURS = 24;

export const DEFAULT_DAILY_TRACKS = 50;

export const DEFAULT_DAILY_BYTES = 1024 * 1024 * 1024;

export type CatalogueCaptureBudget = {
  dailyBytes: number;
  dailyTracks: number;
};

export type CatalogueCaptureSpend = {
  bytes: number;

  tracks: number;
};

export type CatalogueCaptureClosedReason = "bytes_spent" | "paused" | "tracks_spent";

export type CatalogueCaptureState = {
  budget: CatalogueCaptureBudget;

  closedReason: CatalogueCaptureClosedReason | null;

  open: boolean;
  paused: boolean;
  remainingBytes: number;
  remainingTracks: number;
  spend: CatalogueCaptureSpend;
  windowHours: number;
};

export function parseBudgetNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return fallback;
  }

  const parsed = Number(raw.trim());

  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function catalogueCaptureVerdict(input: {
  budget: CatalogueCaptureBudget;
  paused: boolean;
  spend: CatalogueCaptureSpend;
}): Pick<CatalogueCaptureState, "closedReason" | "open" | "remainingBytes" | "remainingTracks"> {
  const remainingTracks = Math.max(0, input.budget.dailyTracks - input.spend.tracks);
  const remainingBytes = Math.max(0, input.budget.dailyBytes - input.spend.bytes);

  const closedReason: CatalogueCaptureClosedReason | null = input.paused
    ? "paused"
    : input.spend.tracks >= input.budget.dailyTracks
      ? "tracks_spent"
      : input.spend.bytes >= input.budget.dailyBytes
        ? "bytes_spent"
        : null;

  return {
    closedReason,
    open: closedReason === null,
    remainingBytes,
    remainingTracks,
  };
}

export async function isCatalogueCapturePaused(): Promise<boolean> {
  return (await getSetting(CATALOGUE_CAPTURE_PAUSED_KEY)) !== "false";
}

export async function setCatalogueCapturePaused(paused: boolean): Promise<void> {
  await setSetting(CATALOGUE_CAPTURE_PAUSED_KEY, paused ? "true" : "false");
}

export async function getCatalogueCaptureBudget(): Promise<CatalogueCaptureBudget> {
  const [tracks, bytes] = await Promise.all([
    getSetting(CATALOGUE_CAPTURE_DAILY_TRACKS_KEY),
    getSetting(CATALOGUE_CAPTURE_DAILY_BYTES_KEY),
  ]);

  return {
    dailyBytes: parseBudgetNumber(bytes, DEFAULT_DAILY_BYTES),
    dailyTracks: parseBudgetNumber(tracks, DEFAULT_DAILY_TRACKS),
  };
}

export async function setCatalogueCaptureBudget(
  budget: Partial<CatalogueCaptureBudget>,
): Promise<void> {
  if (budget.dailyTracks !== undefined) {
    await setSetting(CATALOGUE_CAPTURE_DAILY_TRACKS_KEY, String(budget.dailyTracks));
  }

  if (budget.dailyBytes !== undefined) {
    await setSetting(CATALOGUE_CAPTURE_DAILY_BYTES_KEY, String(budget.dailyBytes));
  }
}

type SpendRow = { bytes: number | null; tracks: number | null };

export async function readCatalogueCaptureSpend(
  nowMs: number = Date.now(),
): Promise<CatalogueCaptureSpend> {
  const cutoff = new Date(nowMs - CAPTURE_WINDOW_MS).toISOString();
  const db = await getDb();
  const result = await db.execute({
    args: [cutoff],
    sql: `select count(*) as tracks,
                 coalesce(sum(coalesce(t.source_audio_bytes, 0)), 0) as bytes
          from tracks t
          left join findings f on f.track_id = t.track_id
          where f.track_id is null
            and t.source_audio_attempted_at is not null
            and t.source_audio_attempted_at >= ?`,
  });

  const row = typedRow<SpendRow>(result.rows);

  return {
    bytes: Number(row?.bytes ?? 0),
    tracks: Number(row?.tracks ?? 0),
  };
}

export async function getCatalogueCaptureState(
  nowMs: number = Date.now(),
): Promise<CatalogueCaptureState> {
  const [paused, budget, spend] = await Promise.all([
    isCatalogueCapturePaused(),
    getCatalogueCaptureBudget(),
    readCatalogueCaptureSpend(nowMs),
  ]);

  return {
    budget,
    ...catalogueCaptureVerdict({ budget, paused, spend }),
    paused,
    spend,
    windowHours: CAPTURE_WINDOW_HOURS,
  };
}

export async function isCatalogueCaptureOpen(nowMs: number = Date.now()): Promise<boolean> {
  return (await readCatalogueCaptureAdmission(nowMs)).open;
}

export async function readCatalogueCaptureAdmission(
  nowMs: number = Date.now(),
): Promise<{ open: boolean; remainingTracks: number }> {
  if (await isCatalogueCapturePaused()) {
    return { open: false, remainingTracks: 0 };
  }

  const [budget, spend] = await Promise.all([
    getCatalogueCaptureBudget(),
    readCatalogueCaptureSpend(nowMs),
  ]);
  const { open, remainingTracks } = catalogueCaptureVerdict({ budget, paused: false, spend });

  return { open, remainingTracks };
}
