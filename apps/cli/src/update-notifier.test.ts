import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { detectInstallMethod, shouldNotify, updateCommand } from "./update-notifier";

describe("detectInstallMethod", () => {
  test("Homebrew Cellar path → homebrew", () => {
    expect(
      detectInstallMethod({
        entry: "/opt/homebrew/Cellar/fluncle/0.33.0/bin/fluncle",
        execPath: "/opt/homebrew/Cellar/fluncle/0.33.0/bin/fluncle",
      }),
    ).toBe("homebrew");
  });

  test("Linuxbrew path → homebrew", () => {
    expect(
      detectInstallMethod({
        entry: "/home/me/.linuxbrew/bin/fluncle",
        execPath: "/home/me/.linuxbrew/bin/fluncle",
      }),
    ).toBe("homebrew");
  });

  test("Bun --compile standalone (execPath named fluncle, no script entry) → binary", () => {
    expect(detectInstallMethod({ entry: "", execPath: "/usr/local/bin/fluncle" })).toBe("binary");
    expect(
      detectInstallMethod({
        entry: "/usr/local/bin/fluncle",
        execPath: "/usr/local/bin/fluncle",
      }),
    ).toBe("binary");
  });

  test("node running the published .mjs bundle → npm", () => {
    expect(
      detectInstallMethod({
        entry: "/usr/local/lib/node_modules/fluncle/bin/fluncle.mjs",
        execPath: "/usr/local/bin/node",
      }),
    ).toBe("npm");
  });

  test("node_modules anywhere in the path → npm", () => {
    expect(
      detectInstallMethod({
        entry: "/home/me/.npm-global/lib/node_modules/fluncle/bin/fluncle.mjs",
        execPath: "/usr/bin/node",
      }),
    ).toBe("npm");
  });

  test("inconclusive launch defaults to npm (the safe broad instruction)", () => {
    expect(detectInstallMethod({ entry: "", execPath: "/usr/bin/node" })).toBe("npm");
  });
});

describe("updateCommand", () => {
  test("maps each install method to its instruction", () => {
    expect(updateCommand("npm")).toBe("npm i -g fluncle@latest");
    expect(updateCommand("homebrew")).toBe("brew upgrade fluncle");
    expect(updateCommand("binary")).toContain("https://www.fluncle.com/cli/latest.sh");
    expect(updateCommand("binary")).toContain(
      "https://github.com/mauricekleine/fluncle/releases/latest",
    );
  });
});

describe("shouldNotify", () => {
  const originalIsTty = process.stderr.isTTY;

  function setTty(value: boolean): void {
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value });
  }

  beforeEach(() => {
    // The CI runner sets CI=true in the ambient env; clear it (and the opt-out var)
    // before each case so a test controls its own environment and the TTY-true
    // assertions hold. Cases that test the CI/opt-out paths set the var themselves.
    delete process.env.CI;
    delete process.env.FLUNCLE_NO_UPDATE_NOTIFIER;
  });

  afterEach(() => {
    Object.defineProperty(process.stderr, "isTTY", {
      configurable: true,
      value: originalIsTty,
    });
    delete process.env.FLUNCLE_NO_UPDATE_NOTIFIER;
    delete process.env.CI;
  });

  test("notifies for a normal command on an interactive stderr", () => {
    setTty(true);
    expect(shouldNotify(["recent"])).toBe(true);
  });

  test("silences when stderr is not a TTY (piped/redirected)", () => {
    setTty(false);
    expect(shouldNotify(["recent"])).toBe(false);
  });

  test("FLUNCLE_NO_UPDATE_NOTIFIER=1 opts out", () => {
    setTty(true);
    process.env.FLUNCLE_NO_UPDATE_NOTIFIER = "1";
    expect(shouldNotify(["recent"])).toBe(false);
  });

  test("CI opts out", () => {
    setTty(true);
    process.env.CI = "true";
    expect(shouldNotify(["recent"])).toBe(false);
  });

  test("--json silences", () => {
    setTty(true);
    expect(shouldNotify(["recent", "--json"])).toBe(false);
  });

  test("version, about, help, and --help/--version flags are skipped", () => {
    setTty(true);
    expect(shouldNotify(["version"])).toBe(false);
    expect(shouldNotify(["about"])).toBe(false);
    expect(shouldNotify(["help"])).toBe(false);
    expect(shouldNotify(["recent", "--help"])).toBe(false);
    expect(shouldNotify(["--version"])).toBe(false);
  });

  test("--env <profile> is skipped when finding the command", () => {
    setTty(true);
    expect(shouldNotify(["--env", "local", "version"])).toBe(false);
    expect(shouldNotify(["--env", "local", "recent"])).toBe(true);
  });
});
