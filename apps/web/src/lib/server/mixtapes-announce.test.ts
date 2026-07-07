import { beforeEach, describe, expect, it, vi } from "vitest";

// announceMixtape's DB choreography: getMixtapeById (a MIXTAPE_SELECT execute) → the
// atomic claim (`update … set announced_at = ? … where announced_at is null`, whose
// rowsAffected is the single-owner signal) → postMixtapeToTelegram → a getMixtapeById
// readback. A single mutable row backs it; each query is answered by its SQL shape —
// enough to prove the gates, the no-double-post idempotency, and the release-on-failure
// retry path without a real libsql instance or a real Telegram call.

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({ row: {} as Row }));

const execute = vi.hoisted(() =>
  vi.fn(async (query: { args: unknown[]; sql: string }) => {
    // The release update (a Telegram failure rolls the marker back to NULL).
    if (query.sql.includes("announced_at = null")) {
      state.row.announced_at = null;
      return { rowsAffected: 1 };
    }

    // The atomic claim: flips announced_at NULL → now exactly once. rowsAffected is 1
    // only for the call that wins the claim; a re-run (marker already set) gets 0.
    if (query.sql.includes("set announced_at = ?")) {
      if (state.row.announced_at == null) {
        const [announcedAt] = query.args as [string];
        state.row.announced_at = announcedAt;
        return { rowsAffected: 1 };
      }

      return { rowsAffected: 0 };
    }

    // getMixtapeById runs a MIXTAPE_SELECT — return the current row state.
    return { rows: [{ member_count: 3, ...state.row }] };
  }),
);

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

vi.mock("./tracks", () => ({
  getTrackByIdOrLogId: async () => undefined,
  getTracksForMixtape: async () => [],
}));

vi.mock("./edge-cache", () => ({ purgeLogCache: () => undefined }));

const postMixtapeToTelegram = vi.hoisted(() => vi.fn());

vi.mock("./telegram", () => ({
  postMixtapeToTelegram: (...args: unknown[]) => postMixtapeToTelegram(...args),
}));

const { announceMixtape } = await import("./mixtapes");

// A published, minted mixtape with a live listen link — the announceable state.
function seed(overrides: Partial<Row> = {}): void {
  state.row = {
    announced_at: null,
    created_at: "2026-06-19T00:00:00.000Z",
    id: "mix-1",
    log_id: "019.F.3A",
    member_count: 3,
    note: "A late checkpoint, dreamt.",
    status: "published",
    title: "Fluncle Drum & Bass Mixtape #3 | 019.F.3A",
    updated_at: "2026-06-19T00:00:00.000Z",
    youtube_url: "https://youtu.be/vid-1",
    ...overrides,
  };
}

beforeEach(() => {
  execute.mockClear();
  postMixtapeToTelegram.mockReset();
  postMixtapeToTelegram.mockResolvedValue("🛸 Fresh mixtape\n\n…");
});

describe("announceMixtape — post + mark", () => {
  it("posts the callout to the crew, stamps announced_at, and echoes the text", async () => {
    seed();

    const result = await announceMixtape("mix-1");

    expect(postMixtapeToTelegram).toHaveBeenCalledTimes(1);
    expect(result.message).toBe("🛸 Fresh mixtape\n\n…");
    // The marker is set, and the returned DTO carries it (the Studio's done state).
    expect(state.row.announced_at).not.toBeNull();
    expect(result.mixtape.announcedAt).toBe(state.row.announced_at);
  });
});

describe("announceMixtape — idempotency (no double-post)", () => {
  it("409s already_announced on a re-run and never re-posts", async () => {
    seed({ announced_at: "2026-06-19T12:00:00.000Z" });

    await expect(announceMixtape("mix-1")).rejects.toThrow(/already been announced/i);
    expect(postMixtapeToTelegram).not.toHaveBeenCalled();
  });

  it("a second announce after a successful one 409s (the claim rowsAffected guard)", async () => {
    seed();

    await announceMixtape("mix-1");
    expect(postMixtapeToTelegram).toHaveBeenCalledTimes(1);

    await expect(announceMixtape("mix-1")).rejects.toThrow(/already been announced/i);
    // Still exactly one post — the second call lost the claim and never reached Telegram.
    expect(postMixtapeToTelegram).toHaveBeenCalledTimes(1);
  });
});

describe("announceMixtape — lifecycle gates", () => {
  it("409s mixtape_not_minted before a coordinate exists", async () => {
    seed({ log_id: null });

    await expect(announceMixtape("mix-1")).rejects.toThrow(/promote the recording/i);
    expect(postMixtapeToTelegram).not.toHaveBeenCalled();
  });

  it("409s mixtape_not_published while still distributing (no listen link yet)", async () => {
    seed({ status: "distributing" });

    await expect(announceMixtape("mix-1")).rejects.toThrow(/distribute a listen link/i);
    expect(postMixtapeToTelegram).not.toHaveBeenCalled();
  });
});

describe("announceMixtape — Telegram failure releases the claim", () => {
  it("rolls announced_at back to NULL on a send failure, so a retry re-announces", async () => {
    seed();
    postMixtapeToTelegram.mockRejectedValueOnce(new Error("Telegram post failed: 502"));

    await expect(announceMixtape("mix-1")).rejects.toThrow(/Telegram post failed/i);
    // The marker was released — the mixtape is announceable again.
    expect(state.row.announced_at).toBeNull();

    // A retry (Telegram healthy) now succeeds and stamps the marker.
    postMixtapeToTelegram.mockResolvedValueOnce("🛸 Fresh mixtape\n\nretry");
    const result = await announceMixtape("mix-1");

    expect(result.message).toBe("🛸 Fresh mixtape\n\nretry");
    expect(state.row.announced_at).not.toBeNull();
  });
});
