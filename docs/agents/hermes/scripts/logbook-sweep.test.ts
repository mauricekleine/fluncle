// Unit tests for the pure helpers in logbook-sweep.ts — the authoring PROMPT (where the
// anti-sameness SPENT block lives) and the `readEchoedMove` parser that drives the one
// re-author pass. The box scripts are self-contained (they cannot import the workspace) and
// live outside any package's test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/logbook-sweep.test.ts
//
// The rail's RISK is the spent moves getting templated instead of informing, so the prompt's
// anti-sameness instruction is load-bearing product behaviour — asserted here, and enforced
// for real by the Worker's title/body gates (logbook.ts + logbook-echo.ts, their own tests
// in apps/web/src/lib/server/logbook.server.test.ts).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAttemptLedger, selectWork } from "./attempt-ledger";

// ── THE STUB RIG ───────────────────────────────────────────────────────────────────────
//
// On disk and pointed at by env BEFORE the sweep module is evaluated: FLUNCLE_BIN / CLAUDE_BIN /
// LOGBOOK_STATE_DIR are read at module load, which is why the sweep is imported dynamically below.

const RIG = mkdtempSync(join(tmpdir(), "logbook-sweep-test-"));
const STATE_DIR = join(RIG, "state");
const CONTROL = join(RIG, "control");
const FLUNCLE_STUB = join(RIG, "fluncle");
const CLAUDE_STUB = join(RIG, "claude");

mkdirSync(CONTROL, { recursive: true });

writeFileSync(
  CLAUDE_STUB,
  `#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
printf 'x\\n' >> "${CONTROL}/authorings"
if [ "$(cat "${CONTROL}/claude-verdict" 2>/dev/null || printf 'up')" = "down" ]; then
  printf 'API Error: 529 overloaded_error\\n' >&2
  exit 1
fi
printf '{"result":"TITLE: Future Signal, twice over\\\\n\\\\nThe day opened patient and stayed that way."}'
`,
  { mode: 0o755 },
);

// `stores` records only the entries the Worker ACCEPTED. It must stay EMPTY for a day whose
// drafts the gates refused.
writeFileSync(
  FLUNCLE_STUB,
  `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "admin" ] && [ "\${2:-}" = "logbook" ] && [ "\${3:-}" = "gaps" ]; then
  if [ "$(cat "${CONTROL}/queue-mode" 2>/dev/null || printf 'empty')" = "work" ]; then
    printf '{"gaps":[{"date":"2026-07-05","findings":[{"artists":["Future Signal"],"logId":"036.7.2I","posterUrl":"x","title":"Fractals"}],"sector":36}],"spent":[]}'
  else
    printf '{"gaps":[],"spent":[]}'
  fi
  exit 0
fi
verdict="$(cat "${CONTROL}/verdict" 2>/dev/null || printf 'pass')"
if [ "$verdict" = "infra403" ]; then
  printf 'error: request failed with 403 forbidden\\n' >&2
  exit 1
fi
if [ "$verdict" = "voice" ]; then
  printf 'error: The body fails the voice gate: banned identity word "signal" [voice_gate 422]\\n' >&2
  exit 1
fi
if [ "$verdict" = "echo" ]; then
  printf 'error: body_echoes_logbook: it lifts "the day opened patient and" straight from sector 12 [422]\\n' >&2
  exit 1
fi
printf '%s\\n' "\${4:-?}" >> "${CONTROL}/stores"
printf '{"ok":true}'
`,
  { mode: 0o755 },
);

chmodSync(CLAUDE_STUB, 0o755);
chmodSync(FLUNCLE_STUB, 0o755);

process.env["CLAUDE_BIN"] = CLAUDE_STUB;
process.env["FLUNCLE_BIN"] = FLUNCLE_STUB;
process.env["LOGBOOK_STATE_DIR"] = STATE_DIR;
// No agent token, so `resolveSweepPrompt` falls back to the baked builder and reaches no network.
delete process.env["FLUNCLE_API_TOKEN"];

const {
  authorOne,
  buildAuthoringPrompt,
  logbookKey,
  MAX_LOGBOOK_ATTEMPTS,
  readEchoedMove,
}: typeof import("./logbook-sweep") = await import("./logbook-sweep");

type Spent = import("./logbook-sweep").Spent;

afterAll(() => {
  rmSync(RIG, { force: true, recursive: true });
});

const GAP = {
  date: "2026-07-05",
  findings: [{ artists: ["Fizzy"], logId: "036.7.2I", posterUrl: "x", title: "A Cut" }],
  sector: 36,
};

const SPENT: Spent[] = [
  {
    closer: "Enjoy, cosmonauts.",
    opener: "The sector was quiet when I dropped in.",
    sector: 18,
    title: "Shoulders Down",
  },
  {
    closer: "I played it twice.",
    opener: "One long roller, start to finish.",
    sector: 17,
    title: "One roller",
  },
];

describe("buildAuthoringPrompt", () => {
  test("lays the day's findings out with their figure tokens", () => {
    const prompt = buildAuthoringPrompt(GAP);

    expect(prompt).toContain("[[036.7.2I]]");
    expect(prompt).toContain("A Cut");
    expect(prompt).toContain("Fizzy");
  });

  test("carries the SPENT log — the taken titles and the used opener/closer moves", () => {
    const prompt = buildAuthoringPrompt(GAP, SPENT);

    expect(prompt).toContain("THE SPENT LOG");
    expect(prompt).toContain('"Shoulders Down"');
    expect(prompt).toContain("One long roller, start to finish.");
    expect(prompt).toContain("Enjoy, cosmonauts.");
  });

  // THE GUARDRAIL. The spent moves are shown as a list of what is TAKEN, never a template,
  // and the worn moves are named explicitly. If this softens, the rail stops working.
  test("names the worn moves and frames the log as SPENT, not a template", () => {
    const prompt = buildAuthoringPrompt(GAP, SPENT);

    expect(prompt).toContain("TAKEN");
    expect(prompt).toContain("WORN");
    expect(prompt).toContain("Shoulders");
    expect(prompt).toContain("quiet-sector opener");
    expect(prompt).toContain("body-clock");
    expect(prompt).toContain("Enjoy, cosmonauts.");
    // It tells the model the rejection is real, so the constraint has teeth.
    expect(prompt).toContain("REJECTS a title that matches a past one");
  });

  test("omits the spent block entirely when there is no history (the first entries)", () => {
    const prompt = buildAuthoringPrompt(GAP, []);

    expect(prompt).not.toContain("THE SPENT LOG");
    // …and it is still a complete, authorable prompt.
    expect(prompt).toContain("[[036.7.2I]]");
    expect(prompt).toContain("OUTPUT FORMAT (exactly):");
  });

  test("hands the model its own echoed move back on the re-author pass", () => {
    const prompt = buildAuthoringPrompt(GAP, SPENT, "the low end rolled in slow and patient");

    expect(prompt).toContain("YOUR LAST ATTEMPT WAS REJECTED");
    expect(prompt).toContain("the low end rolled in slow and patient");
  });
});

describe("readEchoedMove", () => {
  test("pulls the lifted phrase out of a body-echo rejection (JSON-escaped quotes)", () => {
    const message =
      '{"code":"body_echoes_logbook","message":"The entry echoes the recent logbook: it lifts \\"low end rolled in slow\\" straight from sector 12."}';

    expect(readEchoedMove(message)).toBe("low end rolled in slow");
  });

  test("pulls the colliding title out of a title-collision rejection", () => {
    const message =
      'title_echoes_logbook: The title "Shoulders Down" repeats sector 18\'s "Shoulders Down".';

    expect(readEchoedMove(message)).toBe("Shoulders Down");
  });

  test("returns undefined for an overlap-only rejection (no phrase was lifted)", () => {
    const message = "body_echoes_logbook: it reuses 42% of sector 12's words";

    expect(readEchoedMove(message)).toBeUndefined();
  });
});

describe("run-ledger summary counters", () => {
  test("the real tick counts one attempted day and one authored entry", () => {
    rmSync(CONTROL, { force: true, recursive: true });
    rmSync(STATE_DIR, { force: true, recursive: true });
    mkdirSync(CONTROL, { recursive: true });
    writeFileSync(join(CONTROL, "queue-mode"), "work", "utf8");
    verdict("pass");
    claudeVerdict("up");

    const result = spawnSync(process.execPath, [join(import.meta.dir, "logbook-sweep.ts")], {
      encoding: "utf8",
      env: { ...process.env, FLUNCLE_API_TOKEN: "" },
    });
    const summary = JSON.parse(result.stdout.trim()) as Record<string, unknown>;

    expect(result.status).toBe(0);
    expect(summary).toMatchObject({
      authored: 1,
      checked: 1,
      errors: 0,
      failed: 0,
      gapsRemaining: 0,
      produced: 1,
    });
    // The gaps endpoint is read with `--limit 10`; that page length is not the total backlog.
    expect("queueDepth" in summary).toBe(false);
    expect("queue_depth" in summary).toBe(false);
    expect("expectedIntervalMs" in summary).toBe(false);
    expect("expected_interval_ms" in summary).toBe(false);
  });
});

// ── THE ATTEMPT BUDGET, END TO END ─────────────────────────────────────────────────────
//
// `authorOne` driven against the stub binaries, with the ledger on disk. Each `tick()` is a
// separate call that reads the ledger back off disk — what a real cron tick is.
//
// This sweep's queue is the worst of the three: the gap list is OLDEST FIRST, so one
// unwritable day stopped the logbook backfilling ANYTHING newer, forever. And the day could be
// genuinely unwritable: the sweep hands the author each finding's artist and title as its material
// while the gate scanned those same names. THE NAME EXEMPTION fixes that; this bounds the rest.

function verdict(value: "pass" | "voice" | "echo" | "infra403"): void {
  writeFileSync(join(CONTROL, "verdict"), value, "utf8");
}

function claudeVerdict(value: "up" | "down"): void {
  writeFileSync(join(CONTROL, "claude-verdict"), value, "utf8");
}

function readLines(file: string): string[] {
  try {
    return readFileSync(join(CONTROL, file), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const authorings = () => readLines("authorings").length;
/** The entries that were actually STORED — must stay empty for a refused day. */
const stores = () => readLines("stores");
const ledgerPath = () => join(STATE_DIR, "attempts");

function gapFor(sector: number) {
  return {
    date: "2026-07-05",
    findings: [
      { artists: ["Future Signal"], logId: "036.7.2I", posterUrl: "x", title: "Fractals" },
    ],
    sector,
  };
}

async function tick(sector: number) {
  const ledger = readAttemptLedger(ledgerPath());

  return authorOne(gapFor(sector), [], { ledger, ledgerPath: ledgerPath() });
}

describe("authorOne (the bounded re-author, across ticks)", () => {
  beforeEach(() => {
    rmSync(CONTROL, { force: true, recursive: true });
    rmSync(STATE_DIR, { force: true, recursive: true });
    mkdirSync(CONTROL, { recursive: true });
    claudeVerdict("up");
  });

  test("a gate-PASSING day is authored once and leaves no budget behind", async () => {
    verdict("pass");

    expect(await tick(36)).toBe("authored");
    expect(authorings()).toBe(1);
    expect(readAttemptLedger(ledgerPath()).size).toBe(0);
  });

  test("a gate-REFUSING day is authored for at most three passes, then never again", async () => {
    verdict("voice");

    for (let i = 1; i < MAX_LOGBOOK_ATTEMPTS; i += 1) {
      expect(await tick(36)).toBe("gateSkipped");
    }

    expect(await tick(36)).toBe("exhausted");
    expect(authorings()).toBe(MAX_LOGBOOK_ATTEMPTS);

    for (let i = 0; i < 5; i += 1) {
      expect(await tick(36)).toBe("exhausted");
    }

    expect(authorings()).toBe(MAX_LOGBOOK_ATTEMPTS);
  });

  // THE OPERATOR'S RULING (2026-07-30): no final-attempt bypass. A gap is a perfectly good state,
  // so an exhausted day simply stays one rather than publishing copy the gates refused.
  test("NOTHING is ever stored for a day whose drafts the gates refused", async () => {
    verdict("voice");

    for (let i = 0; i < MAX_LOGBOOK_ATTEMPTS + 3; i += 1) {
      await tick(36);
    }

    expect(stores()).toEqual([]);
  });

  test("an ECHO refusal spends the budget too — its in-tick retry is ONE pass", async () => {
    verdict("echo");

    expect(await tick(36)).toBe("echoSkipped");
    expect(authorings()).toBe(2);
    expect(readAttemptLedger(ledgerPath()).get("36")?.attempts).toBe(1);
  });

  // An expired agent token returns 403 on every delivery. It must leave the day in the gap list (it
  // does) WITHOUT charging the budget — the Worker never read these drafts.
  test("an infra 403 leaves the day a gap and spends NOTHING", async () => {
    verdict("infra403");

    for (let i = 0; i < 6; i += 1) {
      expect(await tick(36)).toBe("gateSkipped");
    }

    expect(readAttemptLedger(ledgerPath()).size).toBe(0);

    verdict("pass");
    expect(await tick(36)).toBe("authored");
  });

  test("a transport/model failure never spends an attempt", async () => {
    verdict("pass");
    claudeVerdict("down");

    for (let i = 0; i < 4; i += 1) {
      expect(await tick(36)).toBe("skipped");
    }

    expect(readAttemptLedger(ledgerPath()).size).toBe(0);

    claudeVerdict("up");
    expect(await tick(36)).toBe("authored");
  });

  test("an exhausted day does not block the OLDEST-FIRST gap list behind it", async () => {
    verdict("voice");

    for (let i = 0; i < MAX_LOGBOOK_ATTEMPTS; i += 1) {
      await tick(12);
    }

    const ledger = readAttemptLedger(ledgerPath());
    const gaps = [gapFor(12), gapFor(13)];
    const { exhausted, work } = selectWork(gaps, ledger, logbookKey, 1, MAX_LOGBOOK_ATTEMPTS);

    expect(exhausted.map((gap) => gap.sector)).toEqual([12]);
    // Without this the logbook would stall on sector 12 forever and never backfill a later day.
    expect(work.map((gap) => gap.sector)).toEqual([13]);

    verdict("pass");
    expect(await authorOne(gapFor(13), [], { ledger, ledgerPath: ledgerPath() })).toBe("authored");
    expect(stores()).toHaveLength(1);
  });
});
