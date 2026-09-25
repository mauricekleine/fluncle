import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
const isSonarSonicEnabled = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const searchSonar = vi.hoisted(() => vi.fn());

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => ({ execute }) };
});

vi.mock("./sonar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sonar")>();

  return { ...actual, isSonarSonicEnabled, searchSonar };
});

import { rankTrackIdsByProbe, STYLE_FUTURE_EXCLUDE_CAP } from "./style-probe";

const PROBE = [0.1, 0.2, 0.3];
const KEY_CLAUSE = { args: ["A minor"], sql: "tracks.key in (?)" };

beforeEach(() => {
  execute.mockReset();
  isSonarSonicEnabled.mockReset();
  searchSonar.mockReset();
});

describe("rankTrackIdsByProbe — the pre-filtered scan's deadline is an outage, not a fault", () => {
  it("answers unavailable when the scan outlives its deadline", async () => {
    execute.mockImplementation(() => new Promise(() => undefined));

    await expect(
      rankTrackIdsByProbe(PROBE, { clauses: [KEY_CLAUSE], deadlineMs: 5, depth: 10 }),
    ).resolves.toBeNull();
  });

  it("keeps a genuine query error an error", async () => {
    execute.mockRejectedValue(new Error("no such column: tracks.kee"));

    await expect(
      rankTrackIdsByProbe(PROBE, { clauses: [KEY_CLAUSE], deadlineMs: 5_000, depth: 10 }),
    ).rejects.toThrow("no such column");
  });
});

describe("rankTrackIdsByProbe — future releases never take a Sonar slot", () => {
  it("excludes the not-yet-released ids before the top-k", async () => {
    isSonarSonicEnabled.mockResolvedValue(true);
    execute.mockResolvedValue({ rows: [{ track_id: "future-1" }, { track_id: "future-2" }] });
    searchSonar.mockResolvedValue([{ id: "t1", score: 0.9 }]);

    const ids = await rankTrackIdsByProbe(PROBE, {
      clauses: [],
      depth: 480,
      releasedBy: "2026-09-25",
    });

    expect(ids).toEqual(["t1"]);
    expect(searchSonar).toHaveBeenCalledWith(
      expect.objectContaining({ excludeIds: ["future-1", "future-2"], topK: 480 }),
    );
  });

  it("degrades rather than truncate when the future backlog is past what it can exclude", async () => {
    isSonarSonicEnabled.mockResolvedValue(true);
    execute.mockResolvedValue({
      rows: Array.from({ length: STYLE_FUTURE_EXCLUDE_CAP + 1 }, (_unused, index) => ({
        track_id: `future-${index}`,
      })),
    });

    await expect(
      rankTrackIdsByProbe(PROBE, { clauses: [], depth: 480, releasedBy: "2026-09-25" }),
    ).resolves.toBeNull();
    expect(searchSonar).not.toHaveBeenCalled();
  });
});
