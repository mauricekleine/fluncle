import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAttemptLedger } from "./attempt-ledger";
import { countDistressLines } from "./fluncle-healthcheck";

const RIG = mkdtempSync(join(tmpdir(), "note-sweep-test-"));
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
printf '{"result":"Future Signal at their most patient, and the break still lands late.","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":20},"modelUsage":{}}'
`,
  { mode: 0o755 },
);

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
  if [ "\${NOTE_STUB_QUEUE_PENDING:-0}" = "1" ]; then
    printf '{"code":"due_work_maintenance_pending","message":"Due-work maintenance is still converging","ok":false}\\n'
    exit 1
  fi
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

  test("frames the neighbourhood as SPENT moves, not as a template", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT, NEIGHBORS);

    expect(prompt).toContain("WHAT IS ALREADY TAKEN");
    expect(prompt).toContain("SPENT");
    expect(prompt).toContain("Do not reuse one");

    expect(prompt).toContain("REJECTS a note that lifts a run of words");
  });

  test("omits the neighbourhood block entirely when there is none (the control arm)", () => {
    const prompt = buildAuthoringPrompt(FINDING, CONTEXT, []);

    expect(prompt).not.toContain("THE SONIC NEIGHBOURHOOD");

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

  test("the Worker's due-work deferral of the note queue is an exit-zero paused tick", async () => {
    const proc = Bun.spawn(
      [process.execPath, new URL("./note-sweep.ts", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          CLAUDE_BIN: CLAUDE_STUB,
          FLUNCLE_BIN: FLUNCLE_STUB,
          NOTE_STATE_DIR: STATE_DIR,
          NOTE_STUB_QUEUE_PENDING: "1",
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
      checked: 0,
      errors: 0,
      gateState: "paused",
      ok: true,
      partial: false,
      produced: 0,
      reason: "due_work_repair_pending",
      throttled: true,
    });
  });
});

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

const stores = () => readLines("stores");

const ledgerPath = () => join(STATE_DIR, "attempts");

async function tick(id: string) {
  const ledger = readAttemptLedger(ledgerPath());

  return noteOne({ trackId: id }, false, { ledger, ledgerPath: ledgerPath() });
}

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

    expect((await tick("t-1")).outcome).toBe("exhausted");
    expect(authorings()).toBe(MAX_NOTE_ATTEMPTS);

    for (let i = 0; i < 5; i += 1) {
      expect((await tick("t-1")).outcome).toBe("exhausted");
    }

    expect(authorings()).toBe(MAX_NOTE_ATTEMPTS);
  });

  test("NOTHING is ever stored for a finding whose drafts the gate refused", async () => {
    verdict("voice");

    for (let i = 0; i < MAX_NOTE_ATTEMPTS + 3; i += 1) {
      await tick("t-1");
    }

    expect(stores()).toEqual([]);
  });

  test("an ECHO refusal spends the budget too — its in-tick retry is ONE pass, not a free one", async () => {
    verdict("echo");

    expect((await tick("t-1")).outcome).toBe("echoSkipped");
    expect(authorings()).toBe(2);
    expect(readAttemptLedger(ledgerPath()).get("t-1")?.attempts).toBe(1);

    await tick("t-1");
    expect((await tick("t-1")).outcome).toBe("exhausted");
    expect((await tick("t-1")).outcome).toBe("exhausted");

    expect(authorings()).toBe(MAX_NOTE_ATTEMPTS * 2);
    expect(stores()).toEqual([]);
  });

  test("a partly-spent budget resumes where it left off across ticks", async () => {
    verdict("voice");
    await tick("t-1");
    await tick("t-1");

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

describe("the transport/model failure never spends an attempt", () => {
  beforeEach(() => {
    rmSync(CONTROL, { force: true, recursive: true });
    rmSync(STATE_DIR, { force: true, recursive: true });
    mkdirSync(CONTROL, { recursive: true });
  });

  test("an infra 403 leaves the finding queued and spends NOTHING — no draft was ever judged", async () => {
    verdict("infra403");

    for (let i = 0; i < 6; i += 1) {
      expect((await tick("t-1")).outcome).toBe("gateSkipped");
    }

    expect(readAttemptLedger(ledgerPath()).size).toBe(0);

    verdict("pass");
    expect((await tick("t-1")).outcome).toBe("noted");
  }, 10_000);

  test("a failing `claude -p` leaves the budget untouched, however many ticks it fails for", async () => {
    verdict("pass");
    claudeVerdict("down");

    for (let i = 0; i < 4; i += 1) {
      expect((await tick("t-1")).outcome).toBe("skipped");
    }

    expect(authorings()).toBe(4);
    expect(readAttemptLedger(ledgerPath()).size).toBe(0);

    claudeVerdict("up");
    expect((await tick("t-1")).outcome).toBe("noted");
  });
});

describe("an exhausted finding does not block the cap-1 queue behind it", () => {
  beforeEach(() => {
    rmSync(CONTROL, { force: true, recursive: true });
    rmSync(STATE_DIR, { force: true, recursive: true });
    mkdirSync(CONTROL, { recursive: true });
    claudeVerdict("up");
  });

  test("the tick after exhaustion works the NEXT finding, and that one gets its note", async () => {
    verdict("voice");

    for (let i = 0; i < MAX_NOTE_ATTEMPTS; i += 1) {
      await tick("t-dead");
    }

    const spentAuthorings = authorings();

    const queue = [{ trackId: "t-dead" }, { trackId: "t-live" }];
    const ledger = readAttemptLedger(ledgerPath());
    const { selectWork } = await import("./attempt-ledger");
    const { exhausted, work } = selectWork(queue, ledger, noteKey, 1, MAX_NOTE_ATTEMPTS);

    expect(exhausted.map((row) => row.trackId)).toEqual(["t-dead"]);
    expect(work.map((row) => row.trackId)).toEqual(["t-live"]);

    verdict("pass");
    const result = await noteOne(work[0] ?? {}, false, { ledger, ledgerPath: ledgerPath() });

    expect(result.outcome).toBe("noted");
    expect(authorings()).toBe(spentAuthorings + 1);
    expect(stores()).toHaveLength(1);
  }, 10_000);
});

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
