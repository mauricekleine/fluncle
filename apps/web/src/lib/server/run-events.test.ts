import { describe, expect, it } from "vitest";

import {
  deriveRunOk,
  MANDATORY_SUMMARY_FIELDS,
  normalizeRunSummary,
  runDurationMs,
  runEventId,
  withRegisteredCronCadence,
} from "./run-events";

describe("normalizeRunSummary — the emitter never grades itself, but it is always recorded", () => {
  it("RECORDS a self-asserted `ok` instead of rejecting the row", () => {
    const result = normalizeRunSummary('{"errors":2,"ok":true}');

    expect(result.selfAssertedOk).toBe(true);
    expect(result.errors).toBe(2);
    expect(deriveRunOk(0, result.errors)).toBe(false);
  });

  it("records the claim even when it agrees with the numbers", () => {
    expect(normalizeRunSummary('{"errors":0,"ok":true}').selfAssertedOk).toBe(true);
    expect(normalizeRunSummary('{"errors":0,"ok":false}').selfAssertedOk).toBe(false);
  });

  it("keeps `ok` off the rename queue, but not an unreadable one", () => {
    expect(normalizeRunSummary('{"ok":true}').unrecognisedFields).toEqual([]);
    expect(normalizeRunSummary('{"ok":"yes"}')).toMatchObject({
      selfAssertedOk: null,
      unrecognisedFields: ["ok"],
    });
  });

  it("leaves selfAssertedOk NULL when the sweep claimed nothing", () => {
    expect(normalizeRunSummary('{"produced":1}').selfAssertedOk).toBeNull();
    expect(normalizeRunSummary('{"ok":null}').selfAssertedOk).toBeNull();
    expect(normalizeRunSummary(undefined).selfAssertedOk).toBeNull();
  });

  it("records the REAL nightly Sentry sweep summaries, verbatim", () => {
    const helper = normalizeRunSummary('{"candidates":3,"ok":true,"resolved":3}');

    expect(helper.summaryStatus).toBe("parsed");
    expect(helper.selfAssertedOk).toBe(true);
    expect(helper.unrecognisedFields).toEqual(["candidates", "resolved"]);
    expect(helper.missingFields).toContain("errors");

    const driver = normalizeRunSummary(
      '{"ok":true,"action":"triaged","triaged":4,"prs":2,"fetchErrors":1,"reconcile":{"candidates":3,"ok":true,"resolved":3},"comment":0}',
    );

    expect(driver.selfAssertedOk).toBe(true);
    expect(driver.errors).toBeNull();
    expect(driver.unrecognisedFields).toEqual([
      "action",
      "comment",
      "fetchErrors",
      "prs",
      "reconcile",
      "triaged",
    ]);
  });
});

describe("normalizeRunSummary — a counter is a validated integer or a 400", () => {
  it("REJECTS `errors` sent as an array", () => {
    expect(() => normalizeRunSummary('{"errors":[]}')).toThrow(
      /"errors" must be a non-negative integer/,
    );
  });

  it("REJECTS a counter sent as a string, a float, or a negative", () => {
    expect(() => normalizeRunSummary('{"produced":"7"}')).toThrow(/non-negative integer/);
    expect(() => normalizeRunSummary('{"produced":1.5}')).toThrow(/non-negative integer/);
    expect(() => normalizeRunSummary('{"produced":-1}')).toThrow(/non-negative integer/);
  });

  it("reads an explicit `null` as DECLARED-UNKNOWN, never as a violation", () => {
    const result = normalizeRunSummary('{"checked":null,"errors":0,"produced":null}');

    expect(result.checked).toBeNull();
    expect(result.produced).toBeNull();
    expect(result.errors).toBe(0);
  });

  it("keeps a declared-unknown OFF the upgrade queue, unlike an absent field", () => {
    expect(normalizeRunSummary('{"produced":null}').missingFields).not.toContain("produced");
    expect(normalizeRunSummary("{}").missingFields).toContain("produced");
  });

  it("keeps domain `failed` out of canonical errors while reading legacy run-level `error`", () => {
    expect(normalizeRunSummary('{"failed":[],"advanced":0}')).toMatchObject({
      errors: null,
      missingFields: expect.arrayContaining(["errors"]),
      unrecognisedFields: ["advanced"],
    });
    expect(normalizeRunSummary('{"failed":3}').errors).toBeNull();
    expect(normalizeRunSummary('{"error":"boom","scanned":0}').errors).toBe(1);
    expect(normalizeRunSummary('{"error":null,"scanned":0}').errors).toBe(0);
  });

  it("lets canonical `errors` win while still validating coexisting domain detail", () => {
    expect(normalizeRunSummary('{"errors":4,"failed":[],"error":"boom"}')).toMatchObject({
      errors: 4,
      unrecognisedFields: [],
    });
    expect(() => normalizeRunSummary('{"errors":0,"failed":"none"}')).toThrow(
      /non-negative integer/,
    );
    expect(() => normalizeRunSummary('{"errors":0,"error":7}')).toThrow(/string or null/);
  });

  it("keeps a genuinely absent error counter missing instead of inventing zero", () => {
    const result = normalizeRunSummary('{"advanced":0}');

    expect(result.errors).toBeNull();
    expect(result.missingFields).toContain("errors");
  });

  it("accepts 0 as a real reading, distinct from absent", () => {
    const zero = normalizeRunSummary('{"produced":0}');
    const absent = normalizeRunSummary("{}");

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

describe("normalizeRunSummary — canonical pilot counters coexist with domain detail", () => {
  it("parses the artist-credits pilot line", () => {
    const result = normalizeRunSummary(
      '{"adoptedArtists":3,"checked":5,"edgesWritten":7,"error":null,"errors":0,"matchedArtists":2,"mintedArtists":4,"ok":true,"produced":5,"rateLimited":false,"scanned":5,"skippedNoIdentity":1}',
    );

    expect(result).toMatchObject({ checked: 5, errors: 0, produced: 5 });
    expect(result.unrecognisedFields).toEqual([
      "adoptedArtists",
      "edgesWritten",
      "matchedArtists",
      "mintedArtists",
      "rateLimited",
      "scanned",
      "skippedNoIdentity",
    ]);
  });

  it("parses the crawl pilot line without folding item failures into run errors", () => {
    const result = normalizeRunSummary(
      '{"checked":8,"error":null,"errors":0,"expanded":7,"failed":1,"labelsDiscovered":["Hospital Records"],"ok":true,"pending":42,"produced":7,"queueDepth":42,"throttled":false,"tracksFound":63,"tracksSkipped":2,"tracksWritten":61}',
    );

    expect(result).toMatchObject({
      checked: 8,
      errors: 0,
      produced: 7,
      queueDepth: 42,
    });
  });

  it("parses the enrich pilot line and leaves its unknown backlog absent", () => {
    const result = normalizeRunSummary(
      '{"ok":true,"batch":4,"catalogueDone":1,"catalogueQueued":2,"checked":6,"done":3,"errors":0,"failed":1,"produced":4,"queued":50,"skipped":1}',
    );

    expect(result).toMatchObject({
      checked: 6,
      errors: 0,
      produced: 4,
      queueDepth: null,
    });
    expect(result.missingFields).toContain("queue_depth");
    expect(result.unrecognisedFields).toContain("queued");
  });

  it("parses the note pilot line and never launders queueRemaining into queue_depth", () => {
    const result = normalizeRunSummary(
      '{"ok":true,"alreadyNoted":1,"checked":4,"echoSkipped":1,"errors":0,"failed":1,"gateSkipped":0,"noted":1,"produced":1,"queueRemaining":47}',
    );

    expect(result).toMatchObject({
      checked: 4,
      errors: 0,
      produced: 1,
      queueDepth: null,
    });
    expect(result.missingFields).toContain("queue_depth");
    expect(result.unrecognisedFields).toContain("queueRemaining");
  });
});

describe("withRegisteredCronCadence — the roster owns schedule metadata", () => {
  it("pins fluncle-enrich to five minutes even when its summary claims otherwise", () => {
    const result = withRegisteredCronCadence(
      "fluncle-enrich",
      normalizeRunSummary('{"expectedIntervalMs":999999}'),
    );

    expect(result.expectedIntervalMs).toBe(300_000);
    expect(result.missingFields).not.toContain("expected_interval_ms");
  });

  it("fills cadence for absent and malformed registered summaries", () => {
    for (const raw of [undefined, "Killed (OOM)"]) {
      const result = withRegisteredCronCadence("fluncle-enrich", normalizeRunSummary(raw));

      expect(result.expectedIntervalMs).toBe(300_000);
      expect(result.missingFields).not.toContain("expected_interval_ms");
    }
  });

  it("pins a direct host writer to the cadence shared with its timer drift guard", () => {
    const result = withRegisteredCronCadence(
      "fluncle-sonar-freshen",
      normalizeRunSummary('{"expectedIntervalMs":999999}'),
    );

    expect(result.expectedIntervalMs).toBe(3_600_000);
    expect(result.missingFields).not.toContain("expected_interval_ms");
  });

  it("retains an emitted fallback for an unregistered legacy unit", () => {
    const result = withRegisteredCronCadence(
      "fluncle-legacy",
      normalizeRunSummary('{"expected_interval_ms":123456}'),
    );

    expect(result.expectedIntervalMs).toBe(123_456);
  });
});

describe("normalizeRunSummary — a page cap never becomes a backlog", () => {
  it("does NOT alias `queued` / `queueRemaining` into queue_depth", () => {
    const result = normalizeRunSummary('{"queued":50,"queueRemaining":200}');

    expect(result.queueDepth).toBeNull();
    expect(result.missingFields).toContain("queue_depth");
    expect(result.unrecognisedFields).toEqual(["queueRemaining", "queued"]);
  });

  it("accepts both canonical spellings of a compound name", () => {
    expect(normalizeRunSummary('{"queue_depth":9}').queueDepth).toBe(9);
    expect(normalizeRunSummary('{"queueDepth":9}').queueDepth).toBe(9);
    expect(normalizeRunSummary('{"expected_interval_ms":60000}').expectedIntervalMs).toBe(60_000);
    expect(normalizeRunSummary('{"vendor_calls":3}').vendorCalls).toBe(3);
  });

  it("REJECTS a field sent under two spellings at once", () => {
    expect(() => normalizeRunSummary('{"queueDepth":5,"queue_depth":9}')).toThrow(
      /more than one spelling/,
    );
  });

  it("does not call a value and a NULL a contradiction", () => {
    expect(normalizeRunSummary('{"queueDepth":5,"queue_depth":null}').queueDepth).toBe(5);
    expect(normalizeRunSummary('{"queueDepth":null,"queue_depth":9}').queueDepth).toBe(9);
    expect(normalizeRunSummary('{"queueDepth":null,"queue_depth":null}').queueDepth).toBeNull();
  });
});

describe("normalizeRunSummary — the third state", () => {
  it("keeps an admission-skipped firing visibly distinct from either payload success or failure", () => {
    const result = normalizeRunSummary(
      '{"admissionOutcome":"wait-expired","admissionWaitMs":120000,"admissionYieldReason":"queue","checked":null,"errors":0,"expectedIntervalMs":null,"gateState":"admission-skipped","payloadStarted":false,"produced":null,"queueDepth":null}',
    );

    expect(result).toMatchObject({
      checked: null,
      errors: 0,
      gateState: "admission-skipped",
      missingFields: [],
      produced: null,
      queueDepth: null,
      unrecognisedFields: [],
    });
    expect(deriveRunOk(0, result.errors)).toBe(true);
  });

  it("rejects an admission-skipped claim that could conceal a payload run", () => {
    expect(() =>
      normalizeRunSummary(
        '{"admissionOutcome":"wait-expired","admissionWaitMs":12,"admissionYieldReason":"queue","errors":0,"gateState":"admission-skipped","payloadStarted":true}',
      ),
    ).toThrow(/payloadStarted:false/);
  });

  it("reads `paused: true` as a gate and NULLS the work counters", () => {
    const result = normalizeRunSummary('{"checked":0,"paused":true,"produced":0,"queueDepth":40}');

    expect(result.gateState).toBe("paused");
    expect(result.checked).toBeNull();
    expect(result.produced).toBeNull();
    expect(result.queueDepth).toBeNull();
    expect(result.missingFields).not.toContain("produced");
    expect(result.missingFields).not.toContain("queue_depth");
    expect(result.missingFields).not.toContain("checked");
  });

  it("never suppresses `errors` under a gate", () => {
    const result = normalizeRunSummary('{"errors":3,"paused":true,"produced":0}');

    expect(result.errors).toBe(3);
    expect(result.produced).toBeNull();
    expect(deriveRunOk(0, result.errors)).toBe(false);
  });

  it("still validates a suppressed counter's TYPE", () => {
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

  it("accepts every gate an emitter would plausibly choose, and REJECTS anything outside", () => {
    expect(normalizeRunSummary('{"gateState":"disabled"}').gateState).toBe("disabled");
    expect(normalizeRunSummary('{"gate_state":"active"}').gateState).toBe("active");
    expect(normalizeRunSummary('{"gateState":"locked"}').gateState).toBe("locked");
    expect(normalizeRunSummary('{"gateState":"forced"}').gateState).toBe("forced");
    expect(normalizeRunSummary('{"gateState":"dry-run"}').gateState).toBe("dry-run");
    expect(() => normalizeRunSummary('{"gateState":"halted"}')).toThrow(/must be one of/);
    expect(() => normalizeRunSummary('{"paused":"yes"}')).toThrow(/must be a boolean/);
  });

  it("suppresses counters only for the gates that never LOOKED", () => {
    expect(
      normalizeRunSummary('{"gateState":"locked","produced":0,"queueDepth":40}'),
    ).toMatchObject({ produced: null, queueDepth: null });
    expect(
      normalizeRunSummary('{"gateState":"forced","produced":3,"queueDepth":40}'),
    ).toMatchObject({ produced: 3, queueDepth: 40 });
    expect(
      normalizeRunSummary('{"gateState":"dry-run","produced":0,"queueDepth":7}'),
    ).toMatchObject({ produced: 0, queueDepth: 7 });
  });

  it("REJECTS two gate signals at once", () => {
    expect(() => normalizeRunSummary('{"gateState":"active","paused":true}')).toThrow(
      /exactly one gate signal/,
    );
  });

  it("leaves gateState NULL when no gate was reported — absent or explicitly null", () => {
    expect(normalizeRunSummary('{"produced":1}').gateState).toBeNull();
    expect(normalizeRunSummary('{"gateState":null,"produced":1}').gateState).toBeNull();
    expect(normalizeRunSummary('{"paused":null,"produced":1}').gateState).toBeNull();
    expect(normalizeRunSummary('{"gateState":null,"paused":true}').gateState).toBe("paused");
  });

  it("records the REAL sonar-freshen and timer-watchdog lines", () => {
    const lockSkipped = normalizeRunSummary(
      '{"checked":null,"produced":null,"errors":0,"queueDepth":null,"gateState":"paused","expectedIntervalMs":3600000}',
    );

    expect(lockSkipped).toMatchObject({
      checked: null,
      errors: 0,
      gateState: "paused",
      missingFields: [],
      produced: null,
      queueDepth: null,
      selfAssertedOk: null,
      summaryStatus: "parsed",
    });

    const ordinaryTick = normalizeRunSummary(
      '{"checked":1,"produced":1,"errors":0,"queueDepth":0,"gateState":null,"expectedIntervalMs":3600000}',
    );

    expect(ordinaryTick).toMatchObject({
      checked: 1,
      gateState: null,
      missingFields: [],
      produced: 1,
      queueDepth: 0,
      selfAssertedOk: null,
    });
  });

  it("would keep the counters if an emitter named its operator modes precisely", () => {
    for (const gate of ["forced", "dry-run"]) {
      const operatorAct = normalizeRunSummary(
        `{"checked":1,"produced":1,"errors":0,"queueDepth":0,"gateState":"${gate}","expectedIntervalMs":3600000}`,
      );

      expect(operatorAct.gateState).toBe(gate);
      expect(operatorAct.produced).toBe(1);
      expect(operatorAct.queueDepth).toBe(0);
    }
  });
});

describe("normalizeRunSummary — a crashed sweep is captured, not choked on", () => {
  it("records an absent, empty, or whitespace summary as `absent`", () => {
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
    for (const raw of ["[1,2,3]", "42", '"done"', "null"]) {
      expect(normalizeRunSummary(raw).summaryStatus).toBe("not_object");
    }
  });

  it("keeps `absent` and a well-formed `{}` distinguishable", () => {
    expect(normalizeRunSummary(undefined).missingFields).toEqual(
      normalizeRunSummary("{}").missingFields,
    );
    expect(normalizeRunSummary(undefined).summaryStatus).not.toBe(
      normalizeRunSummary("{}").summaryStatus,
    );
  });
});

describe("normalizeRunSummary — unrecognised keys are recorded, never dropped", () => {
  it("recognises every projection-maintenance convergence field", () => {
    const result = normalizeRunSummary(
      JSON.stringify({
        budgetExhaustedFamilies: ["crawl_due_work"],
        converged: false,
        oldestDebtAgeMs: 120_000,
        outcome: "partial_progress",
      }),
    );

    expect(result.unrecognisedFields).toEqual([]);
  });

  it("collects unknown keys sorted", () => {
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
    expect(runDurationMs("2026-07-29T03:00:12.000Z", "2026-07-29T03:00:00.000Z")).toBeNull();
    expect(runDurationMs("not-a-time", "2026-07-29T03:00:00.000Z")).toBeNull();
    expect(runDurationMs("2026-07-29T03:00:00.000Z", "")).toBeNull();
  });
});
