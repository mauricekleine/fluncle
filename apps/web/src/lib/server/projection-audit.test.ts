import { describe, expect, it } from "vitest";

import { canonicalDueProjection } from "./projection-audit";

const AUDIT_STARTED_AT = "2026-09-02T08:00:00.000Z";

function dueRow(nextDueAt: string, state: string) {
  return {
    nextDueAt,
    sortKey: "stable-order",
    sourceVersion: "stable-source",
    state,
    subjectId: "track-1",
  };
}

describe("track due-work audit canonicalization", () => {
  it("matches immediately-ready rows materialized at different chunk times", () => {
    const source = canonicalDueProjection(
      dueRow("2026-09-02T07:59:59.000Z", "ready"),
      AUDIT_STARTED_AT,
    );
    const projected = canonicalDueProjection(
      dueRow("2026-09-02T07:58:00.000Z", "ready"),
      AUDIT_STARTED_AT,
    );

    expect(source).toEqual(projected);
    expect(source).toEqual(["track-1", "ready", "stable-order", null, "stable-source"]);
  });

  it("matches a stored scheduled row whose deadline crossed before the audit began", () => {
    const source = canonicalDueProjection(
      dueRow("2026-09-02T07:59:59.999Z", "ready"),
      AUDIT_STARTED_AT,
    );
    const projected = canonicalDueProjection(
      dueRow("2026-09-02T07:59:59.999Z", "scheduled"),
      AUDIT_STARTED_AT,
    );
    expect(projected).toEqual(source);
    expect(
      canonicalDueProjection(dueRow("2026-09-02T07:59:59.999Z", "leased"), AUDIT_STARTED_AT),
    ).toEqual(source);
  });

  it("keeps a row scheduled at the audit snapshot when it is leased later", () => {
    const leasedFuture = canonicalDueProjection(
      dueRow("2026-09-02T08:30:00.000Z", "leased"),
      AUDIT_STARTED_AT,
    );

    expect(leasedFuture).toEqual([
      "track-1",
      "scheduled",
      "stable-order",
      "2026-09-02T08:30:00.000Z",
      "stable-source",
    ]);
  });

  it("keeps genuinely different future deadlines distinguishable", () => {
    const earlier = canonicalDueProjection(
      dueRow("2026-09-02T08:30:00.000Z", "scheduled"),
      AUDIT_STARTED_AT,
    );
    const later = canonicalDueProjection(
      dueRow("2026-09-02T09:30:00.000Z", "scheduled"),
      AUDIT_STARTED_AT,
    );

    expect(earlier).not.toEqual(later);
    expect(earlier).toEqual([
      "track-1",
      "scheduled",
      "stable-order",
      "2026-09-02T08:30:00.000Z",
      "stable-source",
    ]);
  });
});
