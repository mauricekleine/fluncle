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

describe("listLogbookIndexEntries — the lean index read (no body)", () => {
  it("selects only sector + title, never the long-form body", async () => {
    setRoutes([
      {
        match: /select sector, title from logbook_entries order by sector desc/,
        rows: () => [
          { sector: 42, title: "Sector 042" },
          { sector: 40, title: "Sector 040" },
        ],
      },
    ]);
    const { listLogbookIndexEntries } = await import("./logbook");
    const entries = await listLogbookIndexEntries();

    expect(entries).toEqual([
      { sector: 42, title: "Sector 042" },
      { sector: 40, title: "Sector 040" },
    ]);
    // The read never loads `body` — the biggest per-row column (up to 12k chars, over up to
    // 500 rows) — because the index renders only sector + title.
    const sql = executeCalls[0]?.sql ?? "";
    expect(sql).not.toContain("body");
    expect(sql).toContain("select sector, title");
  });
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
          // args: sector, title, body, generated_by, PROMPT_VERSION, generated_at,
          // created_at, updated_at. `prompt_version` (args[4]) is the provenance stamp —
          // which prompt-registry version authored the entry (docs/agents/prompt-registry.md).
          inserted.push({
            body: args[2],
            generated_at: args[5],
            generated_by: args[3],
            prompt_version: args[4],
            sector: args[0],
            title: args[1],
          });

          return [];
        },
      },
      // The title-collision guard's read — no stored titles, so no collision.
      { match: /select sector, title from logbook_entries$/, rows: () => [] },
      // The body echo gate's neighbour read — no recent entries, so nothing to echo.
      { match: /where sector != \?/, rows: () => [] },
      {
        // The existence SELECT returns nothing first, then the post-insert read
        // returns the stored row.
        match: /where sector = \?/,
        rows: () => (inserted.length === 0 ? [] : inserted),
      },
    ]);
    const { createLogbookEntry } = await import("./logbook");

    const result = await createLogbookEntry(36, { body: CLEAN_BODY, title: "Sector 036 — drift" });

    expect(result.skipped).toBe(false);
    expect(result.entry.generatedBy).toBe("agent");
    expect(result.entry.sector).toBe(36);
    // No prompt version was supplied, so the provenance column stays NULL — the honest
    // record that no registry prompt wrote this entry.
    expect(inserted[0]?.prompt_version).toBeNull();
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
      // The operator path still runs the title-collision guard (against OTHER sectors) —
      // no other titles here, so it passes.
      { match: /select sector, title from logbook_entries$/, rows: () => [] },
      {
        match: /where sector = \?/,
        rows: () => [{ ...EXISTING_ROW, generated_by: storedGeneratedBy }],
      },
    ]);
    const { updateLogbookEntry } = await import("./logbook");

    const entry = await updateLogbookEntry(36, { body: CLEAN_BODY, title: "Sector 036 — redone" });

    expect(entry.generatedBy).toBe("operator");
    const insert = executeCalls.find((call) => /insert into logbook_entries/i.test(call.sql));
    expect(insert?.sql).toMatch(/'operator'/);
  });

  it("re-saving a sector's OWN title passes (the exclude-self rule), but a cross-sector collision 422s", async () => {
    // Sector 018 already holds "Shoulders Down"; sector 036 holds "A slow drift".
    const STORED = [
      { sector: 18, title: "Shoulders Down" },
      { sector: 36, title: "A slow drift" },
    ];

    setRoutes([
      { match: /insert into logbook_entries/, rows: () => [] },
      { match: /select sector, title from logbook_entries$/, rows: () => STORED },
      { match: /where sector = \?/, rows: () => [{ ...EXISTING_ROW, title: "A slow drift" }] },
    ]);
    const { updateLogbookEntry } = await import("./logbook");
    const { ApiError } = await import("./spotify");

    // Re-saving sector 36 under its own (normalized-equal) title is allowed.
    await expect(
      updateLogbookEntry(36, { body: CLEAN_BODY, title: "A Slow Drift" }),
    ).resolves.toBeDefined();

    // But taking sector 018's title on sector 036 collides (case- + punctuation-insensitive).
    await expect(
      updateLogbookEntry(36, { body: CLEAN_BODY, title: "shoulders down" }),
    ).rejects.toMatchObject({ code: "title_echoes_logbook" });
    await expect(
      updateLogbookEntry(36, { body: CLEAN_BODY, title: "Shoulders, Down" }),
    ).rejects.toBeInstanceOf(ApiError);
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

// ── The anti-sameness rail (Layers A + C) ─────────────────────────────────────

// A neighbour body a draft can lift a run of words from (the low-end run below).
const NEIGHBOR_BODY =
  "The low end rolled in slow and patient and it never let go of the whole room that night.";

describe("createLogbookEntry — the title-collision guard (Layer A, deterministic)", () => {
  it("rejects a title that NORMALIZED-matches a stored title (case + punctuation insensitive)", async () => {
    setRoutes([
      // Empty sector (create is fill-empty-only), so the guard is reached.
      { match: /where sector = \?/, rows: () => [] },
      // Sector 018 already holds "Shoulders Down".
      {
        match: /select sector, title from logbook_entries$/,
        rows: () => [{ sector: 18, title: "Shoulders Down" }],
      },
    ]);
    const { createLogbookEntry } = await import("./logbook");

    // "Shoulders, Down" (punctuation + case) normalizes to the same "shoulders down".
    await expect(
      createLogbookEntry(19, { body: CLEAN_BODY, title: "Shoulders, Down" }),
    ).rejects.toMatchObject({ code: "title_echoes_logbook", status: 422 });
    // No INSERT ran — the guard fired before the store.
    expect(executeCalls.every((call) => !/insert/i.test(call.sql))).toBe(true);
  });
});

describe("createLogbookEntry — the body echo gate (Layer C, scored)", () => {
  function echoRoutes(neighborBody: string) {
    return [
      { match: /insert into logbook_entries/, rows: () => [] },
      { match: /where sector = \?/, rows: () => [] },
      { match: /select sector, title from logbook_entries$/, rows: () => [] },
      // The recent-entries neighbour read.
      { match: /where sector != \?/, rows: () => [{ body: neighborBody, sector: 12 }] },
      // The dials — unset, so the calibrated defaults (minPhraseWords 4, maxOverlap 0.3).
      { match: /from settings where key/, rows: () => [] },
    ];
  }

  it("rejects a body that LIFTS a run of words from a recent entry", async () => {
    setRoutes(echoRoutes(NEIGHBOR_BODY));
    const { createLogbookEntry } = await import("./logbook");

    const lifted =
      "I leaned back as the low end rolled in slow and patient, and the crew felt every second of it.";

    await expect(
      createLogbookEntry(19, { body: lifted, title: "A fresh title" }),
    ).rejects.toMatchObject({ code: "body_echoes_logbook", status: 422 });
    expect(executeCalls.every((call) => !/insert/i.test(call.sql))).toBe(true);
  });

  it("rejects a body that reuses a recent entry's words WHOLESALE (the overlap path)", async () => {
    const neighbor =
      "Halogen light. Tidal sub. Gunmetal break. Coiled tension. Dusk pressure everywhere in the sector.";
    setRoutes(echoRoutes(neighbor));
    const { createLogbookEntry } = await import("./logbook");

    // Same distinctive words, reordered so no 4-word run is shared — the overlap catches it.
    const overlap =
      "Pressure everywhere, coiled and tidal across the sector. The break felt gunmetal, the sub dusk-toned, tension under halogen light.";

    await expect(
      createLogbookEntry(19, { body: overlap, title: "Another fresh title" }),
    ).rejects.toMatchObject({ code: "body_echoes_logbook", status: 422 });
  });

  it("passes a clean, genuinely-different body (nothing to echo)", async () => {
    const inserted: Record<string, unknown>[] = [];

    setRoutes([
      {
        match: /insert into logbook_entries/,
        rows: (args) => {
          inserted.push({
            body: args[2],
            generated_at: args[5],
            generated_by: args[3],
            sector: args[0],
            title: args[1],
          });

          return [];
        },
      },
      { match: /select sector, title from logbook_entries$/, rows: () => [] },
      // A recent entry that shares nothing with the draft below.
      {
        match: /where sector != \?/,
        rows: () => [
          { body: "Bright stabs cut across a jittery amen while the crew hollered.", sector: 12 },
        ],
      },
      { match: /from settings where key/, rows: () => [] },
      { match: /where sector = \?/, rows: () => (inserted.length === 0 ? [] : inserted) },
    ]);
    const { createLogbookEntry } = await import("./logbook");

    const result = await createLogbookEntry(19, { body: CLEAN_BODY, title: "A slow drift" });

    expect(result.skipped).toBe(false);
    expect(result.entry.generatedBy).toBe("agent");
  });
});

describe("listSpentMoves — the anti-sameness fuel (Layer B)", () => {
  it("distills each entry to its opener + closer (first/last sentence, tokens stripped), newest first, capped", async () => {
    setRoutes([
      {
        match: /select sector, title, body from logbook_entries order by sector desc limit \?/,
        rows: () => [
          {
            body: "A low sub opened the night.\n\n[[036.7.2I]]\n\nThe crew stopped talking. I played it twice.",
            sector: 36,
            title: "A slow drift",
          },
          { body: "One long roller, start to finish.", sector: 35, title: "One roller" },
        ],
      },
    ]);
    const { listSpentMoves } = await import("./logbook");

    const spent = await listSpentMoves();

    // Newest sector first, and the query is capped (default 12).
    expect(spent.map((entry) => entry.sector)).toEqual([36, 35]);
    expect(executeCalls[0]?.args?.[0]).toBe(12);
    // Opener = first sentence, closer = last sentence, with the figure token stripped out.
    expect(spent[0]).toMatchObject({
      closer: "I played it twice.",
      opener: "A low sub opened the night.",
      title: "A slow drift",
    });
    expect(spent[0]?.opener).not.toContain("[[036.7.2I]]");
    // A single-sentence body: opener === closer.
    expect(spent[1]?.opener).toBe("One long roller, start to finish.");
    expect(spent[1]?.closer).toBe("One long roller, start to finish.");
  });
});

describe("getLogbookEchoThresholds — the tunable dials, bounded on read", () => {
  function settingsRoutes(values: Record<string, string>) {
    return [
      {
        match: /from settings where key/,
        rows: (args: unknown[]) => {
          const key = String(args[0]);

          return key in values ? [{ value: values[key] }] : [];
        },
      },
    ];
  }

  it("falls back to the calibrated defaults when the KV is unset", async () => {
    setRoutes(settingsRoutes({}));
    const { getLogbookEchoThresholds } = await import("./logbook-echo");

    expect(await getLogbookEchoThresholds()).toEqual({ maxOverlap: 0.3, minPhraseWords: 4 });
  });

  it("degrades a nonsense KV value to the default rather than disabling the gate", async () => {
    // minPhraseWords 1 (below the floor of 2) and maxOverlap 0 (below 0.05) would open/shut
    // the gate — both must snap back to the defaults.
    setRoutes(
      settingsRoutes({ logbook_echo_max_overlap: "0", logbook_echo_min_phrase_words: "1" }),
    );
    const { getLogbookEchoThresholds } = await import("./logbook-echo");

    expect(await getLogbookEchoThresholds()).toEqual({ maxOverlap: 0.3, minPhraseWords: 4 });
  });

  it("reads valid in-bounds KV values", async () => {
    setRoutes(
      settingsRoutes({ logbook_echo_max_overlap: "0.5", logbook_echo_min_phrase_words: "6" }),
    );
    const { getLogbookEchoThresholds } = await import("./logbook-echo");

    expect(await getLogbookEchoThresholds()).toEqual({ maxOverlap: 0.5, minPhraseWords: 6 });
  });
});
