// Unit tests for the verify-captures backfill's drain loop (verify-captures.ts). Every effect is
// injected (VerifyDeps) — no R2, no fpcalc, no network — so the verdict derivation, the routing
// tally, the skip-not-stamp discipline, and the per-row isolation are proven with stubs:
//
//   bun test docs/agents/hermes/scripts/verify-captures.test.ts
import { describe, expect, mock, test } from "bun:test";
import {
  deriveVerdict,
  runVerifyTick,
  type VerifyDeps,
  type VerifyWorkItem,
} from "./verify-captures";

// A contained-match pair (preview excerpt inside the capture) and an unrelated pair, built the
// same way fingerprint-match.test.ts builds them.
function randomFingerprint(length: number, seed: number): number[] {
  const out: number[] = [];
  let state = seed >>> 0;

  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out.push(state | 0);
  }

  return out;
}

const CAPTURE_FP = randomFingerprint(2000, 42);
const PREVIEW_FP = CAPTURE_FP.slice(800, 1040); // a true 30s excerpt
const WRONG_FP = randomFingerprint(240, 999); // a different recording's preview

describe("deriveVerdict", () => {
  test("no preview fingerprint → no-preview (the abstain)", () => {
    expect(deriveVerdict(null, CAPTURE_FP)).toBe("no-preview");
  });

  test("no CAPTURE fingerprint → null (a decode problem is a skip, never a stamp)", () => {
    expect(deriveVerdict(PREVIEW_FP, null)).toBeNull();
  });

  test("a contained excerpt → match; an unrelated preview → mismatch", () => {
    expect(deriveVerdict(PREVIEW_FP, CAPTURE_FP)).toBe("match");
    expect(deriveVerdict(WRONG_FP, CAPTURE_FP)).toBe("mismatch");
  });

  test("an inconclusive (too-short) fingerprint abstains rather than accusing", () => {
    expect(deriveVerdict(PREVIEW_FP.slice(0, 5), CAPTURE_FP)).toBe("no-preview");
  });
});

type DepsOverrides = Partial<VerifyDeps> & { queue?: VerifyWorkItem[] };

// The server's routing, mirrored for the stub: match/no-preview stamp, a catalogue mismatch
// quarantines, a finding mismatch raises the attention item. `certifiedIds` marks the findings.
function stubDeps(overrides: DepsOverrides, certifiedIds: Set<string> = new Set()): VerifyDeps {
  const queue = overrides.queue ?? [];

  return {
    fetchCapture: overrides.fetchCapture ?? (async () => "/tmp/fake-capture.webm"),
    fetchPreviewFp: overrides.fetchPreviewFp ?? (async () => PREVIEW_FP),
    fetchQueue: overrides.fetchQueue ?? (async () => queue),
    fingerprintFile: overrides.fingerprintFile ?? (() => CAPTURE_FP),
    log: overrides.log ?? (() => undefined),
    mkWorkdir: overrides.mkWorkdir ?? (() => "/tmp/fake-workdir"),
    report:
      overrides.report ??
      (async (trackId, verdict) => {
        if (verdict === "match") {
          return "preview-match";
        }
        if (verdict === "no-preview") {
          return "unverified";
        }
        return certifiedIds.has(trackId) ? "flagged-finding" : "quarantined-catalogue";
      }),
    resolveSearchFp: overrides.resolveSearchFp ?? (async () => ({ fingerprint: PREVIEW_FP })),
    rmWorkdir: overrides.rmWorkdir ?? (() => undefined),
  };
}

// The routing tests default to a TRUSTED (ISRC) row so a mismatch stays on the condemning path.
// The second-rung tests below pass `isrc: null` explicitly to exercise the abstain-only path.
const row = (trackId: string, extra: Partial<VerifyWorkItem> = {}): VerifyWorkItem => ({
  artists: ["A"],
  durationMs: 200_000,
  isrc: "USREF0000001",
  sourceAudioKey: `catalogue/${trackId}/deadbeef.webm`,
  title: "T",
  trackId,
  ...extra,
});

describe("runVerifyTick — the routing tally", () => {
  test("a matching capture is reported `match` and tallied", async () => {
    const report = mock(async () => "preview-match");
    const summary = await runVerifyTick(20, stubDeps({ queue: [row("t1")], report }));

    expect(report).toHaveBeenCalledWith("t1", "match");
    expect(summary).toMatchObject({ matched: 1, ok: true, skipped: 0, verified: 1 });
  });

  test("a CATALOGUE mismatch routes to the quarantine (the server's verdict echoed in the tally)", async () => {
    const deps = stubDeps({
      fetchPreviewFp: async () => WRONG_FP,
      queue: [row("cat1", { certified: false })],
    });
    const summary = await runVerifyTick(20, deps);

    expect(summary.quarantinedCatalogue).toBe(1);
    expect(summary.flaggedFindings).toBe(0);
  });

  test("a FINDING mismatch raises the attention item, never a rewind (flagged, not quarantined)", async () => {
    const deps = stubDeps(
      {
        fetchPreviewFp: async () => WRONG_FP,
        queue: [row("find1", { certified: true, logId: "005.9.9L" })],
      },
      new Set(["find1"]),
    );
    const summary = await runVerifyTick(20, deps);

    expect(summary.flaggedFindings).toBe(1);
    expect(summary.quarantinedCatalogue).toBe(0);
  });

  test("no preview source → reported `no-preview`, tallied `unverified`, and no R2 read is paid", async () => {
    const fetchCapture = mock(async () => "/tmp/fake.webm");
    const report = mock(async () => "unverified");
    const summary = await runVerifyTick(
      20,
      stubDeps({ fetchCapture, fetchPreviewFp: async () => null, queue: [row("t1")], report }),
    );

    expect(report).toHaveBeenCalledWith("t1", "no-preview");
    expect(fetchCapture).not.toHaveBeenCalled();
    expect(summary.unverified).toBe(1);
  });
});

describe("runVerifyTick — skip-not-stamp + isolation (idempotence's other half)", () => {
  test("a failed R2 read SKIPS the row (stays queued) — never a verdict", async () => {
    const report = mock(async () => "preview-match");
    const summary = await runVerifyTick(
      20,
      stubDeps({ fetchCapture: async () => null, queue: [row("t1")], report }),
    );

    expect(report).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ skipped: 1, verified: 0 });
  });

  test("a capture fpcalc failure SKIPS the row — a decode problem is not a mismatch", async () => {
    const report = mock(async () => "preview-match");
    const summary = await runVerifyTick(
      20,
      stubDeps({ fingerprintFile: () => null, queue: [row("t1")], report }),
    );

    expect(report).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
  });

  test("one row's throw never aborts the tick — the rest still verify", async () => {
    const deps = stubDeps({
      fetchPreviewFp: mock(async (trackId: string) => {
        if (trackId === "boom") {
          throw new Error("transient");
        }
        return PREVIEW_FP;
      }),
      queue: [row("boom"), row("t2")],
    });
    const summary = await runVerifyTick(20, deps);

    expect(summary.skipped).toBe(1);
    expect(summary.verified).toBe(1);
  });

  test("a failed queue read is the one honest tick failure", async () => {
    const summary = await runVerifyTick(
      20,
      stubDeps({
        fetchQueue: async () => {
          throw new Error("api down");
        },
      }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("api down");
  });
});

describe("runVerifyTick — the second rung (ISRC-null, title+artist reference)", () => {
  test("an ISRC-null row confirmed by a search reference → verified via the search rung, not the ISRC rung", async () => {
    const fetchPreviewFp = mock(async () => PREVIEW_FP);
    const resolveSearchFp = mock(async () => ({ fingerprint: PREVIEW_FP }));
    const report = mock(async () => "preview-match");
    const summary = await runVerifyTick(
      20,
      stubDeps({ fetchPreviewFp, queue: [row("s1", { isrc: null })], report, resolveSearchFp }),
    );

    // The ISRC rung is skipped entirely; the title+artist rung answered.
    expect(fetchPreviewFp).not.toHaveBeenCalled();
    expect(resolveSearchFp).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith("s1", "match");
    expect(summary).toMatchObject({ matched: 1, searchMatched: 1, unverified: 0, verified: 1 });
  });

  test("no confident search reference → unverified (abstain), and no R2 read is paid", async () => {
    const fetchCapture = mock(async () => "/tmp/fake.webm");
    const report = mock(async () => "unverified");
    const summary = await runVerifyTick(
      20,
      stubDeps({
        fetchCapture,
        queue: [row("s2", { isrc: null })],
        report,
        resolveSearchFp: async () => ({ fingerprint: null, reason: "no-hit" }),
      }),
    );

    expect(report).toHaveBeenCalledWith("s2", "no-preview");
    expect(fetchCapture).not.toHaveBeenCalled();
    expect(summary.unverified).toBe(1);
    expect(summary.searchMismatch).toBe(0);
  });

  test("a search reference that MISMATCHES the capture → unverified, NEVER a mismatch verdict (low trust never condemns)", async () => {
    const report = mock(async () => "unverified");
    const summary = await runVerifyTick(
      20,
      stubDeps({
        // A confident-but-WRONG reference: its fingerprint does not appear in the capture.
        queue: [row("s3", { certified: false, isrc: null })],
        report,
        resolveSearchFp: async () => ({ fingerprint: WRONG_FP }),
      }),
    );

    // The capture is NOT condemned: no `mismatch` verdict, no quarantine — just the honest abstain,
    // recorded distinctly as a search mismatch.
    expect(report).toHaveBeenCalledWith("s3", "no-preview");
    expect(summary.searchMismatch).toBe(1);
    expect(summary.quarantinedCatalogue).toBe(0);
    expect(summary.unverified).toBe(1);
    expect(summary.verified).toBe(1);
  });
});
