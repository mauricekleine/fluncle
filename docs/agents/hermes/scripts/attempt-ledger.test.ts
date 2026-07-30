// Unit tests for attempt-ledger.ts — the per-item attempt budget the note / observation / logbook
// sweeps share. The box scripts are self-contained (they cannot import the workspace) and live
// outside any package's test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/attempt-ledger.test.ts
//
// The bug this bounds: a gate rejection was a plain skip that left the item queued with nothing
// counting the tries, so "retry" meant "forever". The entity-bio version of the same shape burned
// ~270 model calls on three entities over two days. The siblings' queues are worse — BATCH_CAP=1
// over an oldest-first worklist — so the half of this module that matters most is `selectWork`:
// without it a permanently-failing HEAD blocks every item behind it, which trades an unbounded
// loop for a permanent stall.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttemptLedger,
  attemptLedgerPath,
  clearAttempts,
  defaultStateDir,
  exhaustedRecapLine,
  formatAttemptLedger,
  parseAttemptLedger,
  planAttempt,
  readAttemptLedger,
  recordAttempt,
  remainingQueueDepth,
  selectWork,
  writeAttemptLedger,
} from "./attempt-ledger";
import { countDistressLines } from "./fluncle-healthcheck";

const MAX = 3;

describe("the attempt ledger (the count that survives a tick)", () => {
  test("round-trips through the on-disk TSV, so a fresh process reads what the last one spent", () => {
    const ledger: AttemptLedger = new Map();

    recordAttempt(ledger, "011.5.9D", 1700000000);
    recordAttempt(ledger, "011.5.9D", 1700000060);
    recordAttempt(ledger, "36", 1700000120);

    const reloaded = parseAttemptLedger(formatAttemptLedger(ledger));

    expect(reloaded.get("011.5.9D")?.attempts).toBe(2);
    expect(reloaded.get("36")?.attempts).toBe(1);
    expect(reloaded.get("011.5.9D")?.lastAttemptEpoch).toBe(1700000060);
  });

  test("a corrupt or truncated ledger degrades to NO memory, never to a throw", () => {
    const ledger = parseAttemptLedger("\nnot-a-row\nx\tNaN\t0\ny\t2\t123\n\t\t\n");

    expect([...ledger.keys()]).toEqual(["y"]);
    expect(parseAttemptLedger("")).toEqual(new Map());
  });

  test("plans attempts 1..3 and calls the 4th exhausted — with NO final-attempt flag", () => {
    const ledger: AttemptLedger = new Map();

    expect(planAttempt(ledger, "x", MAX)).toEqual({ attempt: 1, exhausted: false, spent: 0 });

    recordAttempt(ledger, "x", 1);
    expect(planAttempt(ledger, "x", MAX)).toEqual({ attempt: 2, exhausted: false, spent: 1 });

    recordAttempt(ledger, "x", 2);
    // The LAST pass. The bio sweep marks this one "final" and publishes its draft regardless; the
    // siblings deliberately carry no such flag — a refused third draft is discarded like the first.
    expect(planAttempt(ledger, "x", MAX)).toEqual({ attempt: 3, exhausted: false, spent: 2 });

    recordAttempt(ledger, "x", 3);
    expect(planAttempt(ledger, "x", MAX).exhausted).toBe(true);
  });

  test("a landed artifact CLEARS the budget, so a re-queued item starts fresh", () => {
    const ledger: AttemptLedger = new Map();

    recordAttempt(ledger, "x", 1);
    clearAttempts(ledger, "x");

    expect(planAttempt(ledger, "x", MAX)).toMatchObject({ attempt: 1, exhausted: false });
  });

  test("reads a missing ledger as empty, and persists one it can then read back", () => {
    const dir = mkdtempSync(join(tmpdir(), "attempt-ledger-test-"));

    try {
      const path = attemptLedgerPath(join(dir, "state"));

      expect(readAttemptLedger(path)).toEqual(new Map());

      const ledger: AttemptLedger = new Map();

      recordAttempt(ledger, "011.5.9D", 42);
      writeAttemptLedger(path, ledger, () => {
        throw new Error("the write must not have failed");
      });

      expect(readAttemptLedger(path).get("011.5.9D")?.attempts).toBe(1);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("a failed persist is ANNOUNCED, never thrown — a full disk must not kill the tick", () => {
    const dir = mkdtempSync(join(tmpdir(), "attempt-ledger-test-"));

    try {
      // A FILE where the state DIR should be, so mkdirSync + writeFileSync both fail.
      const blocker = join(dir, "blocked");

      writeFileSync(blocker, "not a directory", "utf8");

      const lines: string[] = [];

      expect(() =>
        writeAttemptLedger(attemptLedgerPath(blocker), new Map(), (message) => lines.push(message)),
      ).not.toThrow();
      expect(lines.join("\n")).toContain("could not persist the attempt ledger");
      // …and it says so in the strain detector's vocabulary, because a budget that silently stops
      // persisting is a budget that silently stops bounding anything.
      expect(countDistressLines(lines.join("\n"))).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("defaultStateDir hangs off $HOME, the box's mounted data root", () => {
    expect(defaultStateDir("note-sweep").endsWith("/.note-sweep")).toBe(true);
  });
});

// ── THE HEAD-OF-LINE RULE ──────────────────────────────────────────────────────────────
//
// The reason this module exists at all. These sweeps take BATCH_CAP=1 off the FRONT of an
// oldest-first worklist, so a budget alone is not enough: an exhausted item at the head would be
// picked every tick, skipped, and nothing behind it would ever be worked again.

describe("selectWork (an exhausted item must not block the queue)", () => {
  const QUEUE = [{ id: "spent" }, { id: "fresh" }, { id: "also-fresh" }];
  const keyOf = (row: { id?: string }) => row.id ?? null;

  function spend(ledger: AttemptLedger, key: string, times: number): AttemptLedger {
    for (let i = 0; i < times; i += 1) {
      recordAttempt(ledger, key, i);
    }

    return ledger;
  }

  test("drops exhausted rows BEFORE the cap, so a cap-1 tick works the next LIVE row", () => {
    const ledger = spend(new Map(), "spent", MAX);

    const { exhausted, work } = selectWork(QUEUE, ledger, keyOf, 1, MAX);

    expect(exhausted.map((row) => row.id)).toEqual(["spent"]);
    // Without this the sweep would spend every tick meeting the same dead head forever, and the
    // findings behind it would never be reached — a permanent stall, worse than the retry loop.
    expect(work.map((row) => row.id)).toEqual(["fresh"]);
  });

  test("skips PAST several dead heads in one go", () => {
    const ledger = spend(spend(new Map(), "spent", MAX), "fresh", MAX);

    const { exhausted, work } = selectWork(QUEUE, ledger, keyOf, 1, MAX);

    expect(exhausted.map((row) => row.id)).toEqual(["spent", "fresh"]);
    expect(work.map((row) => row.id)).toEqual(["also-fresh"]);
  });

  test("an item with budget LEFT keeps its place at the head", () => {
    const ledger = spend(new Map(), "spent", MAX - 1);

    const { exhausted, work } = selectWork(QUEUE, ledger, keyOf, 1, MAX);

    expect(exhausted).toEqual([]);
    expect(work.map((row) => row.id)).toEqual(["spent"]);
  });

  test("passes an untouched queue straight through, capped", () => {
    const { exhausted, work } = selectWork(QUEUE, new Map(), keyOf, 2, MAX);

    expect(exhausted).toEqual([]);
    expect(work.map((row) => row.id)).toEqual(["spent", "fresh"]);
  });

  test("a row with no key is WORK, so the sweep's own 'no id' path still reports it", () => {
    const { exhausted, work } = selectWork([{}], new Map(), keyOf, 1, MAX);

    expect(exhausted).toEqual([]);
    expect(work).toEqual([{}]);
  });
});

describe("the summary arithmetic", () => {
  test("remainingQueueDepth subtracts finished AND exhausted rows", () => {
    expect(remainingQueueDepth(10, 3, 3)).toBe(4);
  });

  test("…and never goes negative", () => {
    expect(remainingQueueDepth(1, 3, 3)).toBe(0);
  });

  test("the per-tick exhausted RECAP is silent to the strain detector", () => {
    // It repeats every tick for as long as the dead items sit in the queue. Each exhaustion was
    // already reported as distress once, on the tick it happened; scoring the recap too would
    // accrue a point per tick forever for a known steady state — a `degraded` that can never clear.
    const recap = exhaustedRecapLine("finding", ["011.5.9D", "012.1.0A"], MAX);

    expect(recap).toContain("2 exhausted finding(s)");
    expect(countDistressLines(recap)).toBe(0);
  });
});
