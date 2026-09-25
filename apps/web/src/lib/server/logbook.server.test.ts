import { afterEach, describe, expect, it, vi } from "vitest";

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

    const sql = executeCalls[0]?.sql ?? "";
    expect(sql).not.toContain("body");
    expect(sql).toContain("select sector, title");
  });
});

describe("createLogbookEntry — the fill-empty-only guarantee", () => {
  it("no-ops on a sector that already has an entry (never clobbers, never gates)", async () => {
    setRoutes([{ match: /from logbook_entries where sector/, rows: () => [EXISTING_ROW] }]);
    const { createLogbookEntry } = await import("./logbook");

    const result = await createLogbookEntry(36, { body: "signal signal", title: "x" });

    expect(result.skipped).toBe(true);
    expect(result.entry.generatedBy).toBe("operator");

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
            generated_at: args[5],
            generated_by: args[3],
            prompt_version: args[4],
            sector: args[0],
            title: args[1],
          });

          return [];
        },
      },

      { match: /select tracks\.title, tracks\.artists_json/, rows: () => [] },

      { match: /select sector, title from logbook_entries$/, rows: () => [] },

      { match: /where sector != \?/, rows: () => [] },
      {
        match: /where sector = \?/,
        rows: () => (inserted.length === 0 ? [] : inserted),
      },
    ]);
    const { createLogbookEntry } = await import("./logbook");

    const result = await createLogbookEntry(36, { body: CLEAN_BODY, title: "Sector 036 — drift" });

    expect(result.skipped).toBe(false);
    expect(result.entry.generatedBy).toBe("agent");
    expect(result.entry.sector).toBe(36);

    expect(inserted[0]?.prompt_version).toBeNull();

    expect(result.entry.body).toContain("[[036.7.2I]]");
  });

  it("voice-gates the body on an empty sector (a banned word hard-fails the store)", async () => {
    setRoutes([
      { match: /from logbook_entries where sector/, rows: () => [] },
      { match: /select tracks\.title, tracks\.artists_json/, rows: () => [] },
    ]);
    const { createLogbookEntry } = await import("./logbook");
    const { ApiError } = await import("./spotify");

    await expect(
      createLogbookEntry(36, {
        body: "The transmission rolled in over a long stretch of open sky and never let up.",
        title: "Sector 036",
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(executeCalls.every((call) => !/insert/i.test(call.sql))).toBe(true);
  });

  it("rejects a body that is only figure tokens (the prose floor)", async () => {
    setRoutes([
      { match: /from logbook_entries where sector/, rows: () => [] },
      { match: /select tracks\.title, tracks\.artists_json/, rows: () => [] },
    ]);
    const { createLogbookEntry } = await import("./logbook");
    const { ApiError } = await import("./spotify");

    await expect(
      createLogbookEntry(36, { body: "[[036.7.2I]]\n\n[[037.1.9A]]", title: "Sector 036" }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("createLogbookEntry — the name exemption", () => {
  const DAY_ROSTER = [{ artists_json: JSON.stringify(["Future Signal"]), title: "Fractals" }];

  function routesForDay(inserted: Record<string, unknown>[]): void {
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
      { match: /select tracks\.title, tracks\.artists_json/, rows: () => DAY_ROSTER },
      { match: /select sector, title from logbook_entries$/, rows: () => [] },
      { match: /where sector != \?/, rows: () => [] },
      { match: /where sector = \?/, rows: () => (inserted.length === 0 ? [] : inserted) },
    ]);
  }

  it("lets an entry NAME the day's artist, in both the title and the body", async () => {
    const inserted: Record<string, unknown>[] = [];

    routesForDay(inserted);

    const { createLogbookEntry } = await import("./logbook");
    const title = "Future Signal, twice over";
    const body =
      "Future Signal opened the day with something patient, and I let it run twice before the crew looked up.\n\n[[036.7.2I]]\n\nBy the time it landed I had already logged it and moved on.";

    const result = await createLogbookEntry(36, { body, title });

    expect(result.skipped).toBe(false);
    expect(result.entry.title).toBe(title);
    expect(result.entry.body).toContain("Future Signal");
  });

  it("STILL rejects the same banned word used generically in the body", async () => {
    routesForDay([]);

    const { createLogbookEntry } = await import("./logbook");

    await expect(
      createLogbookEntry(36, {
        body: "Future Signal opened the day, and the signal underneath never let up across the whole stretch of it.\n\n[[036.7.2I]]",
        title: "A patient day",
      }),
    ).rejects.toMatchObject({ code: "voice_gate" });
    expect(executeCalls.every((call) => !/insert/i.test(call.sql))).toBe(true);
  });

  it("STILL rejects the same banned word in the TITLE", async () => {
    routesForDay([]);

    const { createLogbookEntry } = await import("./logbook");

    await expect(
      createLogbookEntry(36, {
        body: "Future Signal opened the day with something patient, and I let it run twice before the crew looked up.\n\n[[036.7.2I]]",
        title: "A clean signal all day",
      }),
    ).rejects.toMatchObject({ code: "voice_gate" });
  });
});

describe("updateLogbookEntry — the operator overwrite", () => {
  it("upserts with generated_by = operator (the sacred stamp)", async () => {
    let storedGeneratedBy = "agent";

    setRoutes([
      {
        match: /insert into logbook_entries/,
        rows: () => {
          storedGeneratedBy = "operator";

          return [];
        },
      },

      { match: /select tracks\.title, tracks\.artists_json/, rows: () => [] },

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
    const STORED = [
      { sector: 18, title: "Shoulders Down" },
      { sector: 36, title: "A slow drift" },
    ];

    setRoutes([
      { match: /insert into logbook_entries/, rows: () => [] },
      { match: /select tracks\.title, tracks\.artists_json/, rows: () => [] },
      { match: /select sector, title from logbook_entries$/, rows: () => STORED },
      { match: /where sector = \?/, rows: () => [{ ...EXISTING_ROW, title: "A slow drift" }] },
    ]);
    const { updateLogbookEntry } = await import("./logbook");
    const { ApiError } = await import("./spotify");

    await expect(
      updateLogbookEntry(36, { body: CLEAN_BODY, title: "A Slow Drift" }),
    ).resolves.toBeDefined();

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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));

    setRoutes([
      {
        match: /select added_at from findings where log_id is not null$/,
        rows: () => [
          { added_at: "2026-05-31T10:00:00.000Z" },
          { added_at: "2026-06-01T10:00:00.000Z" },
          { added_at: "2026-06-02T10:00:00.000Z" },
        ],
      },
      { match: /select sector from logbook_entries/, rows: () => [{ sector: 2 }] },
      {
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

    expect(gaps.map((gap) => gap.sector)).toEqual([1, 3]);

    expect(gaps[0]?.findings[0]).toMatchObject({
      artists: ["Fizzy"],
      contextNote: "a fact",
      logId: "001.0.1A",
      posterUrl: "https://found.fluncle.com/001.0.1A/poster.jpg",
    });

    expect(gaps[0]?.findings[0]?.note).toBeUndefined();

    vi.useRealTimers();
  });
});

const NEIGHBOR_BODY =
  "The low end rolled in slow and patient and it never let go of the whole room that night.";

describe("createLogbookEntry — the title-collision guard (Layer A, deterministic)", () => {
  it("rejects a title that NORMALIZED-matches a stored title (case + punctuation insensitive)", async () => {
    setRoutes([
      { match: /select tracks\.title, tracks\.artists_json/, rows: () => [] },

      { match: /where sector = \?/, rows: () => [] },

      {
        match: /select sector, title from logbook_entries$/,
        rows: () => [{ sector: 18, title: "Shoulders Down" }],
      },
    ]);
    const { createLogbookEntry } = await import("./logbook");

    await expect(
      createLogbookEntry(19, { body: CLEAN_BODY, title: "Shoulders, Down" }),
    ).rejects.toMatchObject({ code: "title_echoes_logbook", status: 422 });

    expect(executeCalls.every((call) => !/insert/i.test(call.sql))).toBe(true);
  });
});

describe("createLogbookEntry — the body echo gate (Layer C, scored)", () => {
  function echoRoutes(neighborBody: string) {
    return [
      { match: /select tracks\.title, tracks\.artists_json/, rows: () => [] },
      { match: /insert into logbook_entries/, rows: () => [] },
      { match: /where sector = \?/, rows: () => [] },
      { match: /select sector, title from logbook_entries$/, rows: () => [] },

      { match: /where sector != \?/, rows: () => [{ body: neighborBody, sector: 12 }] },

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

    const overlap =
      "Pressure everywhere, coiled and tidal across the sector. The break felt gunmetal, the sub dusk-toned, tension under halogen light.";

    await expect(
      createLogbookEntry(19, { body: overlap, title: "Another fresh title" }),
    ).rejects.toMatchObject({ code: "body_echoes_logbook", status: 422 });
  });

  it("passes a clean, genuinely-different body (nothing to echo)", async () => {
    const inserted: Record<string, unknown>[] = [];

    setRoutes([
      { match: /select tracks\.title, tracks\.artists_json/, rows: () => [] },
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

    expect(spent.map((entry) => entry.sector)).toEqual([36, 35]);
    expect(executeCalls[0]?.args?.[0]).toBe(12);

    expect(spent[0]).toMatchObject({
      closer: "I played it twice.",
      opener: "A low sub opened the night.",
      title: "A slow drift",
    });
    expect(spent[0]?.opener).not.toContain("[[036.7.2I]]");

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
