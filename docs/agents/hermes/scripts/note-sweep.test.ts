// Unit tests for the pure helpers in note-sweep.ts — the authoring PROMPT (where the
// vibe-neighbour layer actually lives) and the echo-phrase reader that drives the
// re-author pass. The box scripts are self-contained (they cannot import the workspace)
// and live outside any package's test runner, so this file uses `bun:test` and is run
// directly:
//
//   bun test docs/agents/hermes/scripts/note-sweep.test.ts
//
// The layer's RISK is that the neighbours get templated instead of informing, so the
// prompt's anti-sameness instruction is load-bearing product behaviour, not prose — it
// is asserted here, and enforced for real by the Worker's echo gate (which has its own
// tests in apps/web/src/lib/server/note.test.ts).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAttemptLedger } from "./attempt-ledger";
import { countDistressLines } from "./fluncle-healthcheck";

// ── THE STUB RIG ───────────────────────────────────────────────────────────────────────
//
// It has to be on disk and pointed at by env BEFORE the sweep module is evaluated: FLUNCLE_BIN /
// CLAUDE_BIN / NOTE_STATE_DIR are all read at module load. That is why the sweep is imported
// dynamically below (the entity-bio-sweep test's pattern).

const RIG = mkdtempSync(join(tmpdir(), "note-sweep-test-"));
const STATE_DIR = join(RIG, "state");
const CONTROL = join(RIG, "control");
const FLUNCLE_STUB = join(RIG, "fluncle");
const CLAUDE_STUB = join(RIG, "claude");

mkdirSync(CONTROL, { recursive: true });

// A stub `claude -p`: consumes the prompt on stdin, records the invocation, and emits the real JSON
// envelope shape. `claude-verdict: down` makes it fail the way a flaky model does — a non-zero exit
// with no draft, which must NOT cost the finding an attempt.
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
printf '{"result":"Future Signal at their most patient, and the break still lands late.","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":20},"modelUsage":{}}'
`,
  { mode: 0o755 },
);

// A stub `fluncle`: answers the three gather reads, and answers `admin tracks note` according to
// the verdict file — so a test can say "the gate refuses every draft" and watch what the sweep
// does. It records every delivery, and every delivery it ACCEPTED (i.e. actually stored a note).
writeFileSync(
  FLUNCLE_STUB,
  `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "tracks" ] && [ "\${2:-}" = "get" ]; then
  if [ "\${NOTE_STUB_TRACK_GET_FAIL:-0}" = "1" ]; then
    printf 'track read failed\\n' >&2
    exit 1
  fi
  printf '{"track":{"artists":["Future Signal"],"title":"Fractals","logId":"011.5.9D","trackId":"t-1"}}'
  exit 0
fi
if [ "\${1:-}" = "tracks" ] && [ "\${2:-}" = "similar" ]; then
  printf '{"findings":[]}'
  exit 0
fi
if [ "\${1:-}" = "admin" ] && [ "\${3:-}" = "context" ]; then
  printf '{"contextNote":"A 2016 single."}'
  exit 0
fi
if [ "\${1:-}" = "admin" ] && [ "\${2:-}" = "tracks" ] && [ "\${3:-}" = "note" ] && [ "\${4:-}" = "--queue" ]; then
  if [ "\${NOTE_STUB_QUEUE_FAIL:-0}" = "1" ]; then
    printf 'queue read failed\\n' >&2
    exit 1
  fi
  printf '{"ok":true,"tracks":[]}'
  exit 0
fi
printf '%s\\n' "\${4:-?}" >> "${CONTROL}/deliveries"
verdict="$(cat "${CONTROL}/verdict" 2>/dev/null || printf 'pass')"
if [ "$verdict" = "infra403" ]; then
  printf 'error: request failed with 403 forbidden\\n' >&2
  exit 1
fi
if [ "$verdict" = "voice" ]; then
  printf 'error: The note fails the voice gate: banned identity word "signal" [voice_gate 422]\\n' >&2
  exit 1
fi
if [ "$verdict" = "echo" ]; then
  printf 'error: note_echoes_neighbours: it lifts "the break still lands late" straight from 012.1.0A [422]\\n' >&2
  exit 1
fi
printf '%s\\n' "\${4:-?}" >> "${CONTROL}/stores"
printf '{"ok":true,"logId":"011.5.9D"}'
`,
  { mode: 0o755 },
);

chmodSync(CLAUDE_STUB, 0o755);
chmodSync(FLUNCLE_STUB, 0o755);

process.env["CLAUDE_BIN"] = CLAUDE_STUB;
process.env["FLUNCLE_BIN"] = FLUNCLE_STUB;
process.env["NOTE_STATE_DIR"] = STATE_DIR;
// No agent token, so `resolveSweepPrompt` falls back to the baked builder and reaches no network.
delete process.env["FLUNCLE_API_TOKEN"];

const {
  buildAuthoringPrompt,
  MAX_NOTE_ATTEMPTS,
  noteKey,
  noteOne,
  readEchoedPhrase,
}: typeof import("./note-sweep") = await import("./note-sweep");

type Neighbor = import("./note-sweep").Neighbor;

afterAll(() => {
  rmSync(RIG, { force: true, recursive: true });
});

const FINDING = {
  artists: ["Whiney"],
  bpm: 174.02,
  key: "F minor",
  label: "Med School",
  logId: "011.5.9D",
  releaseDate: "2016-03-11",
  title: "Nightfall",
};

const CONTEXT = "Whiney's Nightfall is a 2016 single on Med School.\n\nTexture: deep, nocturnal.";

const NEIGHBORS: Neighbor[] = [
  {
    artists: ["Krakota"],
    logId: "012.2.4L",
    note: "Liquid roller with nocturnal depth; I've been rewinding this Krakota banger since 2018.",
    title: "See For Miles",
  },
  {
    artists: ["GLXY"],
    logId: "012.1.0A",
    note: "Liquid and introspective; GLXY dropped this in 2015 and my shoulders still follow.",
    title: "It's Whatever",
  },
];

describe("buildAuthoringPrompt", () => {
  test("carries the context note as the primary fuel", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT);

    expect(prompt).toContain("CONTEXT NOTE");
    expect(prompt).toContain("Texture: deep, nocturnal.");
  });

  test("grounds the note in the AUDIO too (bpm + key, alongside the galaxy)", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT);

    expect(prompt).toContain("bpm: 174");
    expect(prompt).toContain("key: F minor");
  });

  test("lays out the sonic neighbourhood with each neighbour's standing note", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT, NEIGHBORS);

    expect(prompt).toContain("THE SONIC NEIGHBOURHOOD");
    expect(prompt).toContain("Krakota — See For Miles");
    expect(prompt).toContain("my shoulders still follow");
  });

  // THE GUARDRAIL. The neighbours are shown as a list of what is TAKEN, never as a
  // template to match. If this instruction ever softens, the layer starts homogenising
  // the voice — which is the one outcome that makes it a net negative.
  test("frames the neighbourhood as SPENT moves, not as a template", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT, NEIGHBORS);

    expect(prompt).toContain("WHAT IS ALREADY TAKEN");
    expect(prompt).toContain("SPENT");
    expect(prompt).toContain("Do not reuse one");
    // It tells the model the rejection is real, so the constraint has teeth.
    expect(prompt).toContain("REJECTS a note that lifts a run of words");
  });

  test("omits the neighbourhood block entirely when there is none (the control arm)", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT, []);

    expect(prompt).not.toContain("THE SONIC NEIGHBOURHOOD");
    // …and it is still a complete, authorable prompt.
    expect(prompt).toContain("CONTEXT NOTE");
    expect(prompt).toContain("Output ONLY the note text.");
  });

  test("hands the model its own echo back on the re-author pass", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT, NEIGHBORS, "my shoulders dropped before");

    expect(prompt).toContain("YOUR LAST ATTEMPT WAS REJECTED");
    expect(prompt).toContain("my shoulders dropped before");
  });
});

describe("readEchoedPhrase", () => {
  test("pulls the lifted phrase out of the Worker's rejection", () => {
    const message =
      '{"code":"note_echoes_neighbours","message":"The note echoes its sonic neighbourhood: it lifts \\"my shoulders dropped before\\" straight from 027.2.8R."}';

    expect(readEchoedPhrase(message)).toBe("my shoulders dropped before");
  });

  test("returns undefined for an overlap rejection (no phrase was lifted)", () => {
    const message = "note_echoes_neighbours: it reuses 34% of 012.1.0A's words";

    expect(readEchoedPhrase(message)).toBeUndefined();
  });
});

describe("note sweep run-error vocabulary", () => {
  test("an ordinary dry-run item failure reports errors:0 and failed:1", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        new URL("./note-sweep.ts", import.meta.url).pathname,
        "--dry-run",
        "011.5.9D",
      ],
      {
        env: {
          ...process.env,
          CLAUDE_BIN: CLAUDE_STUB,
          FLUNCLE_BIN: FLUNCLE_STUB,
          NOTE_STATE_DIR: STATE_DIR,
          NOTE_STUB_TRACK_GET_FAIL: "1",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      checked: 1,
      errors: 0,
      failed: 1,
      ok: true,
    });
  });

  test("a genuine note run failure reports errors:1 and exits non-zero", async () => {
    const proc = Bun.spawn(
      [process.execPath, new URL("./note-sweep.ts", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          CLAUDE_BIN: CLAUDE_STUB,
          FLUNCLE_BIN: FLUNCLE_STUB,
          NOTE_STATE_DIR: STATE_DIR,
          NOTE_STUB_QUEUE_FAIL: "1",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      errors: 1,
      ok: false,
      reason: "sweep_error",
    });
  });
});

// ── THE ATTEMPT BUDGET, END TO END ─────────────────────────────────────────────────────
//
// `noteOne` driven against the stub `fluncle` + `claude` binaries, with the ledger on disk. Each
// `tick()` is a separate call that reads the ledger back off disk first — which is what a real cron
// tick is: a fresh process that remembers nothing except what was written down.
//
// The bug: a gate rejection left the finding queued with nothing counting the tries, so "retry"
// meant "forever" — and the rejection could be UNSATISFIABLE, because the gate scanned the
// finding's own artist name while the prompt invited naming it. THE NAME EXEMPTION fixes that
// case; this budget bounds every other one.

function verdict(value: "pass" | "voice" | "echo" | "infra403"): void {
  writeFileSync(join(CONTROL, "verdict"), value, "utf8");
}

/** `down` = `claude -p` exits non-zero with no draft, the flaky-model case. */
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

/** How many times the model was actually called. */
const authorings = () => readLines("authorings").length;
/** How many notes were actually STORED — the number that must stay 0 for a refused finding. */
const stores = () => readLines("stores");

const ledgerPath = () => join(STATE_DIR, "attempts");

/** One cron tick over one finding: reload the ledger off disk, run the REAL loop, persist. */
async function tick(id: string) {
  const ledger = readAttemptLedger(ledgerPath());

  return noteOne({ trackId: id }, false, { ledger, ledgerPath: ledgerPath() });
}

/** Run one tick with stderr captured, and score it with the REAL /status strain detector. */
async function tickWithStrain(id: string): Promise<{ lines: string[]; strain: number }> {
  const lines: string[] = [];
  const original = console.error;

  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  try {
    await tick(id);
  } finally {
    console.error = original;
  }

  // This helper runs exactly one work item, so its real `checked` denominator is one.
  return { lines, strain: countDistressLines(lines.join("\n"), 1) };
}

describe("noteOne (the bounded re-author, across ticks)", () => {
  beforeEach(() => {
    rmSync(CONTROL, { force: true, recursive: true });
    rmSync(STATE_DIR, { force: true, recursive: true });
    mkdirSync(CONTROL, { recursive: true });
    claudeVerdict("up");
  });

  test("a gate-PASSING finding is authored once and leaves no budget behind", async () => {
    verdict("pass");

    const result = await tick("t-1");

    expect(result.outcome).toBe("noted");
    expect(authorings()).toBe(1);
    expect(stores()).toHaveLength(1);
    expect(readAttemptLedger(ledgerPath()).size).toBe(0);
  });

  test("a gate-REFUSING finding is authored for at most three passes, then never again", async () => {
    verdict("voice");

    for (let i = 1; i < MAX_NOTE_ATTEMPTS; i += 1) {
      expect((await tick("t-1")).outcome).toBe("gateSkipped");
    }

    // The third refusal is the one that spends the budget, and it reports the terminal outcome.
    expect((await tick("t-1")).outcome).toBe("exhausted");
    expect(authorings()).toBe(MAX_NOTE_ATTEMPTS);

    // Five more ticks, zero more model calls. This is the whole point of the slice.
    for (let i = 0; i < 5; i += 1) {
      expect((await tick("t-1")).outcome).toBe("exhausted");
    }

    expect(authorings()).toBe(MAX_NOTE_ATTEMPTS);
  });

  // THE OPERATOR'S RULING (2026-07-30), and the one place the siblings differ from the bio sweep:
  // there is NO final-attempt bypass. A note is optional editorial and an absent one is a good
  // state, so gate-failed copy is never published to close a queue.
  test("NOTHING is ever stored for a finding whose drafts the gate refused", async () => {
    verdict("voice");

    for (let i = 0; i < MAX_NOTE_ATTEMPTS + 3; i += 1) {
      await tick("t-1");
    }

    expect(stores()).toEqual([]);
  });

  test("an ECHO refusal spends the budget too — its in-tick retry is ONE pass, not a free one", async () => {
    verdict("echo");

    // `ECHO_RETRIES` gives each pass two authorings; the pass still costs exactly one attempt.
    expect((await tick("t-1")).outcome).toBe("echoSkipped");
    expect(authorings()).toBe(2);
    expect(readAttemptLedger(ledgerPath()).get("t-1")?.attempts).toBe(1);

    await tick("t-1");
    expect((await tick("t-1")).outcome).toBe("exhausted");
    expect((await tick("t-1")).outcome).toBe("exhausted");

    // Six authorings across the three passes, and then it stops. Never seven.
    expect(authorings()).toBe(MAX_NOTE_ATTEMPTS * 2);
    expect(stores()).toEqual([]);
  });

  test("a partly-spent budget resumes where it left off across ticks", async () => {
    verdict("voice");
    await tick("t-1");
    await tick("t-1");

    // A fresh "process" reads the two spent attempts off disk and has exactly one left.
    expect((await tick("t-1")).outcome).toBe("exhausted");
  });

  test("a landed note CLEARS the budget, so a re-queued finding starts fresh", async () => {
    verdict("voice");
    await tick("t-1");
    verdict("pass");
    await tick("t-1");

    expect(readAttemptLedger(ledgerPath()).size).toBe(0);
  });

  test("a DRY RUN spends no budget — the operator pre-flight is not an attempt", async () => {
    verdict("voice");

    await noteOne({ trackId: "t-1" }, true);

    expect(() => readFileSync(ledgerPath(), "utf8")).toThrow();
  });
});

// ONLY A REFUSAL MAY SPEND THE BUDGET. A gate rejection is deterministic evidence that THIS DRAFT
// was bad. A transport/model failure is no evidence about the draft at all — there is no draft. If
// flaky infrastructure could spend the budget, three bad minutes would write a finding off forever.

describe("the transport/model failure never spends an attempt", () => {
  beforeEach(() => {
    rmSync(CONTROL, { force: true, recursive: true });
    rmSync(STATE_DIR, { force: true, recursive: true });
    mkdirSync(CONTROL, { recursive: true });
  });

  // THE 403 CASE, and it is the one that would actually have bitten. An expired or re-scoped agent
  // token returns 403 on EVERY delivery. The skip classifier matches a bare "403"/"forbidden" so the
  // finding correctly stays queued — but if that also CHARGED the budget, a sustained token outage
  // would march down a cap-1 queue writing off one healthy finding per few ticks, each recoverable
  // only by hand-editing the box's attempts file. The Worker never read these drafts.
  test("an infra 403 leaves the finding queued and spends NOTHING — no draft was ever judged", async () => {
    verdict("infra403");

    for (let i = 0; i < 6; i += 1) {
      expect((await tick("t-1")).outcome).toBe("gateSkipped");
    }

    // Six refused deliveries, and the finding has not spent a single attempt.
    expect(readAttemptLedger(ledgerPath()).size).toBe(0);

    // …so it still gets its FULL budget once the token is fixed.
    verdict("pass");
    expect((await tick("t-1")).outcome).toBe("noted");
  });

  test("a failing `claude -p` leaves the budget untouched, however many ticks it fails for", async () => {
    verdict("pass");
    claudeVerdict("down");

    for (let i = 0; i < 4; i += 1) {
      expect((await tick("t-1")).outcome).toBe("skipped");
    }

    expect(authorings()).toBe(4);
    expect(readAttemptLedger(ledgerPath()).size).toBe(0);

    // …so the finding still gets its FULL budget once the model comes back.
    claudeVerdict("up");
    expect((await tick("t-1")).outcome).toBe("noted");
  });
});

// ── THE HEAD-OF-LINE RULE, END TO END ──────────────────────────────────────────────────
//
// The budget alone is not the fix. The queue is BATCH_CAP=1 over an oldest-first worklist, so a
// spent head must be stepped over or the sweep stalls on it forever and nothing behind it is ever
// noted — an unbounded retry loop traded for a permanent stall.

describe("an exhausted finding does not block the cap-1 queue behind it", () => {
  beforeEach(() => {
    rmSync(CONTROL, { force: true, recursive: true });
    rmSync(STATE_DIR, { force: true, recursive: true });
    mkdirSync(CONTROL, { recursive: true });
    claudeVerdict("up");
  });

  test("the tick after exhaustion works the NEXT finding, and that one gets its note", async () => {
    verdict("voice");

    // Burn the head finding's whole budget.
    for (let i = 0; i < MAX_NOTE_ATTEMPTS; i += 1) {
      await tick("t-dead");
    }

    const spentAuthorings = authorings();
    // The live queue the next tick reads: the dead finding is STILL at the head (the server has no
    // idea it is unwritable — it simply has no note), with a fresh finding behind it.
    const queue = [{ trackId: "t-dead" }, { trackId: "t-live" }];
    const ledger = readAttemptLedger(ledgerPath());
    const { selectWork } = await import("./attempt-ledger");
    const { exhausted, work } = selectWork(queue, ledger, noteKey, 1, MAX_NOTE_ATTEMPTS);

    expect(exhausted.map((row) => row.trackId)).toEqual(["t-dead"]);
    expect(work.map((row) => row.trackId)).toEqual(["t-live"]);

    // …and the finding behind it is genuinely worked, not merely selected.
    verdict("pass");
    const result = await noteOne(work[0] ?? {}, false, { ledger, ledgerPath: ledgerPath() });

    expect(result.outcome).toBe("noted");
    expect(authorings()).toBe(spentAuthorings + 1);
    expect(stores()).toHaveLength(1);
  });
});

// ── THE STRAIN VOCABULARY ──────────────────────────────────────────────────────────────
//
// This sweep's stderr is captured into its cron marker and scored by the /status detector, so the
// WORDING of these logs is load-bearing. These run the REAL loop and score the REAL lines.

describe("what the sweep's logs say to the /status strain detector", () => {
  beforeEach(() => {
    rmSync(CONTROL, { force: true, recursive: true });
    rmSync(STATE_DIR, { force: true, recursive: true });
    mkdirSync(CONTROL, { recursive: true });
    claudeVerdict("up");
  });

  test("a clean authoring tick reads as ZERO strain", async () => {
    verdict("pass");

    expect((await tickWithStrain("t-1")).strain).toBe(0);
  });

  test("EXHAUSTING a finding DOES read as strain — it is a permanent write-off", async () => {
    verdict("voice");
    await tick("t-1");
    await tick("t-1");

    const { lines, strain } = await tickWithStrain("t-1");

    expect(lines.join("\n")).toContain("EXHAUSTED");
    expect(strain).toBeGreaterThan(0);
  });
});
