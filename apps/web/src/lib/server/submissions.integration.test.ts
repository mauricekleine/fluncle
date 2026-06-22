import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SubmissionInput } from "./submissions";
import { createIntegrationDb, seedSubmission, seedTrack } from "./integration-db";

// `validateSubmissionInput` is a PURE function (no DB) — tested directly below.
// `approveSubmission` is DB-backed (it reads the submission + the published track
// row), so those cases run against the in-memory libSQL harness via a `getDb()`
// mock, exercising the REAL status-guard SQL.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return {
    ...actual,
    getDb: () => Promise.resolve(db),
  };
});

const validTrackId = "abcdefghij0123456789AB"; // exactly 22 [A-Za-z0-9]
const validUrl = `https://open.spotify.com/track/${validTrackId}`;

function baseInput(overrides: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    artists: ["Some Artist"],
    source: "web",
    spotifyTrackId: validTrackId,
    spotifyUrl: validUrl,
    title: "Some Title",
    ...overrides,
  } as SubmissionInput;
}

describe("validateSubmissionInput (pure unit, no DB)", () => {
  it("accepts a well-formed submission", async () => {
    const { validateSubmissionInput } = await import("./submissions");

    const result = validateSubmissionInput(baseInput());
    expect(result.spotifyTrackId).toBe(validTrackId);
    expect(result.source).toBe("web");
  });

  it("rejects when the honeypot field is filled (bot trap)", async () => {
    const { validateSubmissionInput } = await import("./submissions");

    expect(() => validateSubmissionInput(baseInput({ honeypot: "i am a bot" }))).toThrowError(
      /Invalid submission/,
    );
  });

  it.each([
    ["too short (21 chars)", "abcdefghij0123456789A"],
    ["too long (23 chars)", "abcdefghij0123456789ABC"],
    ["non-alphanumeric", "abcdefghij0123456789A!"],
  ])("rejects a track id that is %s", async (_label, badId) => {
    const { validateSubmissionInput } = await import("./submissions");

    // Keep the URL well-formed so the 22-char track-id regex is the thing that
    // trips (a bad id in the URL would 400 in parseSpotifyTrackUrl first).
    expect(() =>
      validateSubmissionInput(baseInput({ spotifyTrackId: badId, spotifyUrl: validUrl })),
    ).toThrowError(/Invalid selected track id|Invalid Spotify/);
  });

  it("rejects when the URL's track id does not match spotifyTrackId", async () => {
    const { validateSubmissionInput } = await import("./submissions");

    const otherUrl = "https://open.spotify.com/track/zzzzzzzzzzzzzzzzzzzzzz";
    expect(() => validateSubmissionInput(baseInput({ spotifyUrl: otherUrl }))).toThrowError(
      /does not match Spotify URL/,
    );
  });
});

describe("approveSubmission (real SQL status guard)", () => {
  beforeEach(async () => {
    db = await createIntegrationDb();
  });

  afterEach(() => {
    db.close();
  });

  it("409s invalid_status when the submission is not pending", async () => {
    const { approveSubmission } = await import("./submissions");

    await seedSubmission(db, {
      id: "sub-approved",
      spotifyTrackId: validTrackId,
      status: "approved",
    });

    await expect(approveSubmission("sub-approved")).rejects.toMatchObject({
      code: "invalid_status",
      status: 409,
    });
  });

  it("409s not_published when the track was never published", async () => {
    const { approveSubmission } = await import("./submissions");

    await seedSubmission(db, {
      id: "sub-pending",
      spotifyTrackId: validTrackId,
      status: "pending",
    });

    await expect(approveSubmission("sub-pending")).rejects.toMatchObject({
      code: "not_published",
      status: 409,
    });
  });

  it("approves a pending submission once its track is fully published", async () => {
    const { approveSubmission } = await import("./submissions");

    await seedSubmission(db, {
      id: "sub-ok",
      spotifyTrackId: validTrackId,
      status: "pending",
    });
    await seedTrack(db, {
      addedToSpotify: true,
      logId: "log-ok",
      postedToTelegram: true,
      trackId: validTrackId,
    });

    const result = await approveSubmission("sub-ok");
    expect(result.status).toBe("approved");
    expect(result.reviewedAt).toBeDefined();

    // The status guard actually wrote: a second approve now 409s.
    await expect(approveSubmission("sub-ok")).rejects.toMatchObject({
      code: "invalid_status",
      status: 409,
    });
  });
});
