import { describe, expect, it } from "vitest";

import {
  deriveRunOk,
  MANDATORY_SUMMARY_FIELDS,
  normalizeRunSummary,
  runDurationMs,
  runEventId,
} from "./run-events";

// The PURE half of the run ledger — every rule the design earned, each pinned by the
// defect that earned it. The SQL half is `run-events.integration.test.ts`.
//
// Read this file as the specification: if a rule below can be deleted from
// `run-events.ts` without a test here going red, the rule is decoration. Each case names
// what actually went wrong in production, because "a number was printed and read by
// nobody" is precisely the failure this ledger exists to end — and a test that passes
// before and after a fix would repeat it.

describe("normalizeRunSummary — the emitter never grades itself", () => {
  it("REJECTS a summary carrying its own `ok`", () => {
    // THE ELEVEN-NIGHT DEFECT, verbatim: the nightly Sentry sweep exited 0 while printing
    // a hardcoded `ok:true` next to the `errors:2` that contradicted it. Merely ignoring
    // `ok` would derive the right verdict and leave the lie in place to mislead the next
    // reader of the raw log; rejecting it forces the emitter to stop claiming.
    expect(() => normalizeRunSummary('{"errors":2,"ok":true}')).toThrow(/must not carry "ok"/);
  });

  it("REJECTS `ok` even when it agrees with the numbers", () => {
    // The rule is about AUTHORITY, not about catching disagreement. An `ok` that happens
    // to be right today is an `ok` that can go stale tomorrow without anything noticing.
    expect(() => normalizeRunSummary('{"errors":0,"ok":true}')).toThrow(/must not carry "ok"/);
  });
});

describe("normalizeRunSummary — a counter is a validated integer or a 400", () => {
  it("REJECTS `errors` sent as an array (the real `failed:[]` shape)", () => {
    // A naive `typeof value === "number"` guard drops this SILENTLY: `errors` stores NULL,
    // `ok` falls back to the exit code alone, and a sweep that reported failures reads
    // healthy. Real sweeps in this fleet emit exactly this shape.
    expect(() => normalizeRunSummary('{"errors":[]}')).toThrow(
      /"errors" must be a non-negative integer/,
    );
  });

  it("REJECTS a counter sent as a string, a float, a negative, or null", () => {
    expect(() => normalizeRunSummary('{"produced":"7"}')).toThrow(/non-negative integer/);
    expect(() => normalizeRunSummary('{"produced":1.5}')).toThrow(/non-negative integer/);
    expect(() => normalizeRunSummary('{"produced":-1}')).toThrow(/non-negative integer/);
    expect(() => normalizeRunSummary('{"produced":null}')).toThrow(/non-negative integer/);
  });

  it("accepts 0 as a real reading, distinct from absent", () => {
    const zero = normalizeRunSummary('{"produced":0}');
    const absent = normalizeRunSummary("{}");

    // "I ran and wrote nothing" and "I never said" must never collapse into one value —
    // the alarm conjunction reads one of them and ignores the other.
    expect(zero.produced).toBe(0);
    expect(zero.missingFields).not.toContain("produced");
    expect(absent.produced).toBeNull();
    expect(absent.missingFields).toContain("produced");
  });
});

describe("normalizeRunSummary — missing fields are recorded, never guessed", () => {
  it("lists every mandatory field a bare `{}` did not carry", () => {
    const result = normalizeRunSummary("{}");

    expect(result.summaryStatus).toBe("parsed");
    expect(result.missingFields).toEqual([...MANDATORY_SUMMARY_FIELDS]);
  });

  it("leaves `vendor_calls` off the upgrade queue (RESERVED in v1)", () => {
    // v1 fills it opportunistically from sweeps that already emit a vendor-shaped count.
    // Filing it against every sweep would pad the worklist with an item nobody agreed to.
    expect(normalizeRunSummary("{}").missingFields).not.toContain("vendor_calls");
  });

  it("records a fully-reported summary as owing nothing", () => {
    const result = normalizeRunSummary(
      '{"checked":120,"errors":0,"expectedIntervalMs":3600000,"produced":4,"queueDepth":17,"vendorCalls":9}',
    );

    expect(result.missingFields).toEqual([]);
    expect(result).toMatchObject({
      checked: 120,
      errors: 0,
      expectedIntervalMs: 3_600_000,
      produced: 4,
      queueDepth: 17,
      vendorCalls: 9,
    });
  });
});

describe("normalizeRunSummary — a page cap never becomes a backlog", () => {
  it("does NOT alias `queued` / `queueRemaining` into queue_depth", () => {
    // `queueDepth:24` was measured to be `QUEUE_LIMIT`; `queued:50` and
    // `queueRemaining:200` are the same illusion under other names. Aliasing one in would
    // manufacture a backlog out of a pagination constant and fire (or silence) the
    // `produced == 0 AND queue_depth > 0` alarm on a fiction.
    const result = normalizeRunSummary('{"queued":50,"queueRemaining":200}');

    expect(result.queueDepth).toBeNull();
    expect(result.missingFields).toContain("queue_depth");
    expect(result.unrecognisedFields).toEqual(["queueRemaining", "queued"]);
  });

  it("accepts both canonical spellings of a compound name", () => {
    // bash writes snake_case, the JS sweeps write camelCase — the SAME semantic under two
    // skins, which is not the aliasing the rule above forbids.
    expect(normalizeRunSummary('{"queue_depth":9}').queueDepth).toBe(9);
    expect(normalizeRunSummary('{"queueDepth":9}').queueDepth).toBe(9);
    expect(normalizeRunSummary('{"expected_interval_ms":60000}').expectedIntervalMs).toBe(60_000);
    expect(normalizeRunSummary('{"vendor_calls":3}').vendorCalls).toBe(3);
  });

  it("REJECTS a field sent under two spellings at once", () => {
    // A summary saying both `queueDepth:5` and `queue_depth:9` is a contradiction, and a
    // ledger built to catch contradictions cannot begin by quietly picking a winner.
    expect(() => normalizeRunSummary('{"queueDepth":5,"queue_depth":9}')).toThrow(
      /more than one spelling/,
    );
  });
});

describe("normalizeRunSummary — the third state", () => {
  it("reads `paused: true` as a gate and NULLS the work counters", () => {
    // Rule 5: 0 means "I tried and found nothing"; a paused sweep did not try. Storing its
    // reported zeros would fire `produced == 0 AND queue_depth > 0` on a sweep that is
    // merely switched off — the cost-ledger posture ("a rate-miss is unpriced, never $0").
    const result = normalizeRunSummary('{"checked":0,"paused":true,"produced":0,"queueDepth":40}');

    expect(result.gateState).toBe("paused");
    expect(result.checked).toBeNull();
    expect(result.produced).toBeNull();
    expect(result.queueDepth).toBeNull();
    // And it owes nothing: demanding counters from a sweep that did not run is nonsense.
    expect(result.missingFields).not.toContain("produced");
    expect(result.missingFields).not.toContain("queue_depth");
    expect(result.missingFields).not.toContain("checked");
  });

  it("never suppresses `errors` under a gate", () => {
    // `errors` is a FAILURE signal, not a work volume. Suppressing it would launder a real
    // failure — the same crime as laundering a page cap, in the opposite direction.
    const result = normalizeRunSummary('{"errors":3,"paused":true,"produced":0}');

    expect(result.errors).toBe(3);
    expect(result.produced).toBeNull();
    expect(deriveRunOk(0, result.errors)).toBe(false);
  });

  it("still validates a suppressed counter's TYPE", () => {
    // Suppression is about not laundering a number, not about skipping the check — a gated
    // sweep emitting `produced: "lots"` is still a broken emitter.
    expect(() => normalizeRunSummary('{"paused":true,"produced":"lots"}')).toThrow(
      /non-negative integer/,
    );
  });

  it("maps `paused: false` to active and keeps the counters", () => {
    const result = normalizeRunSummary('{"paused":false,"produced":0,"queueDepth":40}');

    expect(result.gateState).toBe("active");
    expect(result.produced).toBe(0);
    expect(result.queueDepth).toBe(40);
  });

  it("accepts the explicit gate vocabulary and REJECTS anything outside it", () => {
    expect(normalizeRunSummary('{"gateState":"disabled"}').gateState).toBe("disabled");
    expect(normalizeRunSummary('{"gate_state":"active"}').gateState).toBe("active");
    expect(() => normalizeRunSummary('{"gateState":"halted"}')).toThrow(
      /one of active\/disabled\/paused/,
    );
    expect(() => normalizeRunSummary('{"paused":"yes"}')).toThrow(/must be a boolean/);
  });

  it("REJECTS two gate signals at once", () => {
    expect(() => normalizeRunSummary('{"gateState":"active","paused":true}')).toThrow(
      /exactly one gate signal/,
    );
  });

  it("leaves gateState NULL when no gate was reported", () => {
    // Most sweeps have no kill switch; a NULL gate says "not reported", which is honest.
    expect(normalizeRunSummary('{"produced":1}').gateState).toBeNull();
  });
});

describe("normalizeRunSummary — a crashed sweep is captured, not choked on", () => {
  it("records an absent, empty, or whitespace summary as `absent`", () => {
    // A sweep that died before printing anything is the case the ledger MOST needs to
    // hold. Throwing here would blind it exactly where the failure is worst.
    for (const raw of [undefined, null, "", "   \n"]) {
      const result = normalizeRunSummary(raw);

      expect(result.summaryStatus).toBe("absent");
      expect(result.missingFields).toEqual([...MANDATORY_SUMMARY_FIELDS]);
    }
  });

  it("records unparseable text as `malformed`", () => {
    const result = normalizeRunSummary("Traceback (most recent call last):");

    expect(result.summaryStatus).toBe("malformed");
    expect(result.produced).toBeNull();
  });

  it("records valid JSON that is not an object as `not_object`", () => {
    // An array, a number, a bare string and `null` are all valid JSON and all useless as a
    // summary — and all distinguishable from "never printed", which is the point.
    for (const raw of ["[1,2,3]", "42", '"done"', "null"]) {
      expect(normalizeRunSummary(raw).summaryStatus).toBe("not_object");
    }
  });

  it("keeps `absent` and a well-formed `{}` distinguishable", () => {
    // Both owe every mandatory field, so `missing_fields` alone cannot tell them apart —
    // which is why `summary_status` exists. Without it a dead sweep reads as a merely
    // unimproved one.
    expect(normalizeRunSummary(undefined).missingFields).toEqual(
      normalizeRunSummary("{}").missingFields,
    );
    expect(normalizeRunSummary(undefined).summaryStatus).not.toBe(
      normalizeRunSummary("{}").summaryStatus,
    );
  });
});

describe("normalizeRunSummary — unrecognised keys are recorded, never dropped", () => {
  it("collects unknown keys sorted", () => {
    // `isrcRecoveredByDeezer: 0` was printed for seven days and read by nobody. It lands
    // here now — the other half of the upgrade queue: `missing_fields` says what to ADD,
    // this says what to RENAME.
    const result = normalizeRunSummary('{"isrcRecoveredByDeezer":0,"attempted":12}');

    expect(result.unrecognisedFields).toEqual(["attempted", "isrcRecoveredByDeezer"]);
  });

  it("bounds the list and COUNTS the overflow rather than dropping it", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`k${String(index).padStart(2, "0")}`, index]),
    );
    const result = normalizeRunSummary(JSON.stringify(wide));

    expect(result.unrecognisedFields).toHaveLength(33);
    expect(result.unrecognisedFields.at(-1)).toBe("+8 more");
  });

  it("truncates an absurd key name instead of letting it dominate the row", () => {
    const result = normalizeRunSummary(JSON.stringify({ [`x${"y".repeat(200)}`]: 1 }));

    expect(result.unrecognisedFields[0]).toHaveLength(64);
    expect(result.unrecognisedFields[0]?.endsWith("…")).toBe(true);
  });
});

describe("deriveRunOk — the single most important line", () => {
  it("needs BOTH a clean exit and zero errors", () => {
    expect(deriveRunOk(0, 0)).toBe(true);
    expect(deriveRunOk(0, 2)).toBe(false);
    expect(deriveRunOk(1, 0)).toBe(false);
    expect(deriveRunOk(1, 2)).toBe(false);
  });

  it("falls back to the exit code when the sweep never reported errors", () => {
    // The honest reading of "I don't know": trust what we do know, and put `errors` on
    // that sweep's upgrade queue for exactly this reason.
    expect(deriveRunOk(0, null)).toBe(true);
    expect(deriveRunOk(137, null)).toBe(false);
  });
});

describe("runEventId + runDurationMs", () => {
  it("is deterministic in unit + start, so a retry collapses", () => {
    const parts = { startedAt: "2026-07-29T03:00:00.000Z", unit: "fluncle-enrich" };

    expect(runEventId(parts)).toBe(runEventId(parts));
    expect(runEventId(parts)).toBe("fluncle-enrich:2026-07-29T03:00:00.000Z");
    expect(runEventId({ ...parts, unit: "fluncle-note" })).not.toBe(runEventId(parts));
  });

  it("measures a duration and reports an impossible one as UNKNOWN", () => {
    expect(runDurationMs("2026-07-29T03:00:00.000Z", "2026-07-29T03:00:12.500Z")).toBe(12_500);
    // Backwards (clock skew) and unparseable are both NULL, never 0 — 0 would read as an
    // instantaneous run, which is a different and false claim.
    expect(runDurationMs("2026-07-29T03:00:12.000Z", "2026-07-29T03:00:00.000Z")).toBeNull();
    expect(runDurationMs("not-a-time", "2026-07-29T03:00:00.000Z")).toBeNull();
    expect(runDurationMs("2026-07-29T03:00:00.000Z", "")).toBeNull();
  });
});
