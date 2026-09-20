// THE APIFY-FALLBACK KILL-FLAG — the operator switch that turns "out of Apify budget" from a STALL
// into a clean, self-managing state (anchor slice 3).
//
// ── THE STALL THIS FIXES ─────────────────────────────────────────────────────────────────────────
// The anchor waterfall (lib/server/anchor.ts) resolves a crawled `tracks` row to a Spotify id through
// FREE rungs (Deezer ISRC-recovery + ListenBrainz + the dark Spotify search), then a PAID Apify search
// fallback over the free-rung misses. The free rungs anchor with `stampOnMiss: false` deliberately —
// "leave Apify its turn" — so a full free-rung miss is NOT stamped `spotify_anchor_attempted_at`, and
// only the Apify rung (via `anchorTrack`) stamps the re-ask backoff (track-work.ts
// `ANCHOR_REASK_AFTER_DAYS`).
//
// When Apify hits its account cap it returns `403 "Monthly usage hard limit exceeded"`. The box sweep
// catches the failed actor run as a `skipped` chunk and continues — but a failed run posts NO
// candidates, so `anchorTrack` never runs and those rows are NEVER stamped. Un-stamped rows never enter
// the 14-day backoff, so they recirculate at the head of the anchor worklist every tick and the drain
// STALLS (observed: 0 anchored / 200 skipped per tick, the tens of thousands behind them unreachable).
//
// ── THE FLAG, DEFAULT ON ─────────────────────────────────────────────────────────────────────────
// This flag is the operator's answer: flip it OFF when out of Apify budget, and the sweep becomes a
// clean free-rungs-only drain. Two behaviours change, both driven by this ONE flag (lib/server/anchor.ts
// `resolveAnchorFree` + docs/agents/hermes/scripts/anchor-sweep.ts):
//   1. The free rungs STAMP-AND-BACK-OFF their full misses — no Apify rung is coming to take its turn,
//      so a genuinely-exhausted row backs off (14 days) instead of recirculating.
//   2. The box sweep SKIPS the Apify actor call entirely — no wasted 403s — and counts those rows as
//      honestly missed (terminal free attempt + stamp), not skipped-for-retry.
//
// It rides the same lean `settings` KV every other kill switch does (./settings.ts) — never a second
// flag mechanism. Unlike the DEFAULT-OFF dark flags (clip drip, the anchor SEARCH flag), this one is
// DEFAULT ON: the correct steady state is "Apify runs". So the read is default-ALLOW — only the exact
// string "false" disables it; an unset row, an empty database, a fresh preview, or any unrecognised
// value all read as ON. A lost row must NOT silently disable the paid rung.
//
// ── THE FLIP-ON REQUEUE — undoing the off-window priority inversion ────────────────────────────────
// While the flag is OFF the free rungs stamp-and-back-off their full misses (`resolveAnchorFree`), so
// every skipped row enters the 14-day `ANCHOR_REASK_AFTER_DAYS` backoff. But the anchor worklist is
// PRIORITY-ORDERED (track-work.ts `ANCHOR_ORDER`: ISRC-present, then embedding-present, then closeness to findings), so the
// rows skipped while OFF are the HIGHER-priority ones — and once budget returns they would still wait out
// ~14 days while Apify works lower-priority rows first. That is a priority inversion, so flipping the flag
// back ON re-queues exactly the off-window deferrals: it nulls the `spotify_anchor_attempted_at` stamp on
// every un-anchored ISRC-BEARING row stamped at-or-after the moment the flag went OFF (recorded in
// `ANCHOR_APIFY_DISABLED_AT_KEY`), so those rows re-enter the worklist and re-sort by `ANCHOR_ORDER` at
// their real priority immediately. ISRC-less deferrals stay stamped — anchoring concludes off the ISRC
// anchor in practice, so re-arming them re-bills asks that cannot conclude (`requeueOffWindowDeferrals`).
// It restores the STAMP alone: a deferral never charged the row's RETRY-CAP counter in the first place
// (`stampAnchorAttempt`'s `chargeAttempt: false`), so there is nothing here to give back.
//
// WHY THAT IS PROVABLY SAFE: while the flag is OFF the box makes ZERO Apify attempts, so EVERY stamp
// written during the off-window is a "deferred, never actually tried" stamp — never a real miss-backoff.
// Genuine Apify-attempt backoffs all PREDATE the off-window (`attempted_at < disabled_at`), so clearing
// stamps `>= disabled_at` targets ONLY the deferrals and leaves every real prior backoff untouched. The
// off-window start is stamped ONCE, on the on→off transition only (earliest-wins), so a repeated OFF→OFF
// keeps the EARLIEST time and the window covers the whole outage. The requeue is a ONE-SHOT operator write
// (the flip-ON), never a per-tick/hot path, so its full-table scan is acceptable.

// ── THE DAILY ROW BRAKE (below the flag) ──────────────────────────────────────────────────────────
// The kill-flag above is a switch: Apify runs, or it does not. Between those two states there was no
// number — the sweep sent every free-rung miss to the actor, hour after hour, and the only meter was
// Apify's own console, which nobody reads at 04:00. A per-day ROW CAP is that number. The operator's
// cap is a `settings` row (`anchor_apify_daily_rows`); the day's TALLY is not, and that split is the
// whole point of this section.
//
// THE TALLY IS A FIXED-WINDOW COUNTER, NOT A KV BLOB, BECAUSE A MONEY CAP MUST BE ATOMIC. Reading a
// `settings` row, adding one in app code and writing it back is a read-then-write race: two callers
// at cap−1 both read cap−1, both write cap, and the cap is breached. "The sweep is single-flight" is
// not the guarantee it sounds like either — an operator's attended `--limit` burn overlaps the hourly
// timer, and both reach `resolve_anchor`. A LOST UPDATE ON A SPEND METER MEANS OVER-SPEND, so the
// increment and the enforcement have to be the same statement.
//
// That statement already exists: `rate_limit_counters` + `bumpRateLimitCounter` (./rate-limit.ts) is
// the repo's ONE atomic conditional upsert — `on conflict … do update set count = count + ? where
// count + ? <= ?` with `returning count`, so at the cap the UPDATE is a no-op, RETURNING yields no
// row, and two concurrent charges can never both pass at cap−1. It is a fixed-window counter keyed
// `(action, bucket, window_start)`, and a `windowMs` of 24h aligns `window_start` to UTC midnight —
// which IS the day boundary this cap is expressed in, so the roll needs no sweep and no marker. It
// also already has retention pruning wired into the health snapshot. Reusing it is the rule about
// searching before building, and it is why this brake needs no table and no migration of its own.
//
// IT COUNTS AUTHORISATIONS, NOT RECEIPTS. The server charges when it tells the box a row is
// Apify-ELIGIBLE (anchor.ts `resolveAnchorFree`) — before the actor runs — because that is the only
// moment the server is in the loop ahead of the money. A sweep that dies between the authorisation and
// the actor over-counts by one row, which is the conservative direction: the brake reads the spend it
// AUTHORISED, never less than what was actually billed.
//
// THE BOX IS NOT THE ENFORCER. It holds an agent-scoped token and is a pinned, lagging build, so the
// cap is read and charged server-side on every `resolve_anchor`; the sweep's own preflight read of the
// cap is a courtesy that lets it stop pulling rows it cannot spend on, never the gate.

import { getDb } from "./db";
import { markDueWorkSourceMaintenanceFromSelectStatements } from "./due-work";
import { logEvent } from "./log";
import { bumpRateLimitCounter, readRateLimitCount } from "./rate-limit";
import { deleteSetting, getSetting, setSetting } from "./settings";

/** The kill-flag on the shared `settings` KV. DEFAULT ON — only the literal "false" disables it. */
export const ANCHOR_APIFY_ENABLED_KEY = "anchor_apify_enabled";

/**
 * The off-window START marker on the shared `settings` KV — an ISO-8601 timestamp (so it compares
 * lexicographically-as-chronologically against `spotify_anchor_attempted_at`, which is stored the same
 * way). Written ONCE on the on→off transition (earliest-wins across a repeated OFF→OFF), read by the
 * flip-ON requeue to bound exactly the off-window deferrals, and deleted once that requeue has run.
 */
export const ANCHOR_APIFY_DISABLED_AT_KEY = "anchor_apify_disabled_at";

/**
 * Whether the metered Apify anchor-search FALLBACK is enabled — THE KILL-FLAG, default ON.
 *
 * DEFAULT-ALLOW, the opposite of the dark flags' default-deny: ONLY the explicit string "false"
 * disables the fallback. An unset key, an empty database, a fresh preview, or any value nobody
 * recognises all read as ON. The steady state is "Apify runs"; the operator flips this to "false"
 * only while out of budget, and a lost/corrupt row falls back to the paid rung being ENABLED rather
 * than silently starving the waterfall of its last resort.
 */
export async function isAnchorApifyEnabled(): Promise<boolean> {
  return (await getSetting(ANCHOR_APIFY_ENABLED_KEY)) !== "false";
}

/** The operator's cap on catalogue rows sent to the metered Apify actor per UTC day. */
export const ANCHOR_APIFY_DAILY_ROWS_KEY = "anchor_apify_daily_rows";

/** The fixed-window counter's action key — the day's tally lives in `rate_limit_counters`. */
export const ANCHOR_APIFY_SPEND_ACTION = "anchor_apify_rows";

/**
 * Its bucket. The cap is GLOBAL (one archive, one Apify account, one bill), so there is exactly one
 * bucket and it is named rather than derived — nothing about this spend is per-caller.
 */
export const ANCHOR_APIFY_SPEND_BUCKET = "catalogue";

/** The window: 24h, which aligns `window_start` to UTC midnight and makes the roll implicit. */
export const ANCHOR_APIFY_SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The default cap: 300 rows a day.
 *
 * A row costs one keyword search at `FLUNCLE_ANCHOR_KEYWORD_LIMIT` results (3 by default) and the
 * actor bills per result, so 300 rows is a bounded few dollars a day rather than an open tab. It is
 * DELIBERATELY BELOW what the waterfall can produce: the brake should bite and be raised on purpose,
 * not sit slack and be discovered after a bill.
 */
export const ANCHOR_APIFY_DEFAULT_DAILY_ROWS = 300;

/** The Apify row brake's whole readout — the cap, the UTC day's spend, and what is left. */
export type AnchorApifyBudget = {
  /** The UTC day the tally belongs to (`YYYY-MM-DD`). */
  day: string;
  /** The operator's cap on rows per UTC day. */
  dailyRows: number;
  /** Rows left before the brake bites. Never negative. */
  remainingRows: number;
  /** Rows the server has AUTHORISED for the actor today. */
  rowsSent: number;
  /** True ⇒ the cap is reached and no further row may be sent to the actor today. */
  spent: boolean;
};

/** The UTC calendar day a tally belongs to — the window the cap is expressed in. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The cap as stored. DEFAULT-CONSERVATIVE: an unset key, an empty database, a fresh preview, or any
 * value that is not a non-negative integer all read as {@link ANCHOR_APIFY_DEFAULT_DAILY_ROWS}. A lost
 * row must never read as "unlimited" — the failure mode of a spend rail has to be the cheap one. `0`
 * IS a legal cap and means "send nothing", which is a different statement from the kill-flag being off
 * (the cap can be raised back without touching the switch — the `set_capture_budget` rule).
 */
async function readAnchorApifyDailyRows(): Promise<number> {
  const raw = await getSetting(ANCHOR_APIFY_DAILY_ROWS_KEY);
  const parsed = Number(raw);

  return raw !== undefined && Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : ANCHOR_APIFY_DEFAULT_DAILY_ROWS;
}

/** The cap and the live tally, folded into the readout shape. */
function budgetOf(dailyRows: number, rowsSent: number, now: Date): AnchorApifyBudget {
  return {
    dailyRows,
    day: utcDay(now),
    remainingRows: Math.max(0, dailyRows - rowsSent),
    rowsSent,
    spent: rowsSent >= dailyRows,
  };
}

/** Read the brake without touching it — the readout `/admin`, the CLI and the sweep's preflight share. */
export async function getAnchorApifyBudget(now: Date = new Date()): Promise<AnchorApifyBudget> {
  const [dailyRows, rowsSent] = await Promise.all([
    readAnchorApifyDailyRows(),
    readRateLimitCount({
      action: ANCHOR_APIFY_SPEND_ACTION,
      bucket: ANCHOR_APIFY_SPEND_BUCKET,
      now: now.getTime(),
      windowMs: ANCHOR_APIFY_SPEND_WINDOW_MS,
    }),
  ]);

  return budgetOf(dailyRows, rowsSent, now);
}

/**
 * Set the operator's daily row cap and read the brake back, so one call both writes and reads — the
 * `set_capture_budget` shape. The tally is untouched: raising the cap mid-day releases the rows the
 * brake is holding back rather than pretending the day started over.
 */
export async function setAnchorApifyDailyRows(
  dailyRows: number,
  now: Date = new Date(),
): Promise<AnchorApifyBudget> {
  await setSetting(ANCHOR_APIFY_DAILY_ROWS_KEY, String(Math.max(0, Math.trunc(dailyRows))));

  return getAnchorApifyBudget(now);
}

/**
 * CHARGE ONE ROW to today's tally and report the brake as it now stands — called at the single moment
 * the server authorises a row for the metered actor.
 *
 * ONE ATOMIC STATEMENT does both halves: `bumpRateLimitCounter` increments the day's counter ONLY
 * while the spend still fits under the cap, and returns nothing when it does not. So `charged` is the
 * statement's own verdict rather than a decision taken around it, and two concurrent charges at
 * cap−1 cannot both pass — which is the property a money cap has to have, because the hourly timer
 * and an operator's attended `--limit` burn genuinely do overlap.
 *
 * `charged: false` means the caller must NOT send the row. Total by contract: a database fault is
 * logged and read as "no room", the cheap failure.
 */
export async function chargeAnchorApifyRow(
  now: Date = new Date(),
): Promise<{ budget: AnchorApifyBudget; charged: boolean }> {
  try {
    const dailyRows = await readAnchorApifyDailyRows();
    const rowsSent = await bumpRateLimitCounter({
      action: ANCHOR_APIFY_SPEND_ACTION,
      bucket: ANCHOR_APIFY_SPEND_BUCKET,
      limit: dailyRows,
      now: now.getTime(),
      windowMs: ANCHOR_APIFY_SPEND_WINDOW_MS,
    });

    if (rowsSent === undefined) {
      // Refused by the statement itself. Read the tally back so the readout is honest about where
      // the day actually stands rather than asserting it equals the cap.
      return { budget: await getAnchorApifyBudget(now), charged: false };
    }

    return { budget: budgetOf(dailyRows, rowsSent, now), charged: true };
  } catch (error) {
    logEvent("warn", "anchor.apify-spend-charge-failed", { error });

    return {
      budget: { dailyRows: 0, day: utcDay(now), remainingRows: 0, rowsSent: 0, spent: true },
      charged: false,
    };
  }
}

/**
 * Re-queue exactly the off-window deferrals — the rows stamped `spotify_anchor_attempted_at` at-or-after
 * the moment the flag went OFF — by nulling that stamp so they re-enter the priority-ordered anchor
 * worklist immediately. A no-op (returns 0) when the off-window marker is unset (the flag was already on,
 * or never went off). Returns the number of rows re-queued.
 *
 * BOUNDED OPERATOR WRITE, off the hot path: this runs ONLY on the operator's flip-ON of the kill-flag,
 * never on any per-tick sweep, so a full-table scan of `tracks` here is acceptable (unlike the anchor
 * worklist read, which rides `tracks_anchor_order_idx`). The WHERE targets ONLY un-anchored rows
 * (`spotify_uri is null`) whose stamp is `>= disabled_at`: every such stamp was written while the box made
 * ZERO Apify attempts, so it is a deferral, never a genuine miss-backoff — and genuine backoffs, which all
 * predate the off-window (`attempted_at < disabled_at`), are left untouched.
 *
 * IT TOUCHES THE STAMP ALONE. The retry-cap counter (`spotify_anchor_attempts`, track-work.ts
 * `ANCHOR_MAX_ATTEMPTS`) is not given back here because it was never taken: an off-window free-rung
 * deferral is stamped WITHOUT a charge (`stampAnchorAttempt`'s `chargeAttempt: false` — an attempt is
 * spent only when a rung capable of concluding was actually asked, and while this flag is OFF none
 * is). Decrementing here would therefore refund an attempt some EARLIER real ask had honestly spent.
 *
 * ISRC-LESS ROWS ARE EXCLUDED (`has_isrc = 1`, the presence mirror — schema.ts): anchoring
 * concludes off the ISRC anchor in practice, so a bulk re-arm of ISRC-less deferrals would put a
 * wall of asks that cannot conclude straight back on the paid queue. An excluded row keeps its
 * deferral stamp and waits out the ordinary re-ask window instead of jumping the queue; it is held
 * off the paid rung by `ANCHOR_ORDER`'s `has_isrc` lead key and fed by the free `isrc-recovery`
 * pass, never by burning its finite tries on asks that could not have concluded.
 */
async function requeueOffWindowDeferrals(): Promise<number> {
  const disabledAt = await getSetting(ANCHOR_APIFY_DISABLED_AT_KEY);

  if (!disabledAt) {
    return 0;
  }

  const db = await getDb();
  const selection = {
    args: [disabledAt],
    sql: `select track_id as subject_id from tracks
          where spotify_uri is null
            and spotify_anchor_attempted_at >= ?
            and has_isrc = 1`,
  };
  const results = await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements("track", selection, {
        producer: "anchor-apify-requeue",
      }),
      {
        args: [disabledAt],
        sql: `update tracks
              set spotify_anchor_attempted_at = null
              where spotify_uri is null
                and spotify_anchor_attempted_at >= ?
                and has_isrc = 1`,
      },
    ],
    "write",
  );

  return results.at(-1)?.rowsAffected ?? 0;
}

/**
 * Flip the kill-flag (operator). Writing "false" disables the Apify fallback; anything else enables it.
 *
 * OFF (on→off): also records the off-window start (`ANCHOR_APIFY_DISABLED_AT_KEY`) — but ONLY if it is
 * not already set, so a repeated OFF→OFF keeps the EARLIEST off-time and the window covers the whole
 * outage. ON (off→on): re-queues the off-window deferrals FIRST (so the marker is still readable), then
 * clears the marker. Returns the number of rows re-queued (0 for a flip-OFF, or a flip-ON with no
 * off-window recorded).
 */
export async function setAnchorApifyEnabled(enabled: boolean): Promise<number> {
  if (!enabled) {
    await setSetting(ANCHOR_APIFY_ENABLED_KEY, "false");

    // Stamp the off-window start ONCE — only the on→off transition writes it (earliest-wins).
    if (!(await getSetting(ANCHOR_APIFY_DISABLED_AT_KEY))) {
      await setSetting(ANCHOR_APIFY_DISABLED_AT_KEY, new Date().toISOString());
    }

    return 0;
  }

  await setSetting(ANCHOR_APIFY_ENABLED_KEY, "true");

  // Re-queue while the marker is still present, THEN clear it (a failed requeue leaves the marker so a
  // later flip retries — self-healing). A no-op when the flag was already on (no marker set).
  const requeued = await requeueOffWindowDeferrals();
  await deleteSetting(ANCHOR_APIFY_DISABLED_AT_KEY);

  return requeued;
}
