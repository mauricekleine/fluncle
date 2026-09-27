import { type Client } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

let db: Client;
let directory: string;

const lookupSpotifyIdsByMbid = vi.fn();
const fetchTrackMetadata = vi.fn();
const findSpotifyTrackByIsrc = vi.fn();
const searchTrackCandidates = vi.fn();

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./listenbrainz", () => ({
  lookupSpotifyIdsByMbid: (...args: unknown[]) => lookupSpotifyIdsByMbid(...args),
}));

vi.mock("./spotify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spotify")>();
  return {
    ...actual,
    fetchTrackMetadata: (...args: unknown[]) => fetchTrackMetadata(...args),
    findSpotifyTrackByIsrc: (...args: unknown[]) => findSpotifyTrackByIsrc(...args),
    searchTrackCandidates: (...args: unknown[]) => searchTrackCandidates(...args),
  };
});

async function seedTrack(trackId: string, isrc: null | string, mbid = "mbid"): Promise<void> {
  await db.execute({
    args: [trackId, "Weightless", '["Etherwood"]', 261_901, isrc, mbid],
    sql: `insert into tracks (track_id, title, artists_json, duration_ms, isrc, mb_recording_id)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

async function phasedResolve(
  trackId: string,
  deezerCandidates?: {
    artistName: string;
    deezerTrackId?: string;
    durationMs: number;
    isrc: string;
    title: string;
  }[],
) {
  const { commitAnchorFreePhase, prepareAnchorFreePhase, probeAnchorFreePhase } =
    await import("./anchor");
  const prepared = await prepareAnchorFreePhase(trackId, deezerCandidates);
  const evidence = await probeAnchorFreePhase(prepared);
  const { paidReceiptPending: _paidReceiptPending, ...result } = await commitAnchorFreePhase(
    prepared,
    evidence,
  );
  return result;
}

const metadata = {
  albumImageUrl: null,
  artists: ["Etherwood"],
  durationMs: 261_800,
  isrc: "ROWISRC0001",
  spotifyArtistIds: ["artist-1"],
  title: "Weightless",
  trackId: "spotify-1",
};

beforeEach(async () => {
  vi.stubEnv("ADMIN_SESSION_SECRET", "anchor-phase-test-secret");
  vi.stubEnv("FLUNCLE_AGENT_TOKEN", "anchor-phase-agent-token");
  directory = await mkdtemp(join(tmpdir(), "fluncle-anchor-phase-"));
  db = await createIntegrationDb({ url: `file:${join(directory, "anchor.db")}` });
  lookupSpotifyIdsByMbid.mockReset().mockResolvedValue({ outcome: "no-map" });
  fetchTrackMetadata.mockReset().mockResolvedValue(metadata);
  findSpotifyTrackByIsrc.mockReset().mockResolvedValue({ rateLimited: false });
  searchTrackCandidates.mockReset().mockResolvedValue([]);
});

afterEach(async () => {
  vi.useRealTimers();
  db.close();
  await rm(directory, { force: true, recursive: true });
});

describe("anchor phases", () => {
  it("returns the exact receipt coordinate from the single-row prepare route", async () => {
    const { handleOrpc } = await import("./orpc");
    const { readAnchorPreparedCoordinates } = await import("./anchor");
    await seedTrack("single-prepare-receipt", "ROWISRC0001");
    const response = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/prepare", {
        body: JSON.stringify({ trackId: "single-prepare-receipt" }),
        headers: {
          Authorization: "Bearer anchor-phase-agent-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { prepared: string; receiptAt?: string };
    expect(body.receiptAt).toBe((await readAnchorPreparedCoordinates(body.prepared)).receiptAt);
  });

  it("reports this prepare's pending paid receipt after an external anchor lands", async () => {
    const { handleOrpc } = await import("./orpc");
    const { commitAnchorFreePhase, prepareAnchorFreePhase, probeAnchorFreePhase } =
      await import("./anchor");
    await seedTrack("receipt-pending-elsewhere", "ROWISRC0001");
    const prepared = await prepareAnchorFreePhase("receipt-pending-elsewhere");
    const evidence = await probeAnchorFreePhase(prepared);
    expect((await commitAnchorFreePhase(prepared, evidence)).apifyEligible).toBe(true);
    await db.execute({
      args: ["spotify:track:external", "receipt-pending-elsewhere"],
      sql: "update tracks set spotify_uri = ? where track_id = ?",
    });
    const response = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/commit", {
        body: JSON.stringify({ evidence, prepared }),
        headers: {
          Authorization: "Bearer anchor-phase-agent-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      anchored: true,
      paidReceiptPending: true,
    });
  });

  it("stamps paid actor failure backoff and refunds only a proven no-run start once", async () => {
    const { handleOrpc } = await import("./orpc");
    const { getAnchorApifyBudget, setAnchorApifyDailyRows } = await import("./anchor-apify");
    await setAnchorApifyDailyRows(1);
    await seedTrack("cancel-paid-start", "ROWISRC0001");
    await db.execute("update tracks set has_isrc = 1 where track_id = 'cancel-paid-start'");
    const { listTrackWork } = await import("./track-work");
    expect(
      (await listTrackWork({ kind: "anchor", limit: 10 })).map((row) => row.trackId),
    ).toContain("cancel-paid-start");
    const admitted = await phasedResolve("cancel-paid-start");
    expect(admitted.apifyEligible).toBe(true);
    const request = () =>
      new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/paid-result/cancel", {
        body: JSON.stringify({
          paidResultToken: admitted.paidResultToken,
          refundCap: true,
          trackId: "cancel-paid-start",
        }),
        headers: {
          Authorization: "Bearer anchor-phase-agent-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      });
    const first = await handleOrpc(request());
    expect(first?.status).toBe(200);
    expect(await first?.json()).toMatchObject({ ok: true, settled: true });
    const replay = await handleOrpc(request());
    expect(replay?.status).toBe(200);
    expect(await replay?.json()).toMatchObject({ ok: true, settled: true });
    const state = await db.execute({
      args: ["cancel-paid-start"],
      sql: `select spotify_anchor_paid_state as paid_state,
                   spotify_anchor_attempted_at as attempted_at,
                   spotify_anchor_attempts as attempts,
                   spotify_anchor_invalid_attempts as invalid_attempts
            from tracks where track_id = ?`,
    });
    expect(state.rows[0]).toMatchObject({
      attempts: 1,
      invalid_attempts: 0,
      paid_state: "settled",
    });
    expect(state.rows[0]?.attempted_at).toBeTypeOf("string");
    expect((await getAnchorApifyBudget()).rowsSent).toBe(0);
    await seedTrack("after-no-run-refund", "ROWISRC0002");
    expect((await phasedResolve("after-no-run-refund")).apifyEligible).toBe(true);
    expect(
      (await listTrackWork({ kind: "anchor", limit: 10 })).map((row) => row.trackId),
    ).not.toContain("cancel-paid-start");
  });

  it("refunds the authorization day when prepare and charge cross midnight", async () => {
    const {
      cancelAnchorPaidResult,
      commitAnchorFreePhase,
      prepareAnchorFreePhase,
      probeAnchorFreePhase,
    } = await import("./anchor");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    vi.useFakeTimers().setSystemTime(new Date("2026-07-22T23:59:50.000Z"));
    await seedTrack("cross-day-no-run", "ROWISRC0001");
    const prepared = await prepareAnchorFreePhase("cross-day-no-run");
    const evidence = await probeAnchorFreePhase(prepared);
    vi.setSystemTime(new Date("2026-07-23T00:00:10.000Z"));
    const verdict = await commitAnchorFreePhase(prepared, evidence);
    expect(verdict.paidResultToken).toBeTypeOf("string");
    if (!verdict.paidResultToken) {
      throw new Error("missing paid result token");
    }
    expect((await getAnchorApifyBudget()).rowsSent).toBe(1);
    await cancelAnchorPaidResult("cross-day-no-run", verdict.paidResultToken, true);
    expect((await getAnchorApifyBudget()).rowsSent).toBe(0);
  });

  it("limits proven no-run refunds to ten cap slots per authorization day", async () => {
    const { cancelAnchorPaidResult } = await import("./anchor");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    for (let index = 0; index < 11; index += 1) {
      const trackId = `refund-ceiling-${index}`;
      await seedTrack(trackId, `ROWISRC${String(index).padStart(4, "0")}`);
      const admitted = await phasedResolve(trackId);
      expect(admitted.apifyEligible).toBe(true);
      if (!admitted.paidResultToken) {
        throw new Error("missing paid result token");
      }
      await cancelAnchorPaidResult(trackId, admitted.paidResultToken, true);
    }
    expect((await getAnchorApifyBudget()).rowsSent).toBe(1);
    const refund = await db.execute({
      args: ["anchor_apify_refunds", "catalogue"],
      sql: "select count from rate_limit_counters where action = ? and bucket = ?",
    });
    expect(Number(refund.rows[0]?.count)).toBe(10);
    const settled = await db.execute(
      "select count(*) as n from tracks where track_id like 'refund-ceiling-%' and spotify_anchor_paid_state = 'settled' and spotify_anchor_attempts = 1",
    );
    expect(Number(settled.rows[0]?.n)).toBe(11);
  });

  it("stamps a failed paid run without refunding its cap slot", async () => {
    const { handleOrpc } = await import("./orpc");
    const { getAnchorApifyBudget, setAnchorApifyDailyRows } = await import("./anchor-apify");
    await setAnchorApifyDailyRows(1);
    await seedTrack("cancel-paid-run", "ROWISRC0001");
    await db.execute("update tracks set has_isrc = 1 where track_id = 'cancel-paid-run'");
    const { listTrackWork } = await import("./track-work");
    expect(
      (await listTrackWork({ kind: "anchor", limit: 10 })).map((row) => row.trackId),
    ).toContain("cancel-paid-run");
    const admitted = await phasedResolve("cancel-paid-run");
    const response = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/paid-result/cancel", {
        body: JSON.stringify({
          paidResultToken: admitted.paidResultToken,
          trackId: "cancel-paid-run",
        }),
        headers: {
          Authorization: "Bearer anchor-phase-agent-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(response?.status).toBe(200);
    const row = await db.execute({
      args: ["cancel-paid-run"],
      sql: `select spotify_anchor_attempted_at as attempted_at,
                   spotify_anchor_attempts as attempts from tracks where track_id = ?`,
    });
    expect(row.rows[0]?.attempted_at).toBeTypeOf("string");
    expect(Number(row.rows[0]?.attempts)).toBe(1);
    expect((await getAnchorApifyBudget()).rowsSent).toBe(1);
    await seedTrack("after-failed-run", "ROWISRC0002");
    expect((await phasedResolve("after-failed-run")).apifyIneligibleReason).toBe(
      "apify_budget_spent",
    );
    expect(
      (await listTrackWork({ kind: "anchor", limit: 10 })).map((item) => item.trackId),
    ).not.toContain("cancel-paid-run");
  });

  it("keeps a terminal invalid-report strike at the attempt cap on cancellation", async () => {
    const { cancelAnchorPaidResult, recordAnchorValidationFailure } = await import("./anchor");
    await seedTrack("terminal-invalid-paid", "ROWISRC0001");
    const admitted = await phasedResolve("terminal-invalid-paid");
    if (!admitted.paidResultToken) {
      throw new Error("missing paid result token");
    }
    for (let strike = 0; strike < 3; strike += 1) {
      await recordAnchorValidationFailure("terminal-invalid-paid", 400);
    }
    await cancelAnchorPaidResult("terminal-invalid-paid", admitted.paidResultToken);
    const row = await db.execute({
      args: ["terminal-invalid-paid"],
      sql: "select spotify_anchor_attempts as attempts from tracks where track_id = ?",
    });
    expect(Number(row.rows[0]?.attempts)).toBe(6);
  });

  it("cannot cancel another track's receipt, a replaced receipt, or an expired token", async () => {
    const { handleOrpc } = await import("./orpc");
    const started = new Date("2026-07-22T12:00:00.000Z");
    vi.useFakeTimers().setSystemTime(started);
    await seedTrack("cancel-token-owner", "ROWISRC0001");
    await seedTrack("cancel-token-other", "ROWISRC0002");
    const admitted = await phasedResolve("cancel-token-owner");
    const request = (trackId: string) =>
      new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/paid-result/cancel", {
        body: JSON.stringify({ paidResultToken: admitted.paidResultToken, trackId }),
        headers: {
          Authorization: "Bearer anchor-phase-agent-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      });
    expect((await handleOrpc(request("cancel-token-other")))?.status).toBe(409);
    const original = await db.execute({
      args: ["cancel-token-owner"],
      sql: "select spotify_anchor_paid_admitted_at as receipt from tracks where track_id = ?",
    });
    const receipt = original.rows[0]?.receipt;
    expect(receipt).toBeTypeOf("string");
    if (typeof receipt !== "string") {
      throw new Error("missing paid receipt");
    }
    await db.execute({
      args: ["2026-07-22T12:00:00.000999999Z", "cancel-token-owner"],
      sql: "update tracks set spotify_anchor_paid_admitted_at = ? where track_id = ?",
    });
    expect((await handleOrpc(request("cancel-token-owner")))?.status).toBe(409);
    await db.execute({
      args: [receipt, "cancel-token-owner"],
      sql: "update tracks set spotify_anchor_paid_admitted_at = ? where track_id = ?",
    });
    vi.setSystemTime(new Date(started.getTime() + 25 * 60 * 60 * 1000));
    expect((await handleOrpc(request("cancel-token-owner")))?.status).toBe(409);
    const rows = await db.execute({
      args: ["cancel-token-owner", "cancel-token-other"],
      sql: `select track_id as track_id, spotify_anchor_paid_state as paid_state
            from tracks where track_id in (?, ?) order by track_id`,
    });
    expect(rows.rows.map((row) => [row.track_id, row.paid_state])).toEqual([
      ["cancel-token-other", null],
      ["cancel-token-owner", "pending"],
    ]);
  });

  it("reissues a paid result token for an exact pending receipt after the old token expires", async () => {
    const { handleOrpc } = await import("./orpc");
    const { anchorTrack } = await import("./anchor");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    const started = new Date("2026-07-22T12:00:00.000Z");
    vi.useFakeTimers().setSystemTime(started);
    await seedTrack("refresh-paid-token", "ROWISRC0001");
    const admitted = await phasedResolve("refresh-paid-token");
    const receipt = await db.execute({
      args: ["refresh-paid-token"],
      sql: "select spotify_anchor_paid_admitted_at as receipt from tracks where track_id = ?",
    });
    vi.setSystemTime(new Date(started.getTime() + 25 * 60 * 60 * 1000));
    await expect(
      anchorTrack("refresh-paid-token", [], { paidResultToken: admitted.paidResultToken }),
    ).rejects.toThrow("invalid or expired anchor phase token");
    const response = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/paid-result/token", {
        body: JSON.stringify({
          receiptAt: receipt.rows[0]?.receipt,
          trackId: "refresh-paid-token",
        }),
        headers: {
          Authorization: "Bearer anchor-phase-agent-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { paidResultToken: string };
    expect(body.paidResultToken).toBeTypeOf("string");
    expect(
      await anchorTrack("refresh-paid-token", [], { paidResultToken: body.paidResultToken }),
    ).toEqual({
      anchored: false,
      verifiedBy: null,
    });
    expect((await getAnchorApifyBudget(started)).rowsSent).toBe(1);
  });

  it("refuses a paid token read for a different, anchored, or settled receipt", async () => {
    const { handleOrpc } = await import("./orpc");
    const { anchorTrack } = await import("./anchor");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    await seedTrack("refresh-refused", "ROWISRC0001");
    const admitted = await phasedResolve("refresh-refused");
    const receipt = await db.execute({
      args: ["refresh-refused"],
      sql: "select spotify_anchor_paid_admitted_at as receipt from tracks where track_id = ?",
    });
    const receiptAt = receipt.rows[0]?.receipt;
    expect(receiptAt).toBeTypeOf("string");
    if (typeof receiptAt !== "string") {
      throw new Error("missing paid receipt");
    }
    const request = (candidateReceipt: string) =>
      new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/paid-result/token", {
        body: JSON.stringify({ receiptAt: candidateReceipt, trackId: "refresh-refused" }),
        headers: {
          Authorization: "Bearer anchor-phase-agent-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      });
    expect((await handleOrpc(request("different-receipt")))?.status).toBe(409);
    await db.execute({
      args: ["spotify:track:already", "refresh-refused"],
      sql: "update tracks set spotify_uri = ? where track_id = ?",
    });
    expect((await handleOrpc(request(receiptAt)))?.status).toBe(409);
    await db.execute({
      args: ["refresh-refused"],
      sql: "update tracks set spotify_uri = null where track_id = ?",
    });
    await anchorTrack("refresh-refused", [], { paidResultToken: admitted.paidResultToken });
    expect((await handleOrpc(request(receiptAt)))?.status).toBe(409);
    expect((await getAnchorApifyBudget()).rowsSent).toBe(1);
  });

  it("settles an exact pending receipt when the track was anchored elsewhere", async () => {
    const { handleOrpc } = await import("./orpc");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    await seedTrack("paid-anchored-elsewhere", "ROWISRC0001");
    expect((await phasedResolve("paid-anchored-elsewhere")).apifyEligible).toBe(true);
    const receipt = await db.execute({
      args: ["paid-anchored-elsewhere"],
      sql: "select spotify_anchor_paid_admitted_at as receipt from tracks where track_id = ?",
    });
    await db.execute({
      args: ["spotify:track:another-source", "paid-anchored-elsewhere"],
      sql: "update tracks set spotify_uri = ? where track_id = ?",
    });
    const request = () =>
      new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/paid-result/resolve", {
        body: JSON.stringify({
          receiptAt: receipt.rows[0]?.receipt,
          trackId: "paid-anchored-elsewhere",
        }),
        headers: {
          Authorization: "Bearer anchor-phase-agent-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      });
    const first = await handleOrpc(request());
    expect(first?.status).toBe(200);
    expect(await first?.json()).toMatchObject({ ok: true, reason: "unavailable" });
    const replay = await handleOrpc(request());
    expect(replay?.status).toBe(200);
    expect(await replay?.json()).toMatchObject({ ok: true, reason: "settled" });
    const state = await db.execute({
      args: ["paid-anchored-elsewhere"],
      sql: `select spotify_uri as uri, spotify_anchor_paid_state as paid_state,
                   spotify_anchor_invalid_attempts as invalid_attempts
            from tracks where track_id = ?`,
    });
    expect(state.rows[0]).toMatchObject({
      invalid_attempts: 0,
      paid_state: "settled",
      uri: "spotify:track:another-source",
    });
    expect((await getAnchorApifyBudget()).rowsSent).toBe(1);
  });

  it("resolves a certified or deleted paid track, but refuses an active or mismatched receipt", async () => {
    const { handleOrpc } = await import("./orpc");
    const request = (trackId: string, receiptAt: unknown) =>
      new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/paid-result/resolve", {
        body: JSON.stringify({ receiptAt, trackId }),
        headers: {
          Authorization: "Bearer anchor-phase-agent-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      });
    await seedTrack("paid-certified-later", "ROWISRC0001");
    await seedTrack("paid-deleted-later", "ROWISRC0002");
    await seedTrack("paid-still-active", "ROWISRC0003");
    await phasedResolve("paid-certified-later");
    await phasedResolve("paid-deleted-later");
    await phasedResolve("paid-still-active");
    const receipts = await db.execute({
      args: ["paid-certified-later", "paid-deleted-later", "paid-still-active"],
      sql: `select track_id as track_id, spotify_anchor_paid_admitted_at as receipt
            from tracks where track_id in (?, ?, ?)`,
    });
    const receiptByTrack = new Map(receipts.rows.map((row) => [row.track_id, row.receipt]));
    await db.execute({
      args: ["paid-certified-later", "2026-07-22T12:00:00.000Z"],
      sql: "insert into findings (track_id, added_at) values (?, ?)",
    });
    await db.execute({
      args: ["paid-deleted-later"],
      sql: "delete from tracks where track_id = ?",
    });
    const certified = await handleOrpc(
      request("paid-certified-later", receiptByTrack.get("paid-certified-later")),
    );
    expect(certified?.status).toBe(200);
    expect(await certified?.json()).toMatchObject({ reason: "unavailable" });
    const missing = await handleOrpc(
      request("paid-deleted-later", receiptByTrack.get("paid-deleted-later")),
    );
    expect(missing?.status).toBe(200);
    expect(await missing?.json()).toMatchObject({ reason: "missing" });
    expect(
      (await handleOrpc(request("paid-still-active", receiptByTrack.get("paid-still-active"))))
        ?.status,
    ).toBe(409);
    expect((await handleOrpc(request("paid-still-active", "different-receipt")))?.status).toBe(409);
    const states = await db.execute({
      args: ["paid-certified-later", "paid-still-active"],
      sql: `select track_id as track_id, spotify_anchor_paid_state as paid_state
            from tracks where track_id in (?, ?) order by track_id`,
    });
    expect(states.rows.map((row) => [row.track_id, row.paid_state])).toEqual([
      ["paid-certified-later", "settled"],
      ["paid-still-active", "pending"],
    ]);
  });

  it("keeps the legacy resolve route free-only while Apify is enabled", async () => {
    const { handleOrpc } = await import("./orpc");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    await seedTrack("legacy-free-route", "ROWISRC0001");
    const response = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/resolve", {
        body: JSON.stringify({ trackId: "legacy-free-route" }),
        headers: {
          Authorization: "Bearer anchor-phase-agent-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ apifyEligible: false, ok: true });
    expect((await getAnchorApifyBudget()).rowsSent).toBe(0);
    expect(
      (
        await db.execute({
          args: ["legacy-free-route"],
          sql: "select spotify_anchor_paid_admitted_at as receipt from tracks where track_id = ?",
        })
      ).rows[0]?.receipt,
    ).toBeNull();
  });

  it("commits free evidence without paid admission when the caller blocks paid work", async () => {
    const { commitAnchorFreePhase, prepareAnchorFreePhase, probeAnchorFreePhase } =
      await import("./anchor");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    await seedTrack("free-only-commit", "ROWISRC0001");
    const prepared = await prepareAnchorFreePhase("free-only-commit");
    const evidence = await probeAnchorFreePhase(prepared);
    const result = await commitAnchorFreePhase(prepared, evidence, false);
    expect(result.apifyEligible).toBe(false);
    expect(result.paidReceiptPending).toBe(false);
    expect(result.paidResultToken).toBeUndefined();
    expect((await getAnchorApifyBudget()).rowsSent).toBe(0);
    expect(
      (
        await db.execute({
          args: ["free-only-commit"],
          sql: "select spotify_anchor_paid_state as paid_state from tracks where track_id = ?",
        })
      ).rows[0]?.paid_state,
    ).toBeNull();
  });

  it("returns 409 for commit row drift before any paid charge or receipt", async () => {
    const { prepareAnchorFreePhase, probeAnchorFreePhase } = await import("./anchor");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    const { handleOrpc } = await import("./orpc");
    await seedTrack("commit-drift-route", "ROWISRC0001");
    const prepared = await prepareAnchorFreePhase("commit-drift-route");
    const evidence = await probeAnchorFreePhase(prepared);
    await db.execute({
      args: ["Edited after prepare", "commit-drift-route"],
      sql: "update tracks set title = ? where track_id = ?",
    });
    const response = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/commit", {
        body: JSON.stringify({ evidence, prepared }),
        headers: {
          Authorization: "Bearer anchor-phase-agent-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(response?.status).toBe(409);
    expect((await getAnchorApifyBudget()).rowsSent).toBe(0);
    expect(
      (
        await db.execute({
          args: ["commit-drift-route"],
          sql: "select spotify_anchor_paid_admitted_at as receipt from tracks where track_id = ?",
        })
      ).rows[0]?.receipt,
    ).toBeNull();
  });

  it("matches the existing ListenBrainz hit verdict", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    lookupSpotifyIdsByMbid.mockResolvedValue({
      match: { recordingMbid: "mbid", spotifyTrackIds: ["spotify-1"] },
      outcome: "match",
    });
    await seedTrack("old-lb", "ROWISRC0001");
    await seedTrack("new-lb", "ROWISRC0001");
    const old = await resolveAnchorFree("old-lb");
    const phased = await phasedResolve("new-lb");
    expect(phased).toEqual(old);
  });

  it("finishes artist links when the anchor row was written before commit response was lost", async () => {
    const { commitAnchorFreePhase, prepareAnchorFreePhase, probeAnchorFreePhase } =
      await import("./anchor");
    lookupSpotifyIdsByMbid.mockResolvedValue({
      match: { recordingMbid: "mbid", spotifyTrackIds: ["spotify-1"] },
      outcome: "match",
    });
    await seedTrack("partial-hit", "ROWISRC0001");
    const prepared = await prepareAnchorFreePhase("partial-hit");
    const evidence = await probeAnchorFreePhase(prepared);
    await db.execute({
      args: ["spotify:track:spotify-1", "listenbrainz", "isrc", "partial-hit"],
      sql: `update tracks set spotify_uri = ?, spotify_anchor_source = ?,
             spotify_anchor_verified_by = ? where track_id = ?`,
    });
    expect(
      (
        await db.execute({
          args: ["partial-hit"],
          sql: "select count(*) as count from track_artists where track_id = ?",
        })
      ).rows[0]?.count,
    ).toBe(0);
    const replay = await commitAnchorFreePhase(prepared, evidence);
    expect(replay.anchored).toBe(true);
    expect(
      (
        await db.execute({
          args: ["partial-hit"],
          sql: "select count(*) as count from track_artists where track_id = ?",
        })
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("charges one paid admission and replays an ambiguous commit response without a second charge", async () => {
    const { commitAnchorFreePhase, prepareAnchorFreePhase, probeAnchorFreePhase } =
      await import("./anchor");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    await seedTrack("paid-replay", "ROWISRC0001");
    const prepared = await prepareAnchorFreePhase("paid-replay");
    const evidence = await probeAnchorFreePhase(prepared);
    const first = await commitAnchorFreePhase(prepared, evidence);
    const receipt = await db.execute({
      args: ["paid-replay"],
      sql: "select spotify_anchor_paid_admitted_at as receipt from tracks where track_id = ?",
    });
    const replay = await commitAnchorFreePhase(prepared, evidence);
    const after = await db.execute({
      args: ["paid-replay"],
      sql: "select spotify_anchor_paid_admitted_at as receipt from tracks where track_id = ?",
    });
    expect(first.apifyEligible).toBe(true);
    expect(first.paidReceiptPending).toBe(true);
    expect(replay.apifyEligible).toBe(true);
    expect(replay.paidReceiptPending).toBe(true);
    expect(replay).toEqual(first);
    expect(after.rows[0]?.receipt).toBe(receipt.rows[0]?.receipt);
    expect((await getAnchorApifyBudget()).rowsSent).toBe(1);
    const secondPrepared = await prepareAnchorFreePhase("paid-replay");
    const secondEvidence = await probeAnchorFreePhase(secondPrepared);
    const nextTick = await commitAnchorFreePhase(secondPrepared, secondEvidence);
    expect(nextTick.apifyEligible).toBe(false);
    expect(nextTick.paidReceiptPending).toBe(false);
    expect(nextTick.apifyIneligibleReason).toBe("awaiting_paid_result");
    expect((await getAnchorApifyBudget()).rowsSent).toBe(1);
  });

  it("recognizes an admitted receipt before rejecting later row drift on commit replay", async () => {
    const { commitAnchorFreePhase, prepareAnchorFreePhase, probeAnchorFreePhase } =
      await import("./anchor");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    await seedTrack("paid-drift-replay", "ROWISRC0001");
    const prepared = await prepareAnchorFreePhase("paid-drift-replay");
    const evidence = await probeAnchorFreePhase(prepared);
    const first = await commitAnchorFreePhase(prepared, evidence);
    await db.execute({
      args: ["Edited after paid admission", "paid-drift-replay"],
      sql: "update tracks set title = ? where track_id = ?",
    });
    const replay = await commitAnchorFreePhase(prepared, evidence);
    expect(first.apifyEligible).toBe(true);
    expect(replay.apifyEligible).toBe(true);
    expect((await getAnchorApifyBudget()).rowsSent).toBe(1);
  });

  it("reports the exact receipt as no longer pending after its paid result settles", async () => {
    const { anchorTrack, commitAnchorFreePhase, prepareAnchorFreePhase, probeAnchorFreePhase } =
      await import("./anchor");
    await seedTrack("settled-receipt-flag", "ROWISRC0001");
    const prepared = await prepareAnchorFreePhase("settled-receipt-flag");
    const evidence = await probeAnchorFreePhase(prepared);
    const admitted = await commitAnchorFreePhase(prepared, evidence);
    expect(admitted.paidReceiptPending).toBe(true);
    await anchorTrack("settled-receipt-flag", [], { paidResultToken: admitted.paidResultToken });
    const replay = await commitAnchorFreePhase(prepared, evidence);
    expect(replay.paidReceiptPending).toBe(false);
  });

  it("returns the existing paid result token when a blocked checkpoint replays with paid disabled", async () => {
    const { commitAnchorFreePhase, prepareAnchorFreePhase, probeAnchorFreePhase } =
      await import("./anchor");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    await seedTrack("paid-disabled-replay", "ROWISRC0001");
    const prepared = await prepareAnchorFreePhase("paid-disabled-replay");
    const evidence = await probeAnchorFreePhase(prepared);
    const first = await commitAnchorFreePhase(prepared, evidence);
    const replay = await commitAnchorFreePhase(prepared, evidence, false);
    expect(first.apifyEligible).toBe(true);
    expect(replay.apifyEligible).toBe(true);
    expect(replay.paidResultToken).toBe(first.paidResultToken);
    expect((await getAnchorApifyBudget()).rowsSent).toBe(1);
  });

  it("returns a charged replay token after Apify is disabled without minting one for a fresh row", async () => {
    const { commitAnchorFreePhase, prepareAnchorFreePhase, probeAnchorFreePhase } =
      await import("./anchor");
    const { getAnchorApifyBudget, setAnchorApifyEnabled } = await import("./anchor-apify");
    await seedTrack("paid-off-replay", "ROWISRC0001");
    const prepared = await prepareAnchorFreePhase("paid-off-replay");
    const evidence = await probeAnchorFreePhase(prepared);
    const first = await commitAnchorFreePhase(prepared, evidence);
    expect(first.paidResultToken).toBeTypeOf("string");
    await setAnchorApifyEnabled(false);
    const replay = await commitAnchorFreePhase(prepared, evidence, false);
    expect(replay.apifyEnabled).toBe(false);
    expect(replay.apifyEligible).toBe(true);
    expect(replay.paidResultToken).toBe(first.paidResultToken);
    await seedTrack("fresh-off-row", "ROWISRC0002");
    const freshPrepared = await prepareAnchorFreePhase("fresh-off-row");
    const freshEvidence = await probeAnchorFreePhase(freshPrepared);
    const fresh = await commitAnchorFreePhase(freshPrepared, freshEvidence);
    expect(fresh.apifyEnabled).toBe(false);
    expect(fresh.paidResultToken).toBeUndefined();
    expect((await getAnchorApifyBudget()).rowsSent).toBe(1);
  });

  it("prepares and commits two rows with individual receipts and verdicts", async () => {
    const { handleOrpc } = await import("./orpc");
    await seedTrack("batch-one", "ROWISRC0001");
    await seedTrack("batch-two", "ROWISRC0002");
    const headers = {
      Authorization: "Bearer anchor-phase-agent-token",
      "Content-Type": "application/json",
    };
    const prepareResponse = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/prepares", {
        body: JSON.stringify({ items: [{ trackId: "batch-one" }, { trackId: "batch-two" }] }),
        headers,
        method: "POST",
      }),
    );
    expect(prepareResponse?.status).toBe(200);
    const prepared = (await prepareResponse?.json()) as {
      items: { prepared: string; receiptAt: string; status: string; trackId: string }[];
    };
    expect(prepared.items.map((item) => item.status)).toEqual(["done", "done"]);
    expect(new Set(prepared.items.map((item) => item.receiptAt)).size).toBe(2);
    const { probeAnchorFreePhase } = await import("./anchor");
    const items = await Promise.all(
      prepared.items.map(async (item) => ({
        evidence: await probeAnchorFreePhase(item.prepared),
        prepared: item.prepared,
        trackId: item.trackId,
      })),
    );
    const commitResponse = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/commits", {
        body: JSON.stringify({ items }),
        headers,
        method: "POST",
      }),
    );
    expect(commitResponse?.status).toBe(200);
    const committed = (await commitResponse?.json()) as {
      items: {
        apifyEligible: boolean;
        paidReceiptPending: boolean;
        status: string;
        trackId: string;
      }[];
    };
    expect(
      committed.items.map((item) => [
        item.trackId,
        item.status,
        item.apifyEligible,
        item.paidReceiptPending,
      ]),
    ).toEqual([
      ["batch-one", "done", true, true],
      ["batch-two", "done", true, true],
    ]);
  });

  it("reads whether an exact expired receipt was paid", async () => {
    const { handleOrpc } = await import("./orpc");
    const started = new Date("2026-07-22T12:00:00.000Z");
    vi.useFakeTimers().setSystemTime(started);
    await seedTrack("receipt-status", "ROWISRC0001");
    const admitted = await phasedResolve("receipt-status");
    expect(admitted.apifyEligible).toBe(true);
    const receipt = await db.execute({
      args: ["receipt-status"],
      sql: "select spotify_anchor_paid_admitted_at as receipt from tracks where track_id = ?",
    });
    vi.setSystemTime(new Date(started.getTime() + 25 * 60 * 60 * 1000));
    const response = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/receipt", {
        body: JSON.stringify({
          receiptAt: receipt.rows[0]?.receipt,
          trackId: "receipt-status",
        }),
        headers: {
          Authorization: "Bearer anchor-phase-agent-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ admitted: true, paidState: "pending" });
    const unmatched = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/receipt", {
        body: JSON.stringify({
          receiptAt: "2026-07-22T12:00:00.000000000Z",
          trackId: "receipt-status",
        }),
        headers: {
          Authorization: "Bearer anchor-phase-agent-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(unmatched?.status).toBe(200);
    expect(await unmatched?.json()).toMatchObject({ admitted: false, paidState: null });
  });

  it("returns a verdict for every batch item when one commit fails", async () => {
    const { handleOrpc } = await import("./orpc");
    const { prepareAnchorFreePhase, probeAnchorFreePhase } = await import("./anchor");
    await seedTrack("batch-valid", "ROWISRC0001");
    const prepared = await prepareAnchorFreePhase("batch-valid");
    const evidence = await probeAnchorFreePhase(prepared);
    const response = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/commits", {
        body: JSON.stringify({
          items: [
            { evidence, prepared: "invalid", trackId: "batch-invalid" },
            { evidence, prepared, trackId: "batch-valid" },
          ],
        }),
        headers: {
          Authorization: "Bearer anchor-phase-agent-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      items: { apifyEligible?: boolean; status: string; trackId: string }[];
    };
    expect(body.items.map((item) => [item.trackId, item.status])).toEqual([
      ["batch-invalid", "error"],
      ["batch-valid", "done"],
    ]);
    expect(body.items[1]?.apifyEligible).toBe(true);
  });

  it("marks an unpaid drift rejection as a per-item 409", async () => {
    const { handleOrpc } = await import("./orpc");
    const { prepareAnchorFreePhase, probeAnchorFreePhase } = await import("./anchor");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    await seedTrack("batch-drift", "ROWISRC0001");
    const prepared = await prepareAnchorFreePhase("batch-drift");
    const evidence = await probeAnchorFreePhase(prepared);
    await db.execute({
      args: ["Edited before admission", "batch-drift"],
      sql: "update tracks set title = ? where track_id = ?",
    });
    const response = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/commits", {
        body: JSON.stringify({ items: [{ evidence, prepared, trackId: "batch-drift" }] }),
        headers: {
          Authorization: "Bearer anchor-phase-agent-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      items: [{ httpStatus: 409, status: "error", trackId: "batch-drift" }],
    });
    expect((await getAnchorApifyBudget()).rowsSent).toBe(0);
  });

  it("returns an explicit deferred verdict for the batch tail after its wall budget", async () => {
    const { handleOrpc } = await import("./orpc");
    await seedTrack("batch-head", "ROWISRC0001");
    await seedTrack("batch-tail", "ROWISRC0002");
    let tick = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => {
      tick += 21_000;
      return tick;
    });
    try {
      const response = await handleOrpc(
        new Request("https://www.fluncle.com/api/v1/admin/catalogue/anchor/prepares", {
          body: JSON.stringify({ items: [{ trackId: "batch-head" }, { trackId: "batch-tail" }] }),
          headers: {
            Authorization: "Bearer anchor-phase-agent-token",
            "Content-Type": "application/json",
          },
          method: "POST",
        }),
      );
      expect(response?.status).toBe(200);
      const body = (await response?.json()) as { items: { status: string; trackId: string }[] };
      expect(body.items.map((item) => [item.trackId, item.status])).toEqual([
        ["batch-head", "done"],
        ["batch-tail", "deferred"],
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps the legacy resolver from replacing a live phased admission receipt", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    await seedTrack("mixed-resolvers", "ROWISRC0001");
    const phased = await phasedResolve("mixed-resolvers");
    expect(phased.apifyEligible).toBe(true);
    const before = await db.execute({
      args: ["mixed-resolvers"],
      sql: "select spotify_anchor_paid_admitted_at as receipt from tracks where track_id = ?",
    });
    const legacy = await resolveAnchorFree("mixed-resolvers");
    const after = await db.execute({
      args: ["mixed-resolvers"],
      sql: "select spotify_anchor_paid_admitted_at as receipt from tracks where track_id = ?",
    });
    expect(legacy.apifyEligible).toBe(false);
    expect(legacy.apifyIneligibleReason).toBe("awaiting_paid_result");
    expect(after.rows[0]?.receipt).toBe(before.rows[0]?.receipt);
    expect((await getAnchorApifyBudget()).rowsSent).toBe(1);
  });

  it("settles a paid actor result after the two-hour receipt window with its signed report token", async () => {
    const { anchorTrack, resolveAnchorFree } = await import("./anchor");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    const started = new Date("2026-07-22T12:00:00.000Z");
    vi.useFakeTimers().setSystemTime(started);
    await seedTrack("late-paid", "ROWISRC0001");
    const admitted = await phasedResolve("late-paid");
    expect(admitted.apifyEligible).toBe(true);
    expect(admitted.paidResultToken).toBeTypeOf("string");
    vi.setSystemTime(new Date(started.getTime() + 3 * 60 * 60 * 1000));
    const legacy = await resolveAnchorFree("late-paid");
    expect(legacy.apifyIneligibleReason).toBe("awaiting_paid_result");
    expect((await getAnchorApifyBudget()).rowsSent).toBe(1);
    const result = await anchorTrack(
      "late-paid",
      [
        {
          artists: [{ name: "Etherwood" }],
          durationMs: 261_800,
          isrc: "ROWISRC0001",
          spotifyTrackId: "late-paid-spotify",
          title: "Weightless",
        },
      ],
      { paidResultToken: admitted.paidResultToken },
    );
    expect(result.anchored).toBe(true);
  });

  it("replays a paid hit after an ambiguous report response and restores its artist link", async () => {
    const { anchorTrack } = await import("./anchor");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    await seedTrack("paid-hit-replay", "ROWISRC0001");
    const admitted = await phasedResolve("paid-hit-replay");
    const candidates = [
      {
        artists: [{ name: "Etherwood" }],
        durationMs: 261_800,
        isrc: "ROWISRC0001",
        spotifyTrackId: "paid-hit-spotify",
        title: "Weightless",
      },
    ];
    const first = await anchorTrack("paid-hit-replay", candidates, {
      paidResultToken: admitted.paidResultToken,
    });
    await db.execute({
      args: ["paid-hit-replay"],
      sql: "delete from track_artists where track_id = ?",
    });
    const replay = await anchorTrack("paid-hit-replay", candidates, {
      paidResultToken: admitted.paidResultToken,
    });
    expect(replay).toEqual(first);
    expect(
      (
        await db.execute({
          args: ["paid-hit-replay"],
          sql: "select count(*) as count from track_artists where track_id = ?",
        })
      ).rows[0]?.count,
    ).toBe(1);
    expect((await getAnchorApifyBudget()).rowsSent).toBe(1);
  });

  it("replays a paid miss without another charge and permits a later settled retry", async () => {
    const { anchorTrack, resolveAnchorFree } = await import("./anchor");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    const started = new Date("2026-07-22T12:00:00.000Z");
    vi.useFakeTimers().setSystemTime(started);
    await seedTrack("paid-miss-replay", "ROWISRC0001");
    const admitted = await phasedResolve("paid-miss-replay");
    await db.execute({
      args: [new Date(started.getTime() + 1000).toISOString(), "paid-miss-replay"],
      sql: "update tracks set spotify_anchor_attempted_at = ? where track_id = ?",
    });
    expect((await resolveAnchorFree("paid-miss-replay")).apifyIneligibleReason).toBe(
      "awaiting_paid_result",
    );
    const first = await anchorTrack("paid-miss-replay", [], {
      paidResultToken: admitted.paidResultToken,
    });
    const replay = await anchorTrack("paid-miss-replay", [], {
      paidResultToken: admitted.paidResultToken,
    });
    expect(replay).toEqual(first);
    expect(replay.anchored).toBe(false);
    expect((await getAnchorApifyBudget()).rowsSent).toBe(1);
    vi.setSystemTime(new Date(started.getTime() + 14 * 24 * 60 * 60 * 1000));
    const retry = await phasedResolve("paid-miss-replay");
    expect(retry.apifyEligible).toBe(true);
  });

  it("protects live legacy receipts and releases them after their original two-hour window", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    const started = new Date("2026-07-22T12:00:00.000Z");
    vi.useFakeTimers().setSystemTime(started);
    await seedTrack("legacy-receipt", "ROWISRC0001");
    await db.execute({
      args: [new Date(started.getTime() - 60 * 60 * 1000).toISOString(), "legacy-receipt"],
      sql: `update tracks set spotify_anchor_paid_admitted_at = ?,
             spotify_anchor_paid_state = null where track_id = ?`,
    });
    const live = await resolveAnchorFree("legacy-receipt");
    expect(live.apifyIneligibleReason).toBe("awaiting_paid_result");
    expect((await getAnchorApifyBudget()).rowsSent).toBe(0);
    vi.setSystemTime(new Date(started.getTime() + 2 * 60 * 60 * 1000));
    const expired = await phasedResolve("legacy-receipt");
    expect(expired.apifyEligible).toBe(true);
    expect((await getAnchorApifyBudget()).rowsSent).toBe(1);
  });

  it("reconciles a named pending paid row without refunding spend and requeues an ISRC-free row", async () => {
    const { clearPendingAnchorPaidReceipts } = await import("./anchor");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    await seedTrack("paid-operator-requeue", null);
    const admitted = await phasedResolve("paid-operator-requeue");
    expect(admitted.apifyEligible).toBe(true);
    await db.execute({
      args: ["2026-07-22T12:00:00.000Z", "paid-operator-requeue"],
      sql: "update tracks set spotify_anchor_attempted_at = ? where track_id = ?",
    });
    expect(await clearPendingAnchorPaidReceipts(["paid-operator-requeue"])).toBe(1);
    const state = await db.execute({
      args: ["paid-operator-requeue"],
      sql: `select spotify_anchor_paid_state as paid_state,
                   spotify_anchor_attempted_at as attempted_at
            from tracks where track_id = ?`,
    });
    expect(state.rows[0]?.paid_state).toBe("settled");
    expect(state.rows[0]?.attempted_at).toBeNull();
    expect((await getAnchorApifyBudget()).rowsSent).toBe(1);
    expect(await clearPendingAnchorPaidReceipts(["paid-operator-requeue"])).toBe(0);
  });

  it("rejects a paid result token after its bounded report window", async () => {
    const { anchorTrack } = await import("./anchor");
    const started = new Date("2026-07-22T12:00:00.000Z");
    vi.useFakeTimers().setSystemTime(started);
    await seedTrack("expired-paid", "ROWISRC0001");
    const admitted = await phasedResolve("expired-paid");
    vi.setSystemTime(new Date(started.getTime() + 25 * 60 * 60 * 1000));
    await expect(
      anchorTrack("expired-paid", [], { paidResultToken: admitted.paidResultToken }),
    ).rejects.toThrow("invalid or expired anchor phase token");
  });

  it("rejects a changed row at commit", async () => {
    const { commitAnchorFreePhase, prepareAnchorFreePhase, probeAnchorFreePhase } =
      await import("./anchor");
    const { getAnchorApifyBudget } = await import("./anchor-apify");
    await seedTrack("changed-row", "ROWISRC0001");
    const prepared = await prepareAnchorFreePhase("changed-row");
    const evidence = await probeAnchorFreePhase(prepared);
    await db.execute({
      args: ["Different edit", "changed-row"],
      sql: "update tracks set title = ? where track_id = ?",
    });
    await expect(commitAnchorFreePhase(prepared, evidence)).rejects.toThrow(
      "Anchor row changed after prepare",
    );
    expect((await getAnchorApifyBudget()).rowsSent).toBe(0);
  });

  it("returns the existing benign verdict for a missing or deleted worklist row", async () => {
    const {
      commitAnchorFreePhase,
      prepareAnchorFreePhase,
      probeAnchorFreePhase,
      resolveAnchorFree,
    } = await import("./anchor");
    const old = await resolveAnchorFree("missing-row");
    expect(await phasedResolve("missing-row")).toEqual(old);
    await seedTrack("deleted-row", "ROWISRC0001");
    const prepared = await prepareAnchorFreePhase("deleted-row");
    const evidence = await probeAnchorFreePhase(prepared);
    await db.execute({ args: ["deleted-row"], sql: "delete from tracks where track_id = ?" });
    expect(await commitAnchorFreePhase(prepared, evidence)).toEqual({
      ...old,
      paidReceiptPending: false,
    });
  });

  it("recovers Deezer ISRC before applying the same Spotify candidate gate", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const candidates = [
      {
        artistName: "Etherwood",
        deezerTrackId: "deezer-1",
        durationMs: 261_800,
        isrc: "ROWISRC0001",
        title: "Weightless",
      },
    ];
    lookupSpotifyIdsByMbid.mockResolvedValue({
      match: { recordingMbid: "mbid", spotifyTrackIds: ["spotify-1"] },
      outcome: "match",
    });
    await seedTrack("old-deezer", null);
    await seedTrack("new-deezer", null);
    const old = await resolveAnchorFree("old-deezer", new Date(), { deezerCandidates: candidates });
    const phased = await phasedResolve("new-deezer", candidates);
    expect(phased).toEqual(old);
    const row = await db.execute({
      args: ["new-deezer"],
      sql: "select isrc, spotify_uri from tracks where track_id = ?",
    });
    expect(row.rows[0]?.isrc).toBe("ROWISRC0001");
    expect(row.rows[0]?.spotify_uri).toBe("spotify:track:spotify-1");
  });

  it("matches the exact Spotify ISRC and fuzzy search verdicts", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");
    await setAnchorSpotifySearchEnabled(true);
    findSpotifyTrackByIsrc.mockResolvedValue({
      match: { trackId: "spotify-1" },
      rateLimited: false,
    });
    await seedTrack("old-isrc", "ROWISRC0001");
    await seedTrack("new-isrc", "ROWISRC0001");
    expect(await phasedResolve("new-isrc")).toEqual(await resolveAnchorFree("old-isrc"));

    findSpotifyTrackByIsrc.mockResolvedValue({ rateLimited: false });
    searchTrackCandidates.mockResolvedValue([
      {
        artists: ["Etherwood"],
        durationMs: 261_800,
        id: "search-1",
        title: "Weightless",
      },
    ]);
    await seedTrack("old-fuzzy", null);
    await seedTrack("new-fuzzy", null);
    expect(await phasedResolve("new-fuzzy", [])).toEqual(
      await resolveAnchorFree("old-fuzzy", new Date(), { deezerCandidates: [] }),
    );
  });

  it("keeps the closest verified search candidate across a full provider list", async () => {
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");
    await setAnchorSpotifySearchEnabled(true);
    searchTrackCandidates.mockResolvedValue([
      {
        artists: ["Etherwood"],
        durationMs: 260_000,
        id: "farther-first",
        title: "Weightless",
      },
      {
        artists: ["Etherwood"],
        durationMs: 261_900,
        id: "closer-second",
        title: "Weightless",
      },
    ]);
    await seedTrack("priority", "ROWISRC0001");
    const result = await phasedResolve("priority");
    const row = await db.execute({
      args: ["priority"],
      sql: "select spotify_uri from tracks where track_id = ?",
    });
    expect(result.source).toBe("spotify-search");
    expect(row.rows[0]?.spotify_uri).toBe("spotify:track:closer-second");
  });

  it("persists a rejected ListenBrainz version mismatch for review", async () => {
    lookupSpotifyIdsByMbid.mockResolvedValue({
      match: { recordingMbid: "mbid", spotifyTrackIds: ["spotify-1"] },
      outcome: "match",
    });
    fetchTrackMetadata.mockResolvedValue({
      ...metadata,
      isrc: null,
      title: "Weightless (Remix)",
    });
    await seedTrack("review", null);
    const result = await phasedResolve("review", []);
    const row = await db.execute({
      args: ["review"],
      sql: "select anchor_review_json as review from tracks where track_id = ?",
    });
    expect(result.listenbrainzOutcome).toBe("gate-rejected");
    const review = row.rows[0]?.review;
    expect(typeof review).toBe("string");
    expect(JSON.parse(typeof review === "string" ? review : "{}")).toMatchObject({
      candidate: { spotifyTrackId: "spotify-1" },
      reason: "version_mismatch",
    });
  });

  it("keeps the Friday paid window closed in the phased verdict", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    vi.useFakeTimers().setSystemTime(new Date("2026-07-24T05:00:00.000Z"));
    await seedTrack("old-friday", "ROWISRC0001");
    await seedTrack("new-friday", "ROWISRC0001");
    const old = await resolveAnchorFree("old-friday", new Date());
    const phased = await phasedResolve("new-friday");
    expect(phased).toEqual(old);
    expect(phased.apifyEligible).toBe(false);
  });

  it("keeps the 300 per day money rail closed when the configured cap is spent", async () => {
    const { getAnchorApifyBudget, setAnchorApifyDailyRows } = await import("./anchor-apify");
    await setAnchorApifyDailyRows(0);
    await seedTrack("spent-cap", "ROWISRC0001");
    const verdict = await phasedResolve("spent-cap");
    expect(verdict.apifyEligible).toBe(false);
    expect(verdict.apifyIneligibleReason).toBe("apify_budget_spent");
    expect((await getAnchorApifyBudget()).rowsSent).toBe(0);
  });

  it("holds a never-asked ISRC row during quota_hold", async () => {
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");
    const { recordSpotifyThrottle } = await import("./spotify-anchor-breaker");
    const now = new Date("2026-07-22T08:30:00.000Z");
    vi.useFakeTimers().setSystemTime(now);
    await setAnchorSpotifySearchEnabled(true);
    for (let index = 0; index < 5; index += 1) {
      await recordSpotifyThrottle(now.getTime(), true);
    }
    await seedTrack("quota-hold", "ROWISRC0001");
    const verdict = await phasedResolve("quota-hold");
    expect(verdict.apifyEligible).toBe(false);
    expect(verdict.apifyIneligibleReason).toBe("awaiting_free_ask");
    expect(verdict.spotifySearchDone).toBe(false);
  });
});
