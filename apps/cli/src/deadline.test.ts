import { afterEach, describe, expect, test } from "bun:test";
import {
  armDeadline,
  assertBeforeDeadline,
  deadlineAt,
  deadlineFired,
  deadlineSignal,
  DEFAULT_NON_INTERACTIVE_TIMEOUT_SECONDS,
  disarmDeadline,
  noteProgress,
  parseTimeoutSeconds,
  remainingDeadlineMs,
  resetDeadlineForTests,
  resolveTimeoutSeconds,
  TIMEOUT_EXIT_CODE,
  timeoutMessage,
} from "./deadline";

afterEach(() => {
  resetDeadlineForTests();
});

describe("parseTimeoutSeconds", () => {
  test("treats an empty value as unset and 0, off and none as disabled", () => {
    expect(parseTimeoutSeconds(undefined, "--timeout")).toBeNull();
    expect(parseTimeoutSeconds("  ", "--timeout")).toBeNull();
    expect(parseTimeoutSeconds("0", "--timeout")).toBe(0);
    expect(parseTimeoutSeconds("off", "--timeout")).toBe(0);
    expect(parseTimeoutSeconds("none", "FLUNCLE_TIMEOUT")).toBe(0);
    expect(parseTimeoutSeconds("90", "--timeout")).toBe(90);
    expect(parseTimeoutSeconds("1.5", "--timeout")).toBe(1.5);
  });

  test("rejects values that are not a positive number of seconds", () => {
    expect(() => parseTimeoutSeconds("4m", "--timeout")).toThrow(
      '--timeout must be a number of seconds (0 disables the deadline), not "4m"',
    );
    expect(() => parseTimeoutSeconds("-3", "FLUNCLE_TIMEOUT")).toThrow("FLUNCLE_TIMEOUT must be");
  });
});

describe("resolveTimeoutSeconds", () => {
  test("the flag wins over the environment, which wins over the default", () => {
    expect(resolveTimeoutSeconds({ env: "30", flag: "10", interactive: false })).toBe(10);
    expect(resolveTimeoutSeconds({ env: "30", flag: undefined, interactive: true })).toBe(30);
    expect(resolveTimeoutSeconds({ env: undefined, flag: "0", interactive: false })).toBe(0);
  });

  test("applies the default only when stdout is not a terminal", () => {
    expect(resolveTimeoutSeconds({ env: undefined, flag: undefined, interactive: false })).toBe(
      DEFAULT_NON_INTERACTIVE_TIMEOUT_SECONDS,
    );
    expect(resolveTimeoutSeconds({ env: undefined, flag: undefined, interactive: true })).toBe(0);
  });
});

type Scheduled = { cancelled: boolean; fire: () => void; ms: number };

function fakeScheduler(): {
  scheduled: Scheduled[];
  schedule: (fire: () => void, ms: number) => () => void;
} {
  const scheduled: Scheduled[] = [];

  return {
    schedule: (fire, ms) => {
      const entry = { cancelled: false, fire, ms };
      scheduled.push(entry);

      return () => {
        entry.cancelled = true;
      };
    },
    scheduled,
  };
}

describe("armDeadline", () => {
  test("firing reports the latest progress note, aborts in-flight work, and exits 124 after the cleanup grace", () => {
    const reports: string[] = [];
    const exits: number[] = [];
    const { schedule, scheduled } = fakeScheduler();
    const beforeExitCode = process.exitCode;

    try {
      armDeadline(240, {
        command: "admin labels evidence 8f1c",
        exit: (code) => {
          exits.push(code);
        },
        graceMs: 10_000,
        json: false,
        now: () => 1_000_000,
        report: (message) => reports.push(message),
        schedule,
      });

      expect(deadlineAt()).toBe(1_240_000);
      expect(remainingDeadlineMs(() => 1_100_000)).toBe(140_000);
      expect(scheduled.map((entry) => entry.ms)).toEqual([240_000]);
      expect(deadlineSignal().aborted).toBe(false);

      noteProgress("waiting 95 s for a discogs slot behind other callers on this machine");
      scheduled[0]?.fire();

      expect(deadlineFired()).toBe(true);
      expect(deadlineSignal().aborted).toBe(true);
      expect(process.exitCode).toBe(TIMEOUT_EXIT_CODE);
      expect(reports).toEqual([
        "fluncle admin labels evidence 8f1c stopped after 240 s: waiting 95 s for a discogs slot behind other callers on this machine. Set --timeout or FLUNCLE_TIMEOUT in seconds (0 disables the deadline).",
      ]);
      expect(exits).toEqual([]);
      expect(scheduled.map((entry) => entry.ms)).toEqual([240_000, 10_000]);

      scheduled[1]?.fire();

      expect(exits).toEqual([TIMEOUT_EXIT_CODE]);
    } finally {
      process.exitCode = beforeExitCode ?? 0;
    }
  });

  test("disarming after the action completes cancels the timer so a slow update check cannot fail a finished command", () => {
    const { schedule, scheduled } = fakeScheduler();

    armDeadline(1, { command: "version", json: false, schedule });
    disarmDeadline();

    expect(scheduled.map((entry) => entry.cancelled)).toEqual([true]);
    expect(deadlineFired()).toBe(false);
  });

  test("a disabled deadline arms nothing", () => {
    const { schedule, scheduled } = fakeScheduler();

    armDeadline(0, { command: "version", json: false, schedule });

    expect(scheduled).toEqual([]);
    expect(deadlineAt()).toBeNull();
    expect(remainingDeadlineMs()).toBeNull();
  });

  test("assertBeforeDeadline fires the deadline synchronously when a blocking call outlived it", () => {
    const reports: string[] = [];
    const { schedule, scheduled } = fakeScheduler();
    const beforeExitCode = process.exitCode;

    try {
      armDeadline(1, {
        command: "admin labels list",
        json: false,
        now: () => Date.now() - 5_000,
        report: (message) => reports.push(message),
        schedule,
      });

      expect(() => assertBeforeDeadline("reading the token")).toThrow(
        "the deadline passed while reading the token",
      );
      expect(remainingDeadlineMs()).toBeLessThan(0);
      expect(deadlineFired()).toBe(true);
      expect(deadlineSignal().aborted).toBe(true);
      expect(process.exitCode).toBe(TIMEOUT_EXIT_CODE);
      expect(reports).toEqual([
        "fluncle admin labels list stopped after 1 s. Set --timeout or FLUNCLE_TIMEOUT in seconds (0 disables the deadline).",
      ]);
      expect(scheduled[0]?.cancelled).toBe(true);
      expect(scheduled.map((entry) => entry.ms)).toEqual([1_000, 10_000]);
    } finally {
      process.exitCode = beforeExitCode ?? 0;
    }
  });

  test("the message stands on its own without a progress note", () => {
    expect(timeoutMessage("version --check", 5, null)).toBe(
      "fluncle version --check stopped after 5 s. Set --timeout or FLUNCLE_TIMEOUT in seconds (0 disables the deadline).",
    );
  });
});
