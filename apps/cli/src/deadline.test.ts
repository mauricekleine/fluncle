import { afterEach, describe, expect, test } from "bun:test";
import {
  armDeadline,
  deadlineAt,
  DEFAULT_NON_INTERACTIVE_TIMEOUT_SECONDS,
  noteProgress,
  parseTimeoutSeconds,
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

describe("armDeadline", () => {
  test("records the deadline and, when it fires, reports the latest progress note and exits 124", () => {
    const reports: string[] = [];
    const exits: number[] = [];
    let fire: (() => void) | undefined;

    armDeadline(240, {
      command: "admin labels evidence 8f1c",
      exit: ((code: number) => {
        exits.push(code);
      }) as unknown as (code: number) => never,
      json: false,
      now: () => 1_000_000,
      report: (message) => reports.push(message),
      schedule: (callback, ms) => {
        expect(ms).toBe(240_000);
        fire = callback;
      },
    });

    expect(deadlineAt()).toBe(1_240_000);
    noteProgress("waiting 95 s for a discogs slot behind other callers on this machine");
    fire?.();

    expect(exits).toEqual([TIMEOUT_EXIT_CODE]);
    expect(reports).toEqual([
      "fluncle admin labels evidence 8f1c stopped after 240 s: waiting 95 s for a discogs slot behind other callers on this machine. Set --timeout or FLUNCLE_TIMEOUT in seconds (0 disables the deadline).",
    ]);
  });

  test("a disabled deadline arms nothing", () => {
    let scheduled = 0;

    armDeadline(0, {
      command: "version",
      json: false,
      schedule: () => {
        scheduled += 1;
      },
    });

    expect(scheduled).toBe(0);
    expect(deadlineAt()).toBeNull();
  });

  test("the message stands on its own without a progress note", () => {
    expect(timeoutMessage("version --check", 5, null)).toBe(
      "fluncle version --check stopped after 5 s. Set --timeout or FLUNCLE_TIMEOUT in seconds (0 disables the deadline).",
    );
  });
});
