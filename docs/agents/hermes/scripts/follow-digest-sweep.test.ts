import { describe, expect, it } from "vitest";
import { runFollowDigestSweep } from "./follow-digest-sweep";

describe("follow digest sweep", () => {
  it("sums recipient failures and unknown deliveries without aborting later pages", async () => {
    const summary = await runFollowDigestSweep(async (cursor) =>
      cursor
        ? {
            capped: false,
            considered: 1,
            dryRun: false,
            empty: 0,
            failed: 0,
            ok: true,
            paused: false,
            sent: 1,
            skipped: 0,
            unknown: 0,
            weekKey: "2026-W39",
          }
        : {
            capped: false,
            considered: 3,
            dryRun: false,
            empty: 0,
            failed: 1,
            nextCursor: "user-3",
            ok: true,
            paused: false,
            sent: 1,
            skipped: 0,
            unknown: 1,
            weekKey: "2026-W39",
          },
    );
    expect(summary).toMatchObject({ checked: 4, failed: 1, ok: true, sent: 2, unknown: 1 });
  });
  it("walks bounded cursor pages and sums sent and empty recipients", async () => {
    const calls: unknown[] = [];
    const summary = await runFollowDigestSweep(async (cursor, limit) => {
      calls.push([cursor, limit]);
      return cursor
        ? {
            capped: false,
            considered: 2,
            dryRun: false,
            empty: 1,
            failed: 0,
            ok: true,
            paused: false,
            sent: 1,
            skipped: 0,
            unknown: 0,
            weekKey: "2026-W39",
          }
        : {
            capped: false,
            considered: 50,
            dryRun: false,
            empty: 40,
            failed: 0,
            nextCursor: "user-100",
            ok: true,
            paused: false,
            sent: 10,
            skipped: 0,
            unknown: 0,
            weekKey: "2026-W39",
          };
    });
    expect(calls).toEqual([
      [undefined, 50],
      ["user-100", 50],
    ]);
    expect(summary).toMatchObject({ checked: 52, empty: 41, ok: true, passes: 2, sent: 11 });
  });

  it("stops on the kill switch and reports a failed request", async () => {
    const paused = await runFollowDigestSweep(async () => ({
      capped: false,
      considered: 0,
      dryRun: false,
      empty: 0,
      failed: 0,
      ok: true,
      paused: true,
      sent: 0,
      skipped: 0,
      unknown: 0,
      weekKey: "2026-W39",
    }));
    expect(paused.gateState).toBe("paused");
    const failed = await runFollowDigestSweep(async () => {
      throw new Error("HTTP 503");
    });
    expect(failed).toMatchObject({ error: "HTTP 503", errors: 1, ok: false });
  });
});
