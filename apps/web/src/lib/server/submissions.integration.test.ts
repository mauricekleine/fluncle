import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SubmissionInput } from "./submissions";
import { createIntegrationDb, seedSubmission, seedTrack } from "./integration-db";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return {
    ...actual,
    getDb: () => Promise.resolve(db),
  };
});

const validTrackId = "abcdefghij0123456789AB";
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

describe("validateSubmissionInput text fields", () => {
  it.each([
    ["an escape sequence in the note", { note: "hi \u001b[2J there" }],
    ["a bell in the contact", { contact: "me\u0007" }],
    ["a C1 control in the note", { note: "hi \u009b31m" }],
    ["a DEL in the album", { album: "Album\u007f" }],
  ])("rejects %s", async (_label, overrides) => {
    const { validateSubmissionInput } = await import("./submissions");

    expect(() => validateSubmissionInput(baseInput(overrides))).toThrowError(/Invalid text field/);
  });

  it("keeps a multi-line note with tabs", async () => {
    const { validateSubmissionInput } = await import("./submissions");

    const result = validateSubmissionInput(baseInput({ note: "line one\r\n\tline two" }));
    expect(result.note).toBe("line one\r\n\tline two");
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

    await expect(approveSubmission("sub-ok")).rejects.toMatchObject({
      code: "invalid_status",
      status: 409,
    });
  });
});
