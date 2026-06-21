import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realApi from "../api";
import { CliError } from "../output";

// A submission the mocked admin API returns for the approve path.
const fakeSubmission = {
  artists: ["Artist"],
  contact: undefined,
  createdAt: "2026-06-21T00:00:00.000Z",
  id: "sub_1",
  note: undefined,
  source: "web",
  spotifyUrl: "https://open.spotify.com/track/x",
  status: "pending",
  title: "Song",
};

let published = false;
let approved = false;

// Override only the two api functions the approve path uses; spread the rest so
// the global mock.module replacement doesn't strip exports other test files need.
mock.module("../api", () => ({
  ...realApi,
  adminApiGet: async () => ({ submission: fakeSubmission }),
  adminApiPost: async (path: string) => {
    if (path.endsWith("/approve")) {
      approved = true;
    }
    return { submission: fakeSubmission };
  },
}));

mock.module("./add", () => ({
  // The approve flow calls add twice: a dry-run preview, then the real publish.
  // Only the real publish (no dryRun) counts as "published".
  addCommand: async (_url: string, options: { dryRun?: boolean }) => {
    if (!options.dryRun) {
      published = true;
    }
    return { track: {} };
  },
}));

const { approveSubmissionCommand } = await import("./submissions");

describe("approveSubmissionCommand non-interactive", () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    published = false;
    approved = false;
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalIsTTY });
  });

  test("throws not_interactive off a TTY instead of a silent no-op", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });

    let thrown: unknown;
    try {
      await approveSubmissionCommand("sub_1");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).code).toBe("not_interactive");
    // It must NOT have published behind a silent cancel.
    expect(published).toBe(false);
    expect(approved).toBe(false);
  });

  test("--json approves without prompting, even off a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });

    await approveSubmissionCommand("sub_1", { json: true });

    expect(published).toBe(true);
    expect(approved).toBe(true);
  });
});
