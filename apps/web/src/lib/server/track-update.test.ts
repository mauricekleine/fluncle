import { beforeEach, describe, expect, it, vi } from "vitest";

import { updateTrack } from "./track-update";

// updateTrack runs two statements: a SELECT (existing isrc/log_id/added_at) then
// the UPDATE. The mock returns an existing row for the SELECT and captures the
// UPDATE so we can assert which columns it set — specifically whether it bumped
// `updated_at` (the sitemap/log lastmod source). Internal fuel fields (features,
// context_note) must NOT bump it; visible fields (observation audio, note) must.

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

const EXISTING = {
  added_at: "2026-06-01T00:00:00.000Z",
  isrc: "GB1234567890",
  log_id: "004.7.2I",
};

let lastUpdateSql = "";

beforeEach(() => {
  lastUpdateSql = "";
  execute.mockReset();
  execute.mockImplementation((query: { sql: string }) => {
    if (query.sql.startsWith("select")) {
      return Promise.resolve({ rows: [EXISTING] });
    }

    lastUpdateSql = query.sql;

    return Promise.resolve({ rows: [] });
  });
});

describe("updateTrack — the visible-field lastmod bump", () => {
  it("bumps updated_at when the observation audio is written (a visible artifact)", async () => {
    await updateTrack("track-123", {
      observationAudioUrl: "https://found.fluncle.com/004.7.2I/observation.mp3",
      observationDurationMs: 28000,
      observationGeneratedAt: "2026-06-20T00:00:00.000Z",
    });

    expect(lastUpdateSql).toContain("observation_audio_url = ?");
    expect(lastUpdateSql).toContain("updated_at = ?");
  });

  it("does NOT bump updated_at for a context_note-only write (internal fuel)", async () => {
    await updateTrack("track-123", { contextNote: "Signature Records, 2008." });

    expect(lastUpdateSql).toContain("context_note = ?");
    expect(lastUpdateSql).not.toContain("updated_at = ?");
  });

  it("does NOT bump updated_at for a features-only write (training data)", async () => {
    await updateTrack("track-123", { features: '{"onsetRate":12}' });

    expect(lastUpdateSql).toContain("features_json = ?");
    expect(lastUpdateSql).not.toContain("updated_at = ?");
  });

  it("does NOT bump updated_at for a provenance-only write (internal analysis metadata)", async () => {
    await updateTrack("track-123", {
      analyzedAt: "2026-07-10T00:00:00.000Z",
      analyzedFrom: "full",
      bpmConfidence: 0.92,
      bpmSource: "audio-file",
      keyConfidence: 0.81,
      keySource: "audio-file",
    });

    expect(lastUpdateSql).toContain("analyzed_from = ?");
    expect(lastUpdateSql).toContain("bpm_source = ?");
    expect(lastUpdateSql).toContain("key_confidence = ?");
    expect(lastUpdateSql).not.toContain("updated_at = ?");
  });

  it("does NOT bump updated_at for an observation_script-only write (internal transcript)", async () => {
    await updateTrack("track-123", { observationScript: "The name made me pause…" });

    expect(lastUpdateSql).toContain("observation_script = ?");
    expect(lastUpdateSql).not.toContain("updated_at = ?");
  });

  it("does NOT bump updated_at for a galaxy assignment (internal grouping, VISIBLE_FIELDS excluded)", async () => {
    // The browse-by-feel ratified confirmation: a galaxy assignment surfaces only once
    // the galaxy is operator-named, so writing galaxy_id moves no public lastmod (the
    // embedding precedent). The built-in purgeLogCache keeps the /log prose fresh.
    await updateTrack("track-123", { galaxyId: "gal_abc" });

    expect(lastUpdateSql).toContain("galaxy_id = ?");
    expect(lastUpdateSql).not.toContain("updated_at = ?");
  });

  it("clears the galaxy assignment to null on an empty string (re-queue path)", async () => {
    const argsSeen: unknown[] = [];
    execute.mockImplementation((query: { args?: unknown[]; sql: string }) => {
      if (query.sql.startsWith("select")) {
        return Promise.resolve({ rows: [EXISTING] });
      }
      lastUpdateSql = query.sql;
      argsSeen.push(...(query.args ?? []));
      return Promise.resolve({ rows: [] });
    });

    await updateTrack("track-123", { galaxyId: "" });

    expect(lastUpdateSql).toContain("galaxy_id = ?");
    // The first bound arg is the cleared (null) galaxy id, not an empty string.
    expect(argsSeen[0]).toBeNull();
  });

  it("bumps updated_at for an editorial note write (public copy)", async () => {
    await updateTrack("track-123", { note: "Knees up the second it dropped." });

    expect(lastUpdateSql).toContain("note = ?");
    expect(lastUpdateSql).toContain("updated_at = ?");
  });

  it("clears the observation audio to null on an empty string (re-render path)", async () => {
    const argsSeen: unknown[] = [];
    execute.mockImplementation((query: { args?: unknown[]; sql: string }) => {
      if (query.sql.startsWith("select")) {
        return Promise.resolve({ rows: [EXISTING] });
      }
      lastUpdateSql = query.sql;
      argsSeen.push(...(query.args ?? []));
      return Promise.resolve({ rows: [] });
    });

    await updateTrack("track-123", { observationAudioUrl: "" });

    expect(lastUpdateSql).toContain("observation_audio_url = ?");
    // The first bound arg is the cleared (null) audio url.
    expect(argsSeen[0]).toBeNull();
  });
});

describe("updateTrack — the column allowlist (the agent-tier write guard)", () => {
  it("ignores an unknown field instead of writing it (allowlist, not passthrough)", async () => {
    // A field that is not on TrackUpdate / the known `if (update.x !== undefined)`
    // ladder must never reach the SQL — it is silently dropped, not interpolated
    // into the column list. With only the unknown field present, no real column is
    // set, so updateTrack rejects with no_fields rather than emitting a write.
    await expect(
      updateTrack("track-123", {
        droppedColumn: "1; drop table tracks",
      } as unknown as Parameters<typeof updateTrack>[1]),
    ).rejects.toMatchObject({ code: "no_fields", status: 400 });

    expect(lastUpdateSql).toBe("");
  });

  it("writes only the known field when an unknown field rides alongside it", async () => {
    await updateTrack("track-123", {
      bpm: 174,
      somethingElse: "ignored",
    } as unknown as Parameters<typeof updateTrack>[1]);

    expect(lastUpdateSql).toContain("bpm = ?");
    expect(lastUpdateSql).not.toContain("somethingElse");
    expect(lastUpdateSql).not.toContain("something_else");
  });
});

describe("updateTrack — isrc immutability and validation (identity guard)", () => {
  it("rejects an isrc write with a 409 when one is already set (immutable identity)", async () => {
    // EXISTING.isrc is "GB1234567890" — already set, so any isrc write is a 409.
    await expect(updateTrack("track-123", { isrc: "US9999999999" })).rejects.toMatchObject({
      code: "immutable",
      status: 409,
    });

    expect(lastUpdateSql).toBe("");
  });

  it("rejects a blank isrc backfill with a 400 (invalid_isrc) into a null slot", async () => {
    execute.mockReset();
    execute.mockImplementation((query: { sql: string }) => {
      if (query.sql.startsWith("select")) {
        // A row whose isrc slot is empty, so the backfill path is reached.
        return Promise.resolve({ rows: [{ ...EXISTING, isrc: null }] });
      }

      lastUpdateSql = query.sql;

      return Promise.resolve({ rows: [] });
    });

    await expect(updateTrack("track-123", { isrc: "   " })).rejects.toMatchObject({
      code: "invalid_isrc",
      status: 400,
    });

    expect(lastUpdateSql).toBe("");
  });

  it("backfills a trimmed isrc into a null slot (the one-time repair path)", async () => {
    const argsSeen: unknown[] = [];
    execute.mockReset();
    execute.mockImplementation((query: { args?: unknown[]; sql: string }) => {
      if (query.sql.startsWith("select")) {
        return Promise.resolve({ rows: [{ ...EXISTING, isrc: null }] });
      }

      lastUpdateSql = query.sql;
      argsSeen.push(...(query.args ?? []));

      return Promise.resolve({ rows: [] });
    });

    await updateTrack("track-123", { isrc: "  US9999999999  " });

    expect(lastUpdateSql).toContain("isrc = ?");
    // isrc is a visible identity repair, so it bumps lastmod.
    expect(lastUpdateSql).toContain("updated_at = ?");
    expect(argsSeen).toContain("US9999999999");
  });
});

describe("updateTrack — the source hierarchy (operator > rekordbox > DSP)", () => {
  // Re-mock the SELECT to return a row with the given provenance sources, and capture
  // the UPDATE's sql + bound args so we can assert exactly which columns/values land.
  function mockExisting(row: Partial<typeof EXISTING> & Record<string, unknown>) {
    const argsSeen: unknown[] = [];
    execute.mockReset();
    execute.mockImplementation((query: { args?: unknown[]; sql: string }) => {
      if (query.sql.startsWith("select")) {
        return Promise.resolve({ rows: [{ ...EXISTING, ...row }] });
      }

      lastUpdateSql = query.sql;
      argsSeen.push(...(query.args ?? []));

      return Promise.resolve({ rows: [] });
    });

    return argsSeen;
  }

  it("drops an AGENT key write on a rekordbox-sourced row (bpm still applies)", async () => {
    mockExisting({ bpm_source: "audio-file", key_source: "rekordbox" });

    const result = await updateTrack(
      "track-123",
      {
        bpm: 174,
        bpmSource: "audio-file",
        key: "A minor",
        keyConfidence: 0.4,
        keySource: "audio-file",
      },
      { writer: "agent" },
    );

    // The key + its provenance are dropped; the bpm write survives untouched.
    expect(lastUpdateSql).not.toContain("key = ?");
    expect(lastUpdateSql).not.toContain("key_source = ?");
    expect(lastUpdateSql).not.toContain("key_confidence = ?");
    expect(lastUpdateSql).toContain("bpm = ?");
    expect(lastUpdateSql).toContain("bpm_source = ?");
    // bpm is a VISIBLE field, so the surviving write still bumps lastmod.
    expect(lastUpdateSql).toContain("updated_at = ?");
    expect(result.fields).toContain("bpm");
    expect(result.fields).not.toContain("key");
  });

  it("drops an AGENT bpm write on a rekordbox-sourced row (key still applies)", async () => {
    mockExisting({ bpm_source: "rekordbox", key_source: "audio-file" });

    await updateTrack(
      "track-123",
      { bpm: 174, bpmConfidence: 0.5, bpmSource: "audio-file", key: "F minor" },
      { writer: "agent" },
    );

    expect(lastUpdateSql).not.toContain("bpm = ?");
    expect(lastUpdateSql).not.toContain("bpm_source = ?");
    expect(lastUpdateSql).not.toContain("bpm_confidence = ?");
    expect(lastUpdateSql).toContain("key = ?");
  });

  it("also protects an OPERATOR-sourced key from an AGENT write", async () => {
    mockExisting({ key_source: "operator" });

    await updateTrack(
      "track-123",
      { enrichmentStatus: "done", key: "C major", keySource: "audio-file" },
      { writer: "agent" },
    );

    expect(lastUpdateSql).not.toContain("key = ?");
    // Everything else in the same update still applies (the sweep keeps succeeding).
    expect(lastUpdateSql).toContain("enrichment_status = ?");
  });

  it("lets an AGENT overwrite a DSP-sourced key (a real upgrade, not a downgrade)", async () => {
    mockExisting({ bpm_source: "deezer:search", key_source: "audio-file" });

    await updateTrack(
      "track-123",
      { bpm: 174, key: "F minor", keySource: "audio-file" },
      { writer: "agent" },
    );

    // audio-file / deezer are DSP sources, NOT protected — the agent write lands.
    expect(lastUpdateSql).toContain("key = ?");
    expect(lastUpdateSql).toContain("bpm = ?");
  });

  it("is a silent no-op (not a no_fields error) when the guard empties the update", async () => {
    mockExisting({ bpm_source: "rekordbox", key_source: "rekordbox" });

    // An agent write carrying ONLY key/bpm provenance onto a fully-protected row: every
    // field is dropped, so there is nothing left to write — a clean success, no throw.
    const result = await updateTrack(
      "track-123",
      { bpm: 174, key: "A minor", keySource: "audio-file" },
      { writer: "agent" },
    );

    expect(result.fields).toEqual([]);
    // No UPDATE emitted at all.
    expect(lastUpdateSql).toBe("");
  });

  it("stamps key_source=operator when the OPERATOR hand-sets a key with no source", async () => {
    const argsSeen = mockExisting({ key_source: null });

    await updateTrack("track-123", { key: "G minor" }, { writer: "operator" });

    expect(lastUpdateSql).toContain("key = ?");
    expect(lastUpdateSql).toContain("key_source = ?");
    // The stamped source value is the literal "operator".
    expect(argsSeen).toContain("operator");
  });

  it("stamps bpm_source=operator when the OPERATOR hand-sets a bpm with no source", async () => {
    const argsSeen = mockExisting({ bpm_source: null });

    await updateTrack("track-123", { bpm: 172 }, { writer: "operator" });

    expect(lastUpdateSql).toContain("bpm_source = ?");
    expect(argsSeen).toContain("operator");
  });

  it("keeps an explicit --key-source rekordbox on an OPERATOR write (the backfill)", async () => {
    const argsSeen = mockExisting({ key_source: null });

    await updateTrack(
      "track-123",
      { key: "Bb minor", keySource: "rekordbox" },
      { writer: "operator" },
    );

    expect(lastUpdateSql).toContain("key_source = ?");
    // The operator's explicit source wins over the auto-stamp — rekordbox, not operator.
    expect(argsSeen).toContain("rekordbox");
    expect(argsSeen).not.toContain("operator");
  });

  it("leaves bpm/key untouched when no writer tier is supplied (internal server write)", async () => {
    mockExisting({ bpm_source: "rekordbox", key_source: "rekordbox" });

    // With no `writer` the provenance guard is inert — a trusted internal write lands.
    await updateTrack("track-123", { bpm: 174, key: "A minor" });

    expect(lastUpdateSql).toContain("bpm = ?");
    expect(lastUpdateSql).toContain("key = ?");
  });

  it("does NOT bump updated_at for a guard-dropped agent provenance write", async () => {
    mockExisting({ key_source: "rekordbox" });

    // Only key provenance is written and it's dropped; the surviving keyConfidence-less
    // payload has just analyzedAt (internal), so no visible field → no lastmod bump.
    await updateTrack(
      "track-123",
      { analyzedAt: "2026-07-10T00:00:00.000Z", key: "A minor", keySource: "audio-file" },
      { writer: "agent" },
    );

    expect(lastUpdateSql).toContain("analyzed_at = ?");
    expect(lastUpdateSql).not.toContain("key = ?");
    expect(lastUpdateSql).not.toContain("updated_at = ?");
  });
});

describe("updateTrack — empty-string clears to null (not stored as '')", () => {
  const clearableFields: Array<{ column: string; field: keyof Parameters<typeof updateTrack>[1] }> =
    [
      { column: "video_url = ?", field: "videoUrl" },
      { column: "observation_audio_url = ?", field: "observationAudioUrl" },
      { column: "observation_script = ?", field: "observationScript" },
      { column: "video_squared_at = ?", field: "videoSquaredAt" },
    ];

  for (const { column, field } of clearableFields) {
    it(`clears ${String(field)} to null on an empty string`, async () => {
      const argsSeen: unknown[] = [];
      execute.mockReset();
      execute.mockImplementation((query: { args?: unknown[]; sql: string }) => {
        if (query.sql.startsWith("select")) {
          return Promise.resolve({ rows: [EXISTING] });
        }

        lastUpdateSql = query.sql;
        argsSeen.push(...(query.args ?? []));

        return Promise.resolve({ rows: [] });
      });

      await updateTrack("track-123", { [field]: "" });

      expect(lastUpdateSql).toContain(column);
      // The first bound arg is the cleared (null) value, not an empty string.
      expect(argsSeen[0]).toBeNull();
    });
  }
});
