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
