// attempt-ledger.ts — the per-item attempt budget the authoring sweeps share.
//
// WHAT IT IS. A tiny on-disk counter: "how many times has the Worker judged this item's draft and
// REFUSED it?" Read at the top of a tick, written through as it is spent, and consulted before any
// model is called. It is what makes "keeps failing" BOUNDED, whatever the cause.
//
// WHY IT EXISTS. A gate rejection used to be a plain skip that left the item queued with nothing
// anywhere counting the tries — so "retry" meant "forever". That is not hypothetical: the three
// entity-bio crons re-authored three slugs ~90 times each over two days (~270 model calls) because
// their rejections were UNSATISFIABLE — the gate scanned the entity's own NAME, so an artist called
// "Future Signal" could not be written about at all. THE NAME EXEMPTION
// (apps/web/src/lib/server/observation.ts) fixes that root cause everywhere. This is the BACKSTOP
// that bounds the next unsatisfiable rejection, whatever it turns out to be.
//
// THE SIBLING SWEEPS HAD THE SAME SHAPE AND A WORSE QUEUE. note-sweep, observe-sweep and
// logbook-sweep all run BATCH_CAP=1 over an oldest-first worklist, so an item that can never pass
// does not merely waste its own tokens — it sits at the head and blocks EVERY item behind it,
// forever. `selectWork` is the half of this module that fixes that, and it matters more than the
// budget itself.
//
// WHAT IT DELIBERATELY DOES NOT DO — the operator's ruling, 2026-07-30. The bio sweep pairs its
// budget with a FINAL-ATTEMPT ACCEPTANCE: the third bio lands even if the voice gate refused it,
// because an entity page with an empty bio slot is a half-built page. THE SIBLINGS GET NO SUCH
// BYPASS. A note, an observation and a logbook entry are OPTIONAL editorial: an absent one is a
// perfectly good state the unlit register already handles, and publishing copy Fluncle's own voice
// gate refused is strictly worse than saying nothing. So a budget-exhausted item is simply SKIPPED
// — never published, never retried — and that fact is counted in the tick's summary.
//
// THE SHAPE is render-conductor's poison ledger (`logId<TAB>count<TAB>lastFailEpoch`), because it
// is the same job: remember, across processes, how many times we have burned a budget on one item.
// An entry is DROPPED the moment the item finishes, so the file holds only in-flight and exhausted
// items — a handful of lines, never a corpus. Losing it (a box rebuild) costs at most one fresh
// budget per stuck item, and deleting a line is exactly how an operator re-arms an item after the
// gate or the prompt changes.
//
// NOTE FOR A FUTURE READER: entity-bio-sweep.ts still carries its own copy of this ledger. It was
// left alone on purpose while a separate slice was in flight over that file; folding it onto this
// module (its `planAttempt` additionally returns `final`, which this one has no use for) is a
// mechanical follow-up, not a redesign.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One item's budget state: refused passes so far, and when the last one was. */
export type AttemptRecord = { attempts: number; lastAttemptEpoch: number };

/** The whole ledger, keyed by whatever the sweep calls an item (a finding id, a sector, a slug). */
export type AttemptLedger = Map<string, AttemptRecord>;

/**
 * Where one sweep's ledger lives. `$HOME` is the mounted, backed-up data root on the box (the same
 * anchor render-conductor's poison ledger and the cron output markers hang off), so the count
 * survives a tick, a container swap, and a rebake. Each sweep passes its own `<name>` and exposes
 * an env override so its tests (and an operator move) can point it elsewhere.
 */
export function attemptLedgerPath(stateDir: string): string {
  return join(stateDir, "attempts");
}

/** The default state dir for a sweep: `$HOME/.<name>`, matching entity-bio-sweep's layout. */
export function defaultStateDir(name: string): string {
  return join(process.env.HOME ?? "/opt/data/home", `.${name}`);
}

/**
 * Parse the TSV. TOTAL: a malformed or truncated line is dropped, never thrown on — a corrupt
 * ledger must degrade to "no memory", which costs one budget, not a dead cron.
 */
export function parseAttemptLedger(text: string): AttemptLedger {
  const ledger: AttemptLedger = new Map();

  for (const line of text.split("\n")) {
    const [key, attempts, epoch] = line.split("\t");
    const parsed = Number.parseInt(attempts ?? "", 10);

    if (!key || !Number.isFinite(parsed) || parsed <= 0) {
      continue;
    }

    const parsedEpoch = Number.parseInt(epoch ?? "", 10);

    ledger.set(key, {
      attempts: parsed,
      lastAttemptEpoch: Number.isFinite(parsedEpoch) ? parsedEpoch : 0,
    });
  }

  return ledger;
}

/** Serialise the ledger back to TSV, key-sorted so the file is stable and diffable by eye. */
export function formatAttemptLedger(ledger: AttemptLedger): string {
  return [...ledger.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, record]) => `${key}\t${record.attempts}\t${record.lastAttemptEpoch}`)
    .join("\n");
}

/**
 * What the budget says about one item RIGHT NOW:
 *   - `spent`     — PASSES THE WORKER JUDGED AND REFUSED (persisted). Not "model calls made":
 *                   see `recordAttempt` for why only a refusal may spend the budget.
 *   - `exhausted` — the budget is gone; this item must never be authored for again.
 *   - `attempt`   — the 1-based number of the pass we are about to make.
 *
 * There is deliberately no `final` flag. The siblings have NO final-attempt bypass (see the header):
 * the last pass is judged by exactly the same gate as the first, and a draft it refuses is not
 * published. "Final" would only ever mean "publish this one anyway", which is the thing the
 * operator ruled out.
 */
export function planAttempt(
  ledger: AttemptLedger,
  key: string,
  maxAttempts: number,
): { attempt: number; exhausted: boolean; spent: number } {
  const spent = ledger.get(key)?.attempts ?? 0;

  return { attempt: spent + 1, exhausted: spent >= maxAttempts, spent };
}

/**
 * Burn one attempt — called ONLY when the Worker has judged a draft and REFUSED it (a voice-gate
 * or length rejection, or an echo-gate rejection), never on a transport or model failure.
 *
 * THE DISTINCTION THE WHOLE BUDGET RESTS ON. A gate rejection is deterministic evidence that THIS
 * DRAFT was bad — the Worker read it and refused it. A `claude -p` that exits non-zero, returns
 * `is_error`, or returns nothing says something about the infrastructure and NOTHING about the
 * item; there is no draft to have judged. If flaky infrastructure could spend the budget, three bad
 * minutes would write an item off permanently through no fault of its own. Those failures already
 * log a line the `/status` sweep-strain detector scores, so they are not unwatched.
 */
export function recordAttempt(ledger: AttemptLedger, key: string, nowEpoch: number): AttemptLedger {
  ledger.set(key, {
    attempts: (ledger.get(key)?.attempts ?? 0) + 1,
    lastAttemptEpoch: nowEpoch,
  });

  return ledger;
}

/** Forget an item: its artifact landed (or an operator's did), so the budget is no longer owed. */
export function clearAttempts(ledger: AttemptLedger, key: string): AttemptLedger {
  ledger.delete(key);

  return ledger;
}

/**
 * Split a worklist into the rows this tick may work and the rows whose budget is gone.
 *
 * THE HEAD-OF-LINE RULE, and it is the load-bearing half of this module. These sweeps read an
 * OLDEST-FIRST queue and take BATCH_CAP=1 off the front, so an exhausted item at the head would
 * otherwise block every item behind it forever — trading an unbounded retry loop for a permanently
 * stalled sweep, which is strictly worse (the loop at least made progress on nothing; a stall makes
 * progress on nothing AND hides it). Exhausted rows are therefore filtered out BEFORE the cap is
 * applied (render-conductor's poisoned-head window, same reasoning), so a spent budget only ever
 * costs the item that spent it.
 *
 * `keyOf` returns null for a row this sweep cannot key (a queue item with no id); such a row is
 * passed through as work so the sweep's own "no id — skipping" path reports it, exactly as before.
 */
export function selectWork<T>(
  queue: readonly T[],
  ledger: AttemptLedger,
  keyOf: (row: T) => string | null,
  cap: number,
  maxAttempts: number,
): { exhausted: T[]; work: T[] } {
  const exhausted: T[] = [];
  const workable: T[] = [];

  for (const row of queue) {
    const key = keyOf(row);

    if (key !== null && planAttempt(ledger, key, maxAttempts).exhausted) {
      exhausted.push(row);
      continue;
    }

    workable.push(row);
  }

  return { exhausted, work: workable.slice(0, cap) };
}

/** Read a ledger off disk. A missing/unreadable file is an EMPTY ledger, never an error. */
export function readAttemptLedger(path: string): AttemptLedger {
  try {
    return parseAttemptLedger(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
}

/**
 * Persist a ledger. Best-effort: a failed write costs one budget, it must never kill the tick. The
 * failure is announced through the caller's own `log` so it lands in that sweep's stderr with its
 * prefix (and scores on the `/status` strain detector's "could not").
 */
export function writeAttemptLedger(
  path: string,
  ledger: AttemptLedger,
  log: (message: string) => void,
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${formatAttemptLedger(ledger)}\n`, "utf8");
  } catch (error) {
    log(
      `could not persist the attempt ledger (${error instanceof Error ? error.message : String(error)}) — the budget may be re-spent next tick`,
    );
  }
}

/**
 * The once-per-tick recap of the items this sweep is no longer working.
 *
 * DELIBERATELY OUTSIDE THE STRAIN VOCABULARY (fluncle-healthcheck.ts `STRAIN_PHRASES`): each of
 * these was already reported as distress on the tick it exhausted, and this line repeats every tick
 * for as long as they sit in the queue — scoring it would accrue a point an hour forever for a
 * known, steady state, and a `degraded` that can never clear is noise. Its wording is scored by a
 * test rather than trusted.
 */
export function exhaustedRecapLine(
  noun: string,
  keys: readonly string[],
  maxAttempts: number,
): string {
  return `not working ${keys.length} exhausted ${noun}(s) — ${maxAttempts} drafts spent each (${keys.slice(0, 10).join(", ")})`;
}

/**
 * The WORKABLE queue depth left after this tick: the depth AT READ TIME minus what finished and
 * minus the EXHAUSTED rows, which are still queued server-side but are no longer work this sweep
 * will ever do. Gate-skips and failures keep their remaining budget and stay counted.
 */
export function remainingQueueDepth(
  queueLength: number,
  finished: number,
  exhausted: number,
): number {
  return Math.max(0, queueLength - finished - exhausted);
}
