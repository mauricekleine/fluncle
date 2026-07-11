// THE CAPTURE BUDGET — a brake on the only thing in Fluncle that spends money per unit of
// work, sitting between the catalogue crawler and the residential proxy that bills per GB.
//
// ── THE PROBLEM THIS EXISTS TO STOP ──────────────────────────────────────────────────
// The capture sweep's bounds were tuned for FINDINGS: the operator logs ~15 a week, so a
// batch of 4 every 5 minutes is a queue that is empty almost all the time, and the bound
// never binds. The catalogue crawler (docs/catalogue-crawler.md) changes what those same
// numbers MEAN. It writes uncertified rows by the thousand, and the capture queue drains
// whatever it is given: 4 tracks × 288 ticks a day ≈ 1,150 songs ≈ ~9 GB of METERED proxy
// traffic per day, indefinitely, with nothing in the system that would ever say stop.
//
// The operator has ruled that he does not want to capture everything, and the reason is the
// bill. Until this module there was no mechanism that enforced that ruling — only a queue
// that drains. `capture_priority` (docs/the-ear.md) decides WHAT the money buys, and it does
// that job well; it has nothing to say about HOW MUCH. This is the how-much.
//
// ── THE SHAPE: A BUDGET AND A BRAKE, BOTH ON THE `settings` KV ───────────────────────
// Three rows on the shared `settings` KV (./settings.ts) — the same store the auto-advance
// kill switch and the clip drip's switch ride, deliberately not a third mechanism:
//
//   - `catalogue_capture_paused`       — the KILL SWITCH. Default-deny (below).
//   - `catalogue_capture_daily_tracks` — the rolling-24h COUNT cap.
//   - `catalogue_capture_daily_bytes`  — the rolling-24h BYTE cap.
//
// All three are changeable in one flip, from `/admin/catalogue` or `fluncle admin capture`,
// with NO DEPLOY. That is the whole point: a spend you can only stop by shipping a build is
// a spend you cannot stop.
//
// ── WHY BOTH A COUNT AND A BYTE CAP, AND THE HONEST LIMITATION IN THE BYTE ONE ───────
// Bytes are what he is billed for. Count is what the queue knows BEFORE it spends anything.
// Neither alone is enough, and the reason is a hard ordering fact:
//
//   **A file's size is knowable only AFTER it has been downloaded.** There is no
//   content-length to consult at queue time — the queue holds metadata, not media. So a
//   byte cap CANNOT be a pre-download guarantee. Anyone who tells you otherwise has moved
//   the check to a place where the money is already spent.
//
// So the two caps do different jobs, and the split is deliberate:
//
//   - The COUNT cap is the ENFORCEABLE one. It is checked before a single byte moves, and
//     it is exact: the queue hands out N rows a day and not one more. It is the guarantee.
//   - The BYTE cap is a BACKSTOP, enforced BETWEEN batches off what already landed. It
//     catches the case the count cap cannot see — a day of unusually fat files (a 12-minute
//     liquid roller, a lossless upload) blowing through the GB estimate the count was
//     chosen against. It can overshoot, and the overshoot is BOUNDED: at most one batch
//     (the sweep's `BATCH_CAP`, 4) × the largest file, because the gate is read once at the
//     top of a tick and the tick then runs to the end of its batch. Call it ~tens of MB
//     against a GB budget. That is the honest guarantee, and it is stated rather than
//     dressed up as a hard cap.
//
// ── THE LEDGER COUNTS ATTEMPTS, NOT SUCCESSES ────────────────────────────────────────
// A failed download still pulled bytes through the proxy before it failed, and an unmatched
// one still paid for a search. Counting only the successes would let a day of failures spend
// real money against a budget that reads as untouched. So the count ledger is a range seek on
// `source_audio_attempted_at`, which the sweep stamps on EVERY terminal outcome. The byte
// ledger sums `source_audio_bytes`, which only a success carries — a failure's partial
// transfer is genuinely unknowable from here, and is under-counted rather than guessed at.
//
// ── THE FINDINGS ARE NEVER GATED, AND THAT IS THE POINT ──────────────────────────────
// Every read here is scoped to the CATALOGUE half (`tracks` with no `findings` row). A
// certified finding's capture is a handful a week; it is not the spend, it was never the
// concern, and the archive must never be starved by the speculative half. So the budget
// cannot see a finding, cannot be consumed by one, and cannot hold one back. The brake in
// track-work.ts narrows the capture worklist to `findings` when this budget is closed — it
// never returns an empty queue while a finding still needs its audio. That property is
// proven, not asserted (track-work.integration.test.ts, "the archive is never starved").

import { getDb, typedRow } from "./db";
import { getSetting, setSetting } from "./settings";

/** The kill-switch key on the shared `settings` KV. */
export const CATALOGUE_CAPTURE_PAUSED_KEY = "catalogue_capture_paused";

/** The rolling-24h COUNT cap's key on the shared `settings` KV. */
export const CATALOGUE_CAPTURE_DAILY_TRACKS_KEY = "catalogue_capture_daily_tracks";

/** The rolling-24h BYTE cap's key on the shared `settings` KV. */
export const CATALOGUE_CAPTURE_DAILY_BYTES_KEY = "catalogue_capture_daily_bytes";

const HOUR_MS = 60 * 60 * 1000;

/** The budget's window. Rolling, not calendar: a midnight reset is a cliff to game. */
export const CAPTURE_WINDOW_MS = 24 * HOUR_MS;
export const CAPTURE_WINDOW_HOURS = 24;

/**
 * The default rolling-24h COUNT cap: 50 catalogue downloads a day.
 *
 * Deliberately a fraction of what the sweep COULD drain (~1,150/day). At a typical ~8 MB
 * full song that is ~400 MB/day — a real trickle he can watch the bill against for a week
 * and then decide, rather than a number chosen to feel generous. It binds only once he has
 * un-paused; until then the kill switch means it is never reached.
 */
export const DEFAULT_DAILY_TRACKS = 50;

/**
 * The default rolling-24h BYTE cap: 1 GiB.
 *
 * Sized as a BACKSTOP, not the binding constraint — ~2.5× what 50 typical songs weigh — so
 * on a normal day the count cap is what stops the sweep, and this only fires when the files
 * are far fatter than the count cap was chosen against. A backstop that binds first is not a
 * backstop; it is a second cap nobody tuned.
 */
export const DEFAULT_DAILY_BYTES = 1024 * 1024 * 1024;

/** The operator's two numbers. */
export type CatalogueCaptureBudget = {
  dailyBytes: number;
  dailyTracks: number;
};

/** What the catalogue has actually spent inside the rolling window. */
export type CatalogueCaptureSpend = {
  /** Bytes that LANDED (a success carries its size; a failure's partial pull is unknowable). */
  bytes: number;
  /** Downloads ATTEMPTED — done + unmatched + failed. Every one of them was billed. */
  tracks: number;
};

/** Why the catalogue half of the capture queue is shut. `paused` wins over both caps. */
export type CatalogueCaptureClosedReason = "bytes_spent" | "paused" | "tracks_spent";

/** The whole readout: the switch, the budget, the spend, and the verdict. */
export type CatalogueCaptureState = {
  budget: CatalogueCaptureBudget;
  /** Null exactly when `open` is true. */
  closedReason: CatalogueCaptureClosedReason | null;
  /** True ⇒ the capture queue may hand out catalogue rows. */
  open: boolean;
  paused: boolean;
  remainingBytes: number;
  remainingTracks: number;
  spend: CatalogueCaptureSpend;
  windowHours: number;
};

/**
 * Parse one budget number out of the KV. PURE.
 *
 * The default-deny discipline applied to a NUMBER: an unset key, an empty string, a negative,
 * a float, or anything a fat-fingered CLI wrote reads as the conservative DEFAULT — never as
 * "unlimited". The failure mode of a budget must be a smaller budget. `0` is a legitimate
 * value (capture nothing) and is honoured exactly.
 *
 * It is a STRICT DIGIT-STRING match rather than a `Number()` + `isInteger()` check, and the
 * unit test is what forced that: `Number("1e9")` is 1,000,000,000 and passes `isInteger`
 * cleanly, so one stray exponent in the KV would have read as a BILLION-track budget — an
 * accidental "unlimited" arriving through the very function written to make unlimited
 * unrepresentable. `Number("")` is likewise 0, which would silently turn a lost value into a
 * deliberate-looking "capture nothing". A digit string is the only thing this may accept.
 */
export function parseBudgetNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return fallback;
  }

  const parsed = Number(raw.trim());

  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/**
 * The verdict, given the switch, the budget, and the spend. PURE — the whole decision the
 * brake makes, with no database in it, so it is provable at the table rather than argued about.
 *
 * The order is the priority: the KILL SWITCH is read first and wins over everything, so a
 * paused sweep reports `paused` rather than a cap that also happens to be spent. Then the
 * count cap (the enforceable one), then the byte cap (the backstop).
 *
 * `>=` on both, never `>`: at exactly the cap the budget is SPENT, not "one more allowed".
 */
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

/**
 * Whether catalogue capture is paused — THE KILL SWITCH.
 *
 * DEFAULT-DENY, the exact inversion `publish-advance.ts` ships: only the EXPLICIT string
 * `"false"` means running. An unset key, an empty database, a fresh deploy, a preview branch,
 * a lost row, a value nobody recognises — every one of them reads as PAUSED.
 *
 * This is not defensive decoration. It is what lets the catalogue half of the capture queue
 * ship DARK: the machine can spend the operator's money on a residential proxy only because
 * he deliberately wrote `false` into this row, and anything that loses that row falls back to
 * spending nothing rather than to spending everything.
 */
export async function isCatalogueCapturePaused(): Promise<boolean> {
  return (await getSetting(CATALOGUE_CAPTURE_PAUSED_KEY)) !== "false";
}

/** Pause / resume catalogue capture. One flip, effective on the next queue read, no deploy. */
export async function setCatalogueCapturePaused(paused: boolean): Promise<void> {
  await setSetting(CATALOGUE_CAPTURE_PAUSED_KEY, paused ? "true" : "false");
}

/** The operator's two numbers, each falling back to its conservative default. */
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

/** Write either cap (or both). A non-integer / negative value is rejected by the handler. */
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

/**
 * What the CATALOGUE spent inside the rolling window.
 *
 * One indexed statement, and every clause is load-bearing:
 *
 *   - `f.track_id is null` — the catalogue half ONLY. A finding's capture is not this
 *     budget's business and can neither consume it nor be stopped by it.
 *   - `t.source_audio_attempted_at >= ?` — the window, as a RANGE SEEK on
 *     `tracks_source_audio_attempted_at_idx`. NULLs sort first in an ASC index, so the seek
 *     skips every never-attempted row — which, in a catalogue the crawler grows into five or
 *     six figures, is nearly all of them. The rows it does read are bounded by the very
 *     budget it is enforcing, so the cost of the brake cannot grow with the catalogue.
 *   - `count(*)` counts ATTEMPTS (done + unmatched + failed) — every one was a billed proxy
 *     request. `sum(coalesce(source_audio_bytes, 0))` sums what LANDED; a legacy row captured
 *     before the meter existed reads 0 rather than inflating today's spend.
 *
 * The aggregation is in SQL. Nothing but two scalars crosses the wire (docs/local-database.md
 * — never pull a column into the isolate to add it up).
 */
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

/** The whole readout — the switch, the budget, the spend, the verdict. What `/admin` shows. */
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

/**
 * THE BRAKE, as one boolean: may the capture queue hand out a CATALOGUE row right now?
 *
 * This is what `listTrackWork` calls (track-work.ts). It is deliberately the same code path
 * the `/admin` readout renders, so what the operator sees and what the machine obeys cannot
 * drift — a budget display that disagrees with the budget is worse than no display.
 */
export async function isCatalogueCaptureOpen(nowMs: number = Date.now()): Promise<boolean> {
  return (await getCatalogueCaptureState(nowMs)).open;
}
