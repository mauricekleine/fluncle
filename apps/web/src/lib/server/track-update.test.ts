import { beforeEach, describe, expect, it, vi } from "vitest";

import { updateTrack } from "./track-update";

// updateTrack runs two statements: a SELECT (existing isrc/log_id/added_at) then
// the UPDATE. The mock returns an existing row for the SELECT and captures the
// UPDATE so we can assert which columns it set — specifically whether it bumped
// `updated_at` (the sitemap/log lastmod source). Internal fuel fields (features,
// context_note) must NOT bump it; visible fields (observation audio, note) must.

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  // `updateTrack` fans ONE logical write out across the tracks/findings pair, issued as a
  // single libSQL BATCH (at most two statements: the recording's columns, then the
  // certification's). The mock replays each statement through the same `execute` spy the
  // tests already assert on, so a batched write is observed like a single
  // UPDATE — one call per statement, in order, with its bound args.
  getDb: async () => ({
    batch: (statements: { args?: unknown[]; sql: string }[]) =>
      Promise.all(statements.map((statement) => execute(statement))),
    execute,
  }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

// The officialness gate makes a real oEmbed request, so it is stubbed here: this file is about
// which COLUMNS a write sets, and a unit test must never reach YouTube. The gate's own logic is
// proven in youtube-official.test.ts.
const checkYoutubeOfficial = vi.hoisted(() => vi.fn(async () => 1 as null | number));

vi.mock("./youtube-official", () => ({ checkYoutubeOfficial }));

// A CERTIFIED finding: the resolve query outer-joins `findings`, so `certified` is the flag
// that says a `findings` row exists. Every case in this file is about a finding; the
// UNCERTIFIED (catalogue) half of `updateTrack` — the certification rail — is proven against
// the real schema in findings-certification.integration.test.ts, where a mock could not.
const EXISTING = {
  added_at: "2026-06-01T00:00:00.000Z",
  artists_json: '["Calibre"]',
  certified: 1,
  isrc: "GB1234567890",
  label: null,
  label_name: null,
  log_id: "004.7.2I",
  title: "No Reply",
  youtube_video_id: null,
  youtube_video_official: null,
};

/** Re-point the SELECT at a modified existing row, keeping the UPDATE capture intact. */
function withExistingRow(overrides: Record<string, unknown>): void {
  execute.mockImplementation((query: { args?: unknown[]; sql: string }) => {
    if (query.sql.startsWith("select")) {
      return Promise.resolve({ rows: [{ ...EXISTING, ...overrides }] });
    }

    lastUpdateSql += query.sql;
    lastUpdateArgs = lastUpdateArgs.concat(query.args ?? []);

    return Promise.resolve({ rows: [] });
  });
}

let lastUpdateSql = "";
let lastUpdateArgs: unknown[] = [];

beforeEach(() => {
  lastUpdateSql = "";
  lastUpdateArgs = [];
  execute.mockReset();
  checkYoutubeOfficial.mockClear();
  checkYoutubeOfficial.mockResolvedValue(1);
  execute.mockImplementation((query: { args?: unknown[]; sql: string }) => {
    if (query.sql.startsWith("select")) {
      return Promise.resolve({ rows: [EXISTING] });
    }

    lastUpdateSql += query.sql;
    lastUpdateArgs = lastUpdateArgs.concat(query.args ?? []);

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
      lastUpdateSql += query.sql;
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
      lastUpdateSql += query.sql;
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

      lastUpdateSql += query.sql;

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

      lastUpdateSql += query.sql;
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

      lastUpdateSql += query.sql;
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

        lastUpdateSql += query.sql;
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

// ---------------------------------------------------------------------------
// THE PROVENANCE INVARIANT (docs/agents/prompt-registry.md).
//
// A `*_prompt_version` column always describes the text CURRENTLY in its row, or it is
// NULL. It must never be left pointing at the prompt that wrote the text it just replaced
// — that is worse than pointing at nothing, because it is a confident WRONG answer to the
// one question the column exists to answer ("which prompt drafted this?").
//
// The scenario that makes this bite: the auto-note sweep writes a note under prompt v7,
// the operator reads it, hates it, and types their own over the top through the generic
// `update_track` path. If the version stayed at 7, the archive would claim v7 wrote a line
// v7 has never seen.
// ---------------------------------------------------------------------------

describe("updateTrack — the prompt-provenance invariant", () => {
  it("CLEARS note_prompt_version when the note is rewritten with no stated provenance", async () => {
    // The operator typing over an auto-note. No prompt wrote this line, so no prompt may
    // be credited with it.
    await updateTrack("track-123", { note: "My own words, thanks." });

    expect(lastUpdateSql).toContain("note = ?");
    expect(lastUpdateSql).toContain("note_prompt_version = ?");

    const update = execute.mock.calls
      .map((call) => call[0] as { args: unknown[]; sql: string })
      .find((query) => query.sql.includes("note = ?"));

    expect(update?.args).toContain(null);
  });

  it("KEEPS the stated version when the authoring path supplies one", async () => {
    await updateTrack("track-123", { note: "Authored under v7.", notePromptVersion: 7 });

    const update = execute.mock.calls
      .map((call) => call[0] as { args: unknown[]; sql: string })
      .find((query) => query.sql.includes("note_prompt_version = ?"));

    expect(update?.args).toContain(7);
    // And it is written EXACTLY once — never once as the stated value and again as null.
    expect(lastUpdateSql.match(/note_prompt_version = \?/g)).toHaveLength(1);
  });

  it("CLEARS context_prompt_version when the context note is rewritten bare", async () => {
    await updateTrack("track-123", { contextNote: "Hand-corrected facts." });

    expect(lastUpdateSql).toContain("context_prompt_version = ?");
    expect(lastUpdateSql.match(/context_prompt_version = \?/g)).toHaveLength(1);
  });

  it("CLEARS observation_prompt_version when the script is rewritten bare", async () => {
    await updateTrack("track-123", { observationScript: "A hand-written script." });

    expect(lastUpdateSql).toContain("observation_prompt_version = ?");
    expect(lastUpdateSql.match(/observation_prompt_version = \?/g)).toHaveLength(1);
  });

  it("does not touch a version column when its text is not being written", async () => {
    await updateTrack("track-123", { bpm: 174 });

    expect(lastUpdateSql).not.toContain("note_prompt_version");
    expect(lastUpdateSql).not.toContain("context_prompt_version");
    expect(lastUpdateSql).not.toContain("observation_prompt_version");
  });
});

describe("updateTrack — the capture's YouTube provenance", () => {
  it("rules on the upload server-side and writes the id, the verdict, and the stamp together", async () => {
    await updateTrack("track-123", {
      captureVerification: "preview-match",
      youtubeVideoId: "dQw4w9WgXcQ",
    });

    // The gate is asked with the recording's OWN names — the comparison it makes is "is this
    // channel one of the people this track is by, or the label it came out on".
    expect(checkYoutubeOfficial).toHaveBeenCalledWith("dQw4w9WgXcQ", {
      artists: ["Calibre"],
      labels: [],
    });
    expect(lastUpdateSql).toContain("youtube_video_id = coalesce(youtube_video_id, ?)");
    expect(lastUpdateSql).toContain("youtube_video_official = case");
    expect(lastUpdateSql).toContain("youtube_verified_at = case");
    expect(lastUpdateArgs).toContain("dQw4w9WgXcQ");
    expect(lastUpdateArgs).toContain(1);
  });

  it("stores the verdict the SERVER reached, never one the caller supplied", async () => {
    // The box reports an id; permission is not its to grant. An unconcluded check stores NULL,
    // which renders nothing — the honest degradation.
    checkYoutubeOfficial.mockResolvedValue(null);

    await updateTrack("track-123", {
      captureVerification: "preview-match",
      youtubeVideoId: "uncheckedId",
    });

    expect(lastUpdateSql).toContain("youtube_video_id = coalesce");
    expect(lastUpdateArgs).toContain(null);
  });

  it("does NOT bump updated_at — capture provenance moves no public surface", async () => {
    await updateTrack("track-123", {
      captureVerification: "preview-match",
      youtubeVideoId: "dQw4w9WgXcQ",
    });

    expect(lastUpdateSql).not.toContain("updated_at = ?");
  });

  it("gates the VERDICT on the id being empty, so a later check cannot adopt an earlier id", async () => {
    // The trap `coalesce` alone would walk into: `youtube_video_official` is legitimately NULL
    // beside a set id, so coalescing the verdict would let a second capture's ruling attach itself
    // to the first capture's upload. Both stamp clauses therefore test the PRE-UPDATE id.
    await updateTrack("track-123", {
      captureVerification: "preview-match",
      youtubeVideoId: "dQw4w9WgXcQ",
    });

    expect(lastUpdateSql).toContain(
      "youtube_video_official = case when youtube_video_id is null then ? else youtube_video_official end",
    );
    expect(lastUpdateSql).toContain(
      "youtube_verified_at = case when youtube_video_id is null then ? else youtube_verified_at end",
    );
  });

  it("refuses an id from the ABSTAIN path, where nothing was fingerprinted", async () => {
    // `unverified` is the capture sweep's honest abstain: the track had no preview reference, so
    // the bytes were kept on duration and ranking alone and no comparison ran. The envelope serves
    // this id under `method: "fingerprint"`, so taking one from here would print "matched by audio
    // fingerprint" beneath a match that never happened. The sweep withholds it; the server refuses
    // it regardless, so a stale box build cannot talk its way past.
    await updateTrack("track-123", {
      captureVerification: "unverified",
      youtubeVideoId: "abstainId",
    });

    expect(checkYoutubeOfficial).not.toHaveBeenCalled();
    expect(lastUpdateSql).not.toContain("youtube_video_id");
    // The capture itself still lands — only the optional provenance is dropped.
    expect(lastUpdateSql).toContain("capture_verification");
  });

  it("fails CLOSED on an id that arrives with no verdict beside it", async () => {
    await updateTrack("track-123", { captureStatus: "done", youtubeVideoId: "orphanId" });

    expect(checkYoutubeOfficial).not.toHaveBeenCalled();
    expect(lastUpdateSql).not.toContain("youtube_video_id");
  });

  it("spends no oEmbed request on a row that already holds an id", async () => {
    // Fill-empty-only short-circuits BEFORE the network: the write would discard the answer, so
    // asking for it would be a request bought for nothing.
    execute.mockImplementation((query: { args?: unknown[]; sql: string }) => {
      if (query.sql.startsWith("select")) {
        return Promise.resolve({ rows: [{ ...EXISTING, youtube_video_id: "alreadyHeld" }] });
      }

      lastUpdateSql += query.sql;

      return Promise.resolve({ rows: [] });
    });

    await updateTrack("track-123", {
      captureStatus: "done",
      captureVerification: "preview-match",
      youtubeVideoId: "secondCapture",
    });

    expect(checkYoutubeOfficial).not.toHaveBeenCalled();
    expect(lastUpdateSql).not.toContain("youtube_video_id");
    // The rest of the capture write still lands — the provenance is optional, the capture is not.
    expect(lastUpdateSql).toContain("capture_status");
  });

  it("asks the gate with the recording's LABEL as well as its artists", async () => {
    // A D&B release lives on its label's channel far more often than on
    // the artist's. BOTH spellings go in — the canonical `labels.name` and the raw `tracks.label` —
    // because a crawled row may only have the second, and a channel matching either is the label's.
    withExistingRow({ label: "Fokuz", label_name: "Fokuz Recordings" });

    await updateTrack("track-123", {
      captureVerification: "preview-match",
      youtubeVideoId: "RFObrLVHMvg",
    });

    expect(checkYoutubeOfficial).toHaveBeenCalledWith("RFObrLVHMvg", {
      artists: ["Calibre"],
      labels: ["Fokuz Recordings", "Fokuz"],
    });
  });
});

describe("updateTrack — the PROVENANCE backfill's write path", () => {
  it("accepts an id proved by the provenance sweep, with no capture column in the body", async () => {
    // The backfill re-ran the whole ladder over an already-captured row and threw the candidate
    // bytes away. It has capture's PROOF and deliberately no capture WRITE, so it carries its own
    // verdict field — and the server accepts that as authorization for the id exactly as it accepts
    // `captureVerification` on the capture path.
    await updateTrack("track-123", {
      youtubeVerification: "preview-match",
      youtubeVideoId: "dQw4w9WgXcQ",
    });

    expect(checkYoutubeOfficial).toHaveBeenCalledWith("dQw4w9WgXcQ", {
      artists: ["Calibre"],
      labels: [],
    });
    expect(lastUpdateSql).toContain("youtube_video_id = coalesce(youtube_video_id, ?)");
    expect(lastUpdateArgs).toContain("dQw4w9WgXcQ");
  });

  it("THE RAIL — a provenance write can never move a capture column", async () => {
    // The pilot's verdict, enforced at the boundary rather than only in the box script: a recapture
    // replaced a finding's clean archived audio with a fan blend that legitimately passed the
    // fingerprint gate. The backfill's payload carries no capture field, so its statement cannot
    // set one — and this is the assertion a future box build cannot talk its way past.
    await updateTrack("track-123", {
      youtubeVerification: "preview-match",
      youtubeVideoId: "dQw4w9WgXcQ",
    });

    for (const column of [
      "source_audio_key",
      "capture_status",
      "capture_verification",
      "capture_verified_at",
      "source_audio_bytes",
      "source_audio_captured_at",
      "source_audio_attempted_at",
      "source_audio_failures",
      "source_audio_rejected",
      "enrichment_status",
    ]) {
      expect(lastUpdateSql).not.toContain(column);
    }
  });

  it("records a NO-MATCH as a stamp and nothing else", async () => {
    // The ladder ran and cost a real download. Without this the worklist hands the same row back
    // next tick and buys it again, forever. The stamp is a SCHEDULE, not a verdict: the id stays
    // NULL, so a later capture still fills it.
    await updateTrack("track-123", { youtubeVerification: "no-match" });

    expect(checkYoutubeOfficial).not.toHaveBeenCalled();
    expect(lastUpdateSql).toContain(
      "youtube_verified_at = case when youtube_video_id is null then ? else youtube_verified_at end",
    );
    expect(lastUpdateSql).not.toContain("youtube_video_id = coalesce");
    expect(lastUpdateSql).not.toContain("youtube_video_official");
  });

  it("refuses a bare id from the provenance path too — the guard is the PAYLOAD, not the sender", async () => {
    // The server cannot know which sweep sent a body, and does not try to. What it checks is
    // whether a fingerprint verdict rides along, and `no-match` is not one.
    await updateTrack("track-123", {
      youtubeVerification: "no-match",
      youtubeVideoId: "unprovenId",
    });

    expect(checkYoutubeOfficial).not.toHaveBeenCalled();
    expect(lastUpdateSql).not.toContain("youtube_video_id");
    // …and the no-match stamp is withheld too: a body claiming both is not a shape any sweep sends.
    expect(lastUpdateSql).not.toContain("youtube_verified_at");
  });

  it("leaves a row that already holds an id alone, id and stamp both", async () => {
    withExistingRow({ youtube_video_id: "alreadyHeld" });

    await updateTrack("track-123", { youtubeVerification: "no-match" });

    expect(lastUpdateSql).not.toContain("youtube_verified_at");
  });
});

describe("updateTrack — SoundCloud provenance evidence", () => {
  it("banks a preview fingerprint match without moving any YouTube or public-lastmod field", async () => {
    await updateTrack("track-123", { sourceVerification: "soundcloud-preview-match" });

    expect(lastUpdateSql).toContain("source_verification = ?");
    expect(lastUpdateArgs).toContain("soundcloud-preview-match");
    expect(lastUpdateSql).not.toContain("youtube_");
    expect(lastUpdateSql).not.toContain("updated_at");
    expect(checkYoutubeOfficial).not.toHaveBeenCalled();
  });

  it("banks an archive fingerprint match under its distinct claim", async () => {
    await updateTrack("track-123", { sourceVerification: "soundcloud-archive-match" });

    expect(lastUpdateSql).toContain("source_verification = ?");
    expect(lastUpdateArgs).toContain("soundcloud-archive-match");
    expect(lastUpdateSql).not.toContain("youtube_");
  });

  it("silently drops an unrecognised claim at the final server write boundary", async () => {
    await expect(
      updateTrack("track-123", { sourceVerification: "soundcloud-maybe-match" as never }),
    ).resolves.toEqual({ fields: [], trackId: "track-123" });

    expect(lastUpdateSql).toBe("");
  });
});

describe("updateTrack — the CATALOGUE ladder's verdicts", () => {
  it("accepts the Topic rung's metadata proof and stores it as `search`, never `fingerprint`", async () => {
    // The rung matched artist, title and length on an `<Artist> - Topic` art-track channel and
    // compared NO AUDIO. That is a real claim and a weaker one, so the receipt has to say the weaker
    // thing: `search` renders "matched by artist, title, and length" on /identity, and the id must
    // never be able to arrive wearing the fingerprint's sentence.
    await updateTrack("track-123", {
      youtubeVerification: "metadata-match",
      youtubeVideoId: "topicId",
    });

    expect(checkYoutubeOfficial).toHaveBeenCalledWith("topicId", {
      artists: ["Calibre"],
      labels: [],
    });
    expect(lastUpdateSql).toContain("youtube_video_id = coalesce(youtube_video_id, ?)");
    expect(lastUpdateSql).toContain(
      "youtube_verified_by = case when youtube_video_id is null then ? else youtube_verified_by end",
    );
    expect(lastUpdateArgs).toContain("search");
    expect(lastUpdateArgs).not.toContain("fingerprint");
  });

  it("OFFICIALNESS IS STILL THE SERVER'S CALL, even on a Topic pick the box could see", async () => {
    // The box knows the channel name and could have ruled; it deliberately does not. The same
    // keyless oEmbed check runs, and a Topic channel earns its 1 from the server's own rule.
    await updateTrack("track-123", {
      youtubeVerification: "metadata-match",
      youtubeVideoId: "topicId",
    });

    expect(lastUpdateSql).toContain("youtube_video_official = case");
    expect(lastUpdateArgs).toContain(1);
  });

  it("accepts the segment rung's archive fingerprint under the SAME claim as a preview one", async () => {
    // `archive-match` names what was compared — the row's own archived master rather than a 30s
    // preview — and carries the identical claim class, because both are the sound.
    await updateTrack("track-123", {
      youtubeVerification: "archive-match",
      youtubeVideoId: "segmentId",
    });

    expect(lastUpdateSql).toContain("youtube_video_id = coalesce(youtube_video_id, ?)");
    expect(lastUpdateArgs).toContain("fingerprint");
    expect(lastUpdateArgs).not.toContain("search");
  });

  it("the legacy preview proof still stores `fingerprint`, so no historic receipt moves", async () => {
    await updateTrack("track-123", {
      youtubeVerification: "preview-match",
      youtubeVideoId: "previewId",
    });

    expect(lastUpdateArgs).toContain("fingerprint");
  });

  it("an UNRECOGNISED verdict proves nothing — fail closed, exactly like a bare id", async () => {
    // The map is the guard. A verdict value the server does not know maps to no method, so it
    // authorizes no id — which is what keeps a future or garbled box build from talking its way in.
    await updateTrack("track-123", {
      youtubeVerification: "sounds-about-right" as never,
      youtubeVideoId: "smuggledId",
    });

    expect(checkYoutubeOfficial).not.toHaveBeenCalled();
    expect(lastUpdateSql).not.toContain("youtube_video_id");
  });

  it("an INCONCLUSIVE run moves the streak and NOTHING else — no stamp, no receipt", async () => {
    // The ladder ran and the CDN refused every section it tried. That is not an answer, so burning
    // the 90-day window on it would cost the row months for a reason that had nothing to do with the
    // row. The streak still moves, because a row refused forever must stop being asked forever.
    await updateTrack("track-123", { youtubeVerification: "inconclusive" });

    expect(lastUpdateSql).toContain(
      "youtube_provenance_failures = coalesce(youtube_provenance_failures, 0) + 1",
    );
    expect(lastUpdateSql).not.toContain("youtube_verified_at");
    expect(lastUpdateSql).not.toContain("youtube_video_id");
    expect(checkYoutubeOfficial).not.toHaveBeenCalled();
  });

  it("a NO-MATCH moves the streak AS WELL AS the stamp", async () => {
    // The window paces a row that concluded honestly; the streak retires one that never will. Both
    // empty-handed reports move it, so a row that never concludes still reaches the cap.
    await updateTrack("track-123", { youtubeVerification: "no-match" });

    expect(lastUpdateSql).toContain(
      "youtube_provenance_failures = coalesce(youtube_provenance_failures, 0) + 1",
    );
    expect(lastUpdateSql).toContain("youtube_verified_at = case");
  });

  it("neither empty-handed report touches a row that already holds an id", async () => {
    withExistingRow({ youtube_video_id: "alreadyHeld" });

    await updateTrack("track-123", { youtubeVerification: "inconclusive" });

    expect(lastUpdateSql).not.toContain("youtube_provenance_failures");
  });

  it("an unrecognised verdict on its own is a silent no-op, never a `no_fields` 400", async () => {
    // The box's whole payload is these fields, so a declined ask has to read as success or a stale
    // build would see a failed write and call the sweep broken.
    await expect(
      updateTrack("track-123", { youtubeVerification: "sounds-about-right" as never }),
    ).resolves.toBeDefined();
  });
});

describe("updateTrack — the RE-VERDICT", () => {
  it("re-rules a refused id under the current heuristic and re-stamps it", async () => {
    // The live case: a row holding `RFObrLVHMvg` (uploaded by "Fokuz Recordings", its label) was
    // ruled 0 under the artist-only rule. The widened rule says 1, and this is the path that
    // reaches it — no id moves, no capture column moves, and no download is spent.
    withExistingRow({
      label_name: "Fokuz Recordings",
      youtube_video_id: "RFObrLVHMvg",
      youtube_video_official: 0,
    });

    await updateTrack("track-123", { youtubeReverdict: true });

    expect(checkYoutubeOfficial).toHaveBeenCalledWith("RFObrLVHMvg", {
      artists: ["Calibre"],
      labels: ["Fokuz Recordings"],
    });
    expect(lastUpdateSql).toContain("youtube_video_official = ?");
    expect(lastUpdateSql).toContain("youtube_verified_at = ?");
    expect(lastUpdateArgs).toContain(1);
    // The id itself is never rewritten — the re-verdict rules on what is already there.
    expect(lastUpdateSql).not.toContain("youtube_video_id =");
  });

  it("re-rules a NEVER-CONCLUDED id too", async () => {
    // NULL is "nobody checked" — an oEmbed that 404'd or timed out at capture time. It is exactly
    // the row a re-ask is for.
    withExistingRow({ youtube_video_id: "heldId", youtube_video_official: null });

    await updateTrack("track-123", { youtubeReverdict: true });

    expect(checkYoutubeOfficial).toHaveBeenCalled();
    expect(lastUpdateSql).toContain("youtube_video_official = ?");
  });

  it("NEVER DEMOTES — a row already ruled official is not re-asked at all", async () => {
    // The widening is the only reason to re-ask, so it can only ever say yes more often. A channel
    // that renamed itself must not quietly retract a link Fluncle has been serving.
    withExistingRow({ youtube_video_id: "heldId", youtube_video_official: 1 });

    await updateTrack("track-123", { youtubeReverdict: true });

    expect(checkYoutubeOfficial).not.toHaveBeenCalled();
    expect(lastUpdateSql).not.toContain("youtube_video_official");
  });

  it("does nothing on a row that holds no id — there is nothing to rule on", async () => {
    await updateTrack("track-123", { youtubeReverdict: true });

    expect(checkYoutubeOfficial).not.toHaveBeenCalled();
    expect(lastUpdateSql).not.toContain("youtube_video_official");
  });

  it("advances the stamp but keeps the existing verdict when the check does not conclude", async () => {
    // A 404 or a timeout says nothing about who uploaded it, so overwriting a stored 0 with NULL
    // would lose the fact that it WAS checked. The stamp still moves, so the round-robin walks on
    // instead of spinning on an unreachable video.
    checkYoutubeOfficial.mockResolvedValue(null);
    withExistingRow({ youtube_video_id: "goneId", youtube_video_official: 0 });

    await updateTrack("track-123", { youtubeReverdict: true });

    expect(lastUpdateSql).not.toContain("youtube_video_official");
    expect(lastUpdateSql).toContain("youtube_verified_at = ?");
  });

  it("moves no capture column and no public lastmod", async () => {
    withExistingRow({ youtube_video_id: "heldId", youtube_video_official: 0 });

    await updateTrack("track-123", { youtubeReverdict: true });

    expect(lastUpdateSql).not.toContain("updated_at = ?");
    expect(lastUpdateSql).not.toContain("capture_status");
    expect(lastUpdateSql).not.toContain("source_audio_key");
  });
});
