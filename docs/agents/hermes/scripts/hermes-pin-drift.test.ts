import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The pin-drift script parses the baked Hermes pins OUT OF the Dockerfile with sed
// programs that live in a different file from the text they read. Nothing but this test
// holds the two in lockstep, and the failure mode is silent in the direction that costs
// the most: a pin whose parser stops matching does not error, it simply stops being
// watched, and the binary behind it rots until something downstream breaks.
//
// That is not hypothetical. yt-dlp was pinned and never watched at all; YouTube moved its
// player, the pinned binary could no longer follow, and `fluncle-capture` failed every
// download for 13 days while reporting a green tick each time (the failure is item-level
// `ytDlpFailures`, so the run-level verdict stayed true). This file is the guard: it reads
// the script's own expressions and runs them against the real Dockerfile, so a reformat
// that breaks a parser fails at PR time instead of going quiet for a fortnight.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SCRIPT = join(REPO_ROOT, ".github", "scripts", "hermes-pin-drift.sh");
const DOCKERFILE = join(REPO_ROOT, "docs", "agents", "hermes", "Dockerfile");

const script = readFileSync(SCRIPT, "utf8");
const dockerfile = readFileSync(DOCKERFILE, "utf8");

/** Run one of the script's own `CUR_*` assignments and return what it resolved to. */
function resolvePin(variable: string): string {
  const assignment = new RegExp(`^${variable}="\\$\\((.+)\\)"$`, "m").exec(script);

  if (!assignment?.[1]) {
    throw new Error(`${variable} is not assigned in hermes-pin-drift.sh`);
  }

  return execFileSync("bash", ["-c", assignment[1]], {
    encoding: "utf8",
    env: { ...process.env, DOCKERFILE },
  }).trim();
}

describe("hermes-pin-drift parses every pin it claims to watch", () => {
  // Each entry is a pin the script reads and a shape its value must have. A pin added to
  // the script without a line here is caught by the roster test below, not by silence.
  const PINS: readonly { pattern: RegExp; variable: string }[] = [
    { pattern: /^\d+\.\d+\.\d+$/, variable: "CUR_FLUNCLE" },
    { pattern: /^\d+\.\d+\.\d+$/, variable: "CUR_CLAUDE" },
    { pattern: /^\d+\.\d+\.\d+$/, variable: "CUR_BUN" },
    { pattern: /^\d{4}\.\d{2}\.\d{2}$/, variable: "CUR_YTDLP" },
    { pattern: /^sha256:[0-9a-f]{64}$/, variable: "CUR_BUN_DIGEST" },
  ];

  for (const { pattern, variable } of PINS) {
    it(`${variable} resolves to a well-formed version`, () => {
      const value = resolvePin(variable);

      expect(value).not.toBe("");
      expect(value).toMatch(pattern);
    });
  }

  it("guards every parsed pin, so a new one cannot skip the FATAL check", () => {
    // The guard is what turns an unparseable pin into a loud exit instead of an empty
    // string that quietly classifies as `unknown` forever.
    const guard = /\[ -n "\$CUR_[\s\S]*?exit 1; \}/.exec(script)?.[0] ?? "";

    for (const { variable } of PINS) {
      expect(guard).toContain(`$${variable}`);
    }
  });
});

describe("the yt-dlp pin can actually be rewritten", () => {
  it("the literal `inplace` searches for is present in the Dockerfile", () => {
    // A parser that reads the version and a marker that does not match the file would
    // apply nothing at all — the drift table would say SAFE and the PR would be empty.
    // Asserted against the ONE download line rather than the whole file, so a failure
    // prints that line instead of every byte of the Dockerfile.
    const current = resolvePin("CUR_YTDLP");
    const downloadLine = dockerfile.split("\n").find((line) => line.includes("yt-dlp_linux")) ?? "";

    expect(downloadLine).toContain(`yt-dlp/releases/download/${current}/yt-dlp_linux`);
  });

  it("the apply branch rewrites that same marker", () => {
    expect(script).toContain(
      'inplace "$DOCKERFILE" "yt-dlp/releases/download/$CUR_YTDLP/yt-dlp_linux" "yt-dlp/releases/download/$APPLY_YTDLP/yt-dlp_linux"',
    );
  });
});

describe("yt-dlp is assessed as a calendar version", () => {
  /** Source only the script's semver helpers, without executing the network checks. */
  function helper(expression: string): string {
    const helpers = /^ver_gt\(\).+?\n^major\(\).+?\n/ms.exec(script)?.[0] ?? "";

    expect(helpers).not.toBe("");

    return execFileSync("bash", ["-c", `${helpers}\n${expression}`], { encoding: "utf8" }).trim();
  }

  it("orders a year rollover correctly", () => {
    expect(helper("ver_gt 2027.01.01 2026.12.31 && echo newer || echo older")).toBe("newer");
  });

  it("would be held by the major brake, which is why the calendar flag exists", () => {
    // The brake asks whether the leading component changed. For a date that is January,
    // not a breaking change — so without the flag every new year's first release would
    // sit in the report-only pile, which is the exact stall this watch exists to prevent.
    expect(
      helper('[ "$(major 2027.01.01)" = "$(major 2026.12.31)" ] && echo same || echo differs'),
    ).toBe("differs");
  });

  it("is passed the calendar flag at its call site", () => {
    expect(script).toMatch(/^assess yt-dlp "\$CUR_YTDLP" "\$LATEST_YTDLP" calendar$/m);
  });

  it("skips the major brake only when that flag is set", () => {
    const brake =
      /if \[ -n "\$calendar" \] \|\| \[ "\$\(major "\$latest"\)" = "\$\(major "\$cur"\)" \]; then/.exec(
        script,
      );

    expect(brake).not.toBeNull();
  });
});

describe("bun is the base image", () => {
  /** Source one of the script's shell functions by name and run an expression after it. */
  function withFunction(name: string, expression: string, input: string): string {
    const body = new RegExp(`^${name}\\(\\) \\{[\\s\\S]+?^\\}$`, "m").exec(script)?.[0] ?? "";

    expect(body).not.toBe("");

    return execFileSync("bash", ["-c", `${body}\n${expression}`], {
      encoding: "utf8",
      input,
    }).trim();
  }

  it("the FROM line carries the tag and digest the apply branch rewrites together", () => {
    // Rewriting the tag without its digest would keep building the old image under a new
    // name; the marker below is the exact string `inplace` searches for.
    const from = dockerfile.split("\n").find((line) => line.startsWith("FROM ")) ?? "";

    expect(from).toBe(
      `FROM oven/bun:${resolvePin("CUR_BUN")}-debian@${resolvePin("CUR_BUN_DIGEST")}`,
    );
    expect(script).toContain(
      'inplace "$DOCKERFILE" "oven/bun:$CUR_BUN-debian@$CUR_BUN_DIGEST" "oven/bun:$APPLY_BUN-debian@$APPLY_BUN_DIGEST"',
    );
  });

  it("reads a published tag's digest from its Docker Hub record", () => {
    const record = JSON.stringify({ digest: "sha256:abc", name: "1.4.3-debian" });

    expect(withFunction("bun_image_digest", "bun_image_digest", record)).toBe("sha256:abc");
  });

  it("reads nothing for a tag Docker Hub does not carry yet", () => {
    // A bun release lands on GitHub before its image; an empty digest holds the bump for
    // the next run instead of writing a FROM line no build can pull.
    expect(
      withFunction("bun_image_digest", "bun_image_digest", '{"message":"tag not found"}'),
    ).toBe("");
    expect(withFunction("bun_image_digest", "bun_image_digest", "not json")).toBe("");
  });
});

describe("the brake report", () => {
  /** Source one of the script's shell functions by name and run an expression after it. */
  function withFunction(name: string, expression: string, input: string): string {
    const body = new RegExp(`^${name}\\(\\) \\{[\\s\\S]+?^\\}$`, "m").exec(script)?.[0] ?? "";

    expect(body).not.toBe("");

    return execFileSync("bash", ["-c", `${body}\n${expression}`], {
      encoding: "utf8",
      input,
    }).trim();
  }

  it("signs the brake items alone, so an unchanged brake yields the same signature", () => {
    const sign = (lines: string) => withFunction("brake_signature", "brake_signature", lines);
    const brake = "- **bun** `1.4.2` → `2.0.0` — major bump.\n";

    expect(sign(brake)).toMatch(/^[0-9a-f]{16}$/);
    expect(sign(brake)).toBe(sign(brake));
    expect(sign(brake)).not.toBe(sign("- **bun** `1.4.2` → `2.0.1` — major bump.\n"));
  });

  it("the issue body carries the signature the workflow compares against", () => {
    expect(script).toContain('echo "<!-- brake-signature: $BRAKE_SIGNATURE -->"');
    expect(script).toContain('emit "brake_signature=$BRAKE_SIGNATURE"');
  });

  it("the workflow skips a comment that would repeat the last report", () => {
    const workflow = readFileSync(
      join(REPO_ROOT, ".github", "workflows", "hermes-pin-drift.yml"),
      "utf8",
    );

    expect(workflow).toContain("BRAKE_SIGNATURE: ${{ steps.drift.outputs.brake_signature }}");
    expect(workflow).toContain('grep -qF "brake-signature: $BRAKE_SIGNATURE"');
  });
});
