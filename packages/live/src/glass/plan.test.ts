// The bridge-first plan precedence (the first-set debrief fix): the glass cycled its own
// 5-entry demo fixture while the bridge held the real 17-finding plan. `choosePlanSource`
// is the pure rule the glass server + client both narrate — a non-empty bridge plan wins,
// else the local fixture floor — so it tests directly, no server needed.

import { describe, expect, test } from "bun:test";

import { choosePlanSource } from "./plan.ts";

// Stand-ins shaped like the real entries (the rule only reads `.length`).
const bridge17 = Array.from({ length: 17 }, (_, i) => ({ logId: `b${i}` }));
const local5 = Array.from({ length: 5 }, (_, i) => ({ logId: `l${i}` }));

describe("choosePlanSource", () => {
  test("a non-empty bridge plan WINS over the local fixture (the fix)", () => {
    const picked = choosePlanSource(bridge17, local5);
    expect(picked.source).toBe("bridge");
    expect(picked.plan).toHaveLength(17);
    expect(picked.log).toBe("plan: 17 findings via the bridge");
  });

  test("no bridge (null) falls to the local fixture floor, named as such", () => {
    const picked = choosePlanSource(null, local5);
    expect(picked.source).toBe("local");
    expect(picked.plan).toHaveLength(5);
    expect(picked.log).toBe("plan: 5 findings, local fixture — no bridge");
  });

  test("a bridge that answered with an EMPTY plan is treated as no plan → local floor", () => {
    const picked = choosePlanSource([], local5);
    expect(picked.source).toBe("local");
    expect(picked.plan).toHaveLength(5);
  });

  test("returns a COPY of the winning list (mutating the result never edits the source)", () => {
    const picked = choosePlanSource(bridge17, local5);
    expect(picked.plan).not.toBe(bridge17);
    picked.plan.push({ logId: "extra" });
    expect(bridge17).toHaveLength(17);
  });

  test("the pointer contract: the winning list is what the glass indexes end-to-end", () => {
    // A bridge pointer of 12 must resolve inside the served list — the debrief bug was the
    // glass indexing its own 5-entry list against a 17-deep bridge pointer.
    const picked = choosePlanSource(bridge17, local5);
    expect(picked.plan[12]).toEqual({ logId: "b12" });
  });
});
