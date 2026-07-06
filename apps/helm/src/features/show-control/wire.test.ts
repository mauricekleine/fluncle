import { describe, expect, test } from "bun:test";

import { type RunStatus, type RunSummary } from "../../contract";
import { findRunningShow, pickActiveShow, SHOW_FEATURE_ID } from "./wire";

// The registry lists newest-first (by startedAt desc); these fixtures follow that order.
function run(id: string, feature: string, status: RunStatus, startedAt: number): RunSummary {
  return {
    argv: [],
    endedAt: status === "running" ? null : startedAt + 1000,
    exitCode: status === "running" ? null : status === "ok" ? 0 : 1,
    feature,
    id,
    startedAt,
    status,
    title: `${feature} run`,
  };
}

describe("findRunningShow (the single-show guard)", () => {
  test("returns the running show run when one holds the ports", () => {
    const runs = [
      run("a", SHOW_FEATURE_ID, "running", 300),
      run("b", SHOW_FEATURE_ID, "failed", 200),
    ];

    expect(findRunningShow(runs)?.id).toBe("a");
  });

  test("ignores a running run from another station — only a show holds the glass", () => {
    const runs = [run("p", "pulse-lite", "running", 300), run("s", SHOW_FEATURE_ID, "ok", 200)];

    expect(findRunningShow(runs)).toBeUndefined();
  });

  test("no running show ⇒ undefined (a raise is allowed to proceed)", () => {
    expect(findRunningShow([run("s", SHOW_FEATURE_ID, "ok", 100)])).toBeUndefined();
    expect(findRunningShow([])).toBeUndefined();
  });
});

describe("pickActiveShow (reload re-attach)", () => {
  test("prefers the running show over a more recent non-show run", () => {
    const runs = [
      run("p", "pulse-lite", "running", 400),
      run("s", SHOW_FEATURE_ID, "running", 300),
    ];

    expect(pickActiveShow(runs)?.id).toBe("s");
  });

  test("with no show up, re-attaches to the most recent finished show run", () => {
    const runs = [run("s2", SHOW_FEATURE_ID, "failed", 300), run("s1", SHOW_FEATURE_ID, "ok", 200)];

    expect(pickActiveShow(runs)?.id).toBe("s2");
  });

  test("ignores other stations' runs entirely", () => {
    const runs = [run("p", "pulse-lite", "ok", 300)];

    expect(pickActiveShow(runs)).toBeUndefined();
  });
});
