import { afterEach, describe, expect, it, vi } from "vitest";

// The logbook server module against a controllable in-memory DB stub. Proves the two
// load-bearing behaviors: the CARDINAL fill-empty-only guarantee (the agent create
// never clobbers an existing entry) + the voice gate, and the self-healing gap window
// (findings-bearing days before today that have no entry, oldest first).

// A tiny DB stub: route each `execute({ sql, args })` by matching the SQL to a
// handler. Unmatched SQL throws (a test wiring bug, surfaced loudly).
type ExecResult = { rows: Record<string, unknown>[] };
type Route = { match: RegExp; rows: (args: unknown[]) => Record<string, unknown>[] };

let routes: Route[] = [];
const executeCalls: { args: unknown[]; sql: string }[] = [];

function setRoutes(next: Route[]): void {
  routes = next;
  executeCalls.length = 0;
}

vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async ({ args = [], sql }: { args?: unknown[]; sql: string }): Promise<ExecResult> => {
      executeCalls.push({ args, sql });
      const normalized = sql.replace(/\s+/g, " ").trim();
      const route = routes.find((candidate) => candidate.match.test(normalized));

      if (!route) {
        throw new Error(`unrouted SQL in test: ${normalized.slice(0, 80)}`);
      }

      return { rows: route.rows(args) };
    },
  }),
  typedRow: <T>(rows: T[]): T | undefined => rows[0],
  typedRows: <T>(rows: T[]): T[] => rows,
}));

const EXISTING_ROW = {
  body: "An operator's own words for the day.",
  generated_at: "2026-07-05T00:00:00.000Z",
  generated_by: "operator",
  sector: 36,
  title: "Sector 036",
};

// A clean body that clears the voice gate (no banned words, no earthly geography, no
// exclamation, no "we", past the prose floor) and carries a figure token.
const CLEAN_BODY =
  "The day opened on a low, patient sub that took its time finding the room. I let it breathe, then the break rolled in and the whole sector leaned forward.\n\n[[036.7.2I]]\n\nI played it twice before the crew stopped talking.";

afterEach(() => {
  vi.clearAllMocks();
});

describe("createLogbookEntry — the fill-empty-only guarantee", () => {
  it("no-ops on a sector that already has an entry (never clobbers, never gates)", async () => {
    setRoutes([{ match: /from logbook_entries where sector/, rows: () => [EXISTING_ROW] }]);
    const { createLogbookEntry } = await import("./logbook");

    // A body that WOULD fail the voice gate ("signal") — proof the guard short-circuits
    // BEFORE gating, so an existing entry is untouched regardless of the input.
    const result = await createLogbookEntry(36, { body: "signal signal", title: "x" });

    expect(result.skipped).toBe(true);
    expect(result.entry.generatedBy).toBe("operator");
    // Only the existence SELECT ran — no INSERT, no second read.
    expect(executeCalls).toHaveLength(1);
  });

  it("inserts on an empty sector, stamping generated_by = agent", async () => {
    const inserted: Record<string, unknown>[] = [];

    setRoutes([
      {
        match: /insert into logbook_entries/,
        rows: (args) => {
          inserted.push({
            body: args[2],
            generated_at: args[4],
            generated_by: args[3],
            sector: args[0],
            title: args[1],
          });

          return [];
        },
      },
      {
        // The existence SELECT returns nothing first, then the post-insert read
        // returns the stored row.
        match: /from logbook_entries where sector/,
        rows: () => (inserted.length === 0 ? [] : inserted),
      },
    ]);
    const { createLogbookEntry } = await import("./logbook");

    const result = await createLogbookEntry(36, { body: CLEAN_BODY, title: "Sector 036 — drift" });

    expect(result.skipped).toBe(false);
    expect(result.entry.generatedBy).toBe("agent");
    expect(result.entry.sector).toBe(36);
    // The figure token survives into storage (the renderer needs it).
    expect(result.entry.body).toContain("[[036.7.2I]]");
  });

  it("voice-gates the body on an empty sector (a banned word hard-fails the store)", async () => {
    setRoutes([{ match: /from logbook_entries where sector/, rows: () => [] }]);
    const { createLogbookEntry } = await import("./logbook");
    const { ApiError } = await import("./spotify");

    await expect(
      createLogbookEntry(36, {
        body: "The transmission rolled in over a long stretch of open sky and never let up.",
        title: "Sector 036",
      }),
    ).rejects.toBeInstanceOf(ApiError);
    // No INSERT ran — only the existence check.
    expect(executeCalls.every((call) => !/insert/i.test(call.sql))).toBe(true);
  });

  it("rejects a body that is only figure tokens (the prose floor)", async () => {
    setRoutes([{ match: /from logbook_entries where sector/, rows: () => [] }]);
    const { createLogbookEntry } = await import("./logbook");
    const { ApiError } = await import("./spotify");

    await expect(
      createLogbookEntry(36, { body: "[[036.7.2I]]\n\n[[037.1.9A]]", title: "Sector 036" }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("updateLogbookEntry — the operator overwrite", () => {
  it("upserts with generated_by = operator (the sacred stamp)", async () => {
    let storedGeneratedBy = "agent";

    setRoutes([
      {
        match: /insert into logbook_entries/,
        rows: () => {
          storedGeneratedBy = "operator"; // the SQL hard-codes 'operator'

          return [];
        },
      },
      {
        match: /from logbook_entries where sector/,
        rows: () => [{ ...EXISTING_ROW, generated_by: storedGeneratedBy }],
      },
    ]);
    const { updateLogbookEntry } = await import("./logbook");

    const entry = await updateLogbookEntry(36, { body: CLEAN_BODY, title: "Sector 036 — redone" });

    expect(entry.generatedBy).toBe("operator");
    const insert = executeCalls.find((call) => /insert into logbook_entries/i.test(call.sql));
    expect(insert?.sql).toMatch(/'operator'/);
  });
});

describe("listLogbookGaps — the self-healing window", () => {
  it("returns findings-bearing days with no entry, oldest first, excluding today", async () => {
    // sectorDay('2026-05-31…') = 1, '2026-06-01…' = 2, '2026-06-02…' = 3. Findings on
    // sectors 1, 2, 3; sector 2 already has an entry; "today" is far ahead (a fixed
    // clock below), so all three are past days.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));

    setRoutes([
      {
        // The findings-per-day scan (no added_at range → the day list).
        match: /select added_at from findings where log_id is not null$/,
        rows: () => [
          { added_at: "2026-05-31T10:00:00.000Z" }, // sector 1
          { added_at: "2026-06-01T10:00:00.000Z" }, // sector 2 (has an entry)
          { added_at: "2026-06-02T10:00:00.000Z" }, // sector 3
        ],
      },
      { match: /select sector from logbook_entries/, rows: () => [{ sector: 2 }] },
      {
        // The per-sector material gather (ranged) — one finding each.
        match: /where findings\.log_id is not null\s+and findings\.added_at >= \?/,
        rows: (args) => {
          const start = String(args[0]);

          return [
            {
              added_at: start,
              artists_json: JSON.stringify(["Fizzy"]),
              context_note: "  a fact  ",
              log_id: start.startsWith("2026-05-31") ? "001.0.1A" : "003.0.3C",
              note: null,
              observation_script: null,
              title: "A Cut",
            },
          ];
        },
      },
    ]);
    const { listLogbookGaps } = await import("./logbook");

    const gaps = await listLogbookGaps({ limit: 10 });

    // Sector 2 is authored → skipped; 1 and 3 remain, oldest first.
    expect(gaps.map((gap) => gap.sector)).toEqual([1, 3]);
    // The material is gathered + trimmed; the poster URL is derived from the coordinate.
    expect(gaps[0]?.findings[0]).toMatchObject({
      artists: ["Fizzy"],
      contextNote: "a fact",
      logId: "001.0.1A",
      posterUrl: "https://found.fluncle.com/001.0.1A/poster.jpg",
    });
    // A blank note/observation is omitted (not carried as an empty string).
    expect(gaps[0]?.findings[0]?.note).toBeUndefined();

    vi.useRealTimers();
  });
});
