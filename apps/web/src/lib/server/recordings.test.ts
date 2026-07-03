import { beforeEach, describe, expect, it, vi } from "vitest";
import { promoteRecording } from "./recordings";

// promoteRecording's idempotency (RFC recording-primitive, Design B). The mixtapes-cue
// precedent: back the DB reads with one mutable state answered by SQL shape, and mock the
// mint path (./mixtapes) + the R2 copy/delete (./r2-presign) so the orchestration runs
// without a real libsql or R2. The three invariants under test:
//   - MINT-OR-REUSE: a fresh recording mints exactly one mixtape; a recording already
//     linked to a minted mixtape reuses it and NEVER mints again.
//   - COPY → REPOINT → DELETE-LAST: the set video is copied to `<logId>/set.mp4`, the
//     recording's r2Key is repointed there, and the OLD key is deleted LAST.
//   - a fully-promoted re-run is a no-op on R2 (no copy-onto-itself, no delete).

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  calls: [] as string[],
  // The findings catalogue backing the legacy text-match fallback.
  catalogue: [] as Row[],
  // The recording's `recording_cues` rows (the forward cue home).
  cues: [] as Row[],
  joinLogId: null as string | null,
  joinMixtapeId: null as string | null,
  linked: undefined as { id: string; log_id: string | null } | undefined,
  recording: {} as Row,
}));

// The default SQL-shape mock. Extracted + re-applied in `beforeEach` so a test that
// overrides the implementation (the claim-race test) can't leak into the next test.
const defaultExecute = vi.hoisted(() => async (query: { args: unknown[]; sql: string }) => {
  const sql = query.sql;

  // getRecording (the DTO read) — recordings LEFT JOIN mixtapes.
  if (sql.includes("left join mixtapes")) {
    return {
      rows: [
        { ...state.recording, mixtape_id: state.joinMixtapeId, mixtape_log_id: state.joinLogId },
      ],
    };
  }

  // getCueRows — the recording's cue rows (the finding-linked resolution path).
  if (sql.includes("from recording_cues")) {
    return { rows: state.cues };
  }

  // The findings catalogue read backing resolveFindingIdsByText.
  if (sql.includes("artists_json from tracks")) {
    return { rows: state.catalogue };
  }

  // getRecordingRow — the raw recordings row.
  if (sql.includes("from recordings where id")) {
    return { rows: [state.recording] };
  }

  // CLAIM-BEFORE-MINT: the atomic conditional insert that claims the recording link.
  // rowsAffected 1 = won the claim (no existing link); 0 = lost (a row already links).
  if (sql.startsWith("insert into mixtapes")) {
    state.calls.push("claim");
    return { rows: [], rowsAffected: state.linked ? 0 : 1 };
  }

  // mint-or-reuse probe + the loser's winner re-read.
  if (sql.includes("from mixtapes where recording_id")) {
    return { rows: state.linked ? [state.linked] : [] };
  }

  // link the freshly minted mixtape back to the recording (legacy path — unused since
  // the link now lands at claim time; kept so a stray call is still answered).
  if (sql.startsWith("update mixtapes set recording_id")) {
    state.calls.push("link");
    return { rows: [] };
  }

  // repoint the recording's owned key to the promoted mixtape's key.
  if (sql.startsWith("update recordings set r2_key")) {
    state.calls.push("repoint");
    state.recording.r2_key = query.args[0];
    return { rows: [] };
  }

  return { rows: [] };
});

const execute = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

const publishMixtape = vi.hoisted(() =>
  vi.fn(async () => {
    state.calls.push("mint");
    state.joinLogId = "020.F.1A";
    state.joinMixtapeId = "mix-1";
    return { logId: "020.F.1A" };
  }),
);
const setMixtapeMembers = vi.hoisted(() =>
  vi.fn(async () => {
    state.calls.push("members");
    return {};
  }),
);
const updateMixtape = vi.hoisted(() =>
  vi.fn(async () => {
    state.calls.push("flip");
    return {};
  }),
);

vi.mock("./mixtapes", () => ({
  publishMixtape,
  setMixtapeMembers,
  updateMixtape,
}));

const copyObject = vi.hoisted(() =>
  vi.fn(async () => {
    state.calls.push("copy");
  }),
);
const deleteObject = vi.hoisted(() =>
  vi.fn(async () => {
    state.calls.push("delete");
  }),
);

vi.mock("./r2-presign", () => ({ copyObject, deleteObject }));

function seedRecording(overrides: Row = {}): void {
  state.recording = {
    created_at: "2026-06-30T00:00:00.000Z",
    duration_ms: 3_600_000,
    id: "rec-1",
    r2_key: "recordings/rec-1/set.mp4",
    recorded_at: "2026-06-30T00:00:00.000Z",
    title: "Warehouse set",
    updated_at: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
  // The backfilled cue home: one finding-linked cue (the promote members source).
  state.cues = [
    {
      artists_text: "A",
      finding_id: "t1",
      id: "cue-1",
      position: 1,
      start_ms: 0,
      title_text: "T",
    },
  ];
}

beforeEach(() => {
  state.calls = [];
  state.catalogue = [];
  state.cues = [];
  state.linked = undefined;
  state.joinLogId = null;
  state.joinMixtapeId = null;
  execute.mockReset();
  execute.mockImplementation(defaultExecute);
  publishMixtape.mockClear();
  setMixtapeMembers.mockClear();
  updateMixtape.mockClear();
  copyObject.mockClear();
  deleteObject.mockClear();
});

describe("promoteRecording", () => {
  it("mints once on a fresh recording, then copies → repoints → deletes the old key LAST", async () => {
    seedRecording();

    const recording = await promoteRecording("rec-1");

    // CLAIMED the link (the conditional insert) BEFORE minting, then minted exactly one
    // mixtape, seeded from the resolved tracklist.
    expect(state.calls).toContain("claim");
    expect(state.calls.indexOf("claim")).toBeLessThan(state.calls.indexOf("mint"));
    expect(setMixtapeMembers).toHaveBeenCalledTimes(1);
    expect(publishMixtape).toHaveBeenCalledTimes(1);

    // Copied the set video from the owned key to the minted mixtape's derived key.
    expect(copyObject).toHaveBeenCalledWith("recordings/rec-1/set.mp4", "020.F.1A/set.mp4");

    // The old key is deleted LAST — after the copy AND after the r2Key repoint.
    expect(state.calls.indexOf("delete")).toBeGreaterThan(state.calls.indexOf("copy"));
    expect(state.calls.indexOf("delete")).toBeGreaterThan(state.calls.indexOf("repoint"));
    expect(deleteObject).toHaveBeenCalledWith("recordings/rec-1/set.mp4");

    // The returned recording now carries the promoted coordinate.
    expect(recording.logId).toBe("020.F.1A");
    expect(recording.r2Key).toBe("020.F.1A/set.mp4");
  });

  it("is a no-op on R2 for a fully-promoted re-run (reuse, no second mint, no copy/delete)", async () => {
    // The recording is already repointed at the promoted key + linked to its mixtape.
    seedRecording({ r2_key: "020.F.1A/set.mp4" });
    state.linked = { id: "mix-1", log_id: "020.F.1A" };
    state.joinLogId = "020.F.1A";
    state.joinMixtapeId = "mix-1";

    await promoteRecording("rec-1");

    // NEVER re-mints a scarce coordinate (no claim, no mint).
    expect(state.calls).not.toContain("claim");
    expect(publishMixtape).not.toHaveBeenCalled();
    // No copy-onto-itself, no delete of the live key.
    expect(copyObject).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
    // The setVideoAt flip is still idempotently re-applied.
    expect(updateMixtape).toHaveBeenCalledTimes(1);
  });

  it("reuses the linked mixtape but still copies+repoints when a prior run left the key un-repointed", async () => {
    // Linked + minted, but the recording's key was never repointed (a half-finished run).
    seedRecording({ r2_key: "recordings/rec-1/set.mp4" });
    state.linked = { id: "mix-1", log_id: "020.F.1A" };
    state.joinLogId = "020.F.1A";
    state.joinMixtapeId = "mix-1";

    await promoteRecording("rec-1");

    // No second mint (reuse) …
    expect(state.calls).not.toContain("claim");
    expect(publishMixtape).not.toHaveBeenCalled();
    // … but the copy + repoint + delete-last still complete the promotion.
    expect(copyObject).toHaveBeenCalledWith("recordings/rec-1/set.mp4", "020.F.1A/set.mp4");
    expect(state.calls.indexOf("delete")).toBeGreaterThan(state.calls.indexOf("repoint"));
  });

  it("seeds the mixtape members from the cues' finding_id links (the S4 fix)", async () => {
    seedRecording();
    state.cues = [
      { artists_text: "A", finding_id: "t1", id: "c1", position: 1, start_ms: 0, title_text: "T" },
      // A non-finding cue (played but not canon) is skipped, never guessed.
      {
        artists_text: "B",
        finding_id: null,
        id: "c2",
        position: 2,
        start_ms: 90_000,
        title_text: "U",
      },
      // A repeated finding dedupes (a set can play a track twice).
      {
        artists_text: "A",
        finding_id: "t1",
        id: "c3",
        position: 3,
        start_ms: 180_000,
        title_text: "T",
      },
    ];

    await promoteRecording("rec-1");

    // The claimed draft carries a random id; assert the seeded members, not the id.
    expect(setMixtapeMembers).toHaveBeenCalledWith(expect.any(String), {
      members: [{ ref: "t1", startMs: 0 }],
    });
  });

  it("refuses to mint a recording whose cues resolve to no finding (BEFORE claiming a link)", async () => {
    // No cues at all — the cutover removed the legacy tracklist_json fallback, so a
    // recording with no finding-linked cue resolves to zero members.
    seedRecording();
    state.cues = [];

    await expect(promoteRecording("rec-1")).rejects.toThrow(/no Fluncle finding|resolvable/i);
    // Errors before any coordinate is at risk — no link claimed, no mint.
    expect(state.calls).not.toContain("claim");
    expect(publishMixtape).not.toHaveBeenCalled();
  });

  it("refuses to mint a recording whose only cue is a non-finding (no finding_id)", async () => {
    seedRecording();
    // A played-but-not-canon cue — resolves to no finding, never guessed.
    state.cues = [
      { artists_text: "B", finding_id: null, id: "c1", position: 1, start_ms: 0, title_text: "U" },
    ];

    await expect(promoteRecording("rec-1")).rejects.toThrow(/no Fluncle finding|resolvable/i);
    expect(state.calls).not.toContain("claim");
    expect(publishMixtape).not.toHaveBeenCalled();
  });

  it("recovers a half-claimed draft (linked, no log_id): reuses the row, mints no new coordinate", async () => {
    // A prior run claimed the link but crashed before minting (a draft with no log_id).
    seedRecording();
    state.linked = { id: "mix-1", log_id: null };

    await promoteRecording("rec-1");

    // Reuses the claimed row — no SECOND claim insert — then finishes minting IT.
    expect(state.calls).not.toContain("claim");
    expect(setMixtapeMembers).toHaveBeenCalledWith("mix-1", {
      members: [{ ref: "t1", startMs: 0 }],
    });
    expect(publishMixtape).toHaveBeenCalledTimes(1);
  });

  it("loses the claim race → reuses the winner's row, never mints a second coordinate", async () => {
    // No link yet at the first probe, but the CLAIM insert affects 0 rows: a concurrent
    // promoter won the race between the probe and the insert. `state.linked` is the winner
    // the loser re-reads.
    seedRecording();
    let probed = 0;
    execute.mockImplementation(async (query: { args: unknown[]; sql: string }) => {
      const sql = query.sql;

      if (sql.includes("left join mixtapes")) {
        return {
          rows: [
            {
              ...state.recording,
              mixtape_id: state.joinMixtapeId,
              mixtape_log_id: state.joinLogId,
            },
          ],
        };
      }
      if (sql.includes("from recording_cues")) {
        return { rows: state.cues };
      }
      if (sql.includes("from recordings where id")) {
        return { rows: [state.recording] };
      }
      // The claim insert affects 0 rows (the winner already inserted).
      if (sql.startsWith("insert into mixtapes")) {
        state.calls.push("claim");
        return { rows: [], rowsAffected: 0 };
      }
      // First probe: no link yet. After the lost claim: the winner's row.
      if (sql.includes("from mixtapes where recording_id")) {
        probed += 1;
        return { rows: probed === 1 ? [] : [{ id: "winner-mix" }] };
      }
      if (sql.startsWith("update recordings set r2_key")) {
        state.calls.push("repoint");
        state.recording.r2_key = query.args[0];
        return { rows: [] };
      }

      return { rows: [] };
    });

    await promoteRecording("rec-1");

    // Reused the WINNER's row — the loser seeds + mints that row (publishMixtape's
    // draft-guard means no second coordinate is spent), never its own.
    expect(setMixtapeMembers).toHaveBeenCalledWith("winner-mix", {
      members: [{ ref: "t1", startMs: 0 }],
    });
  });

  it("refuses to promote a PLAN (no set video — r2_key NULL)", async () => {
    seedRecording({ r2_key: null });

    await expect(promoteRecording("rec-1")).rejects.toThrow(/no set video/i);
    expect(state.calls).not.toContain("claim");
    expect(copyObject).not.toHaveBeenCalled();
  });
});
