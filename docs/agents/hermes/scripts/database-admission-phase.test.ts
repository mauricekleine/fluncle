import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markerSignals } from "./fluncle-healthcheck";
import { runDatabaseAdmissionPhase } from "./database-admission-phase";

const SCRIPTS = import.meta.dir;
const ENRICH = join(SCRIPTS, "enrich-sweep.ts");
const ENRICH_WRAPPER = join(SCRIPTS, "enrich-sweep.sh");
const temporaryDirectories: string[] = [];

afterEach(() => {
  delete process.env.DATABASE_ADMISSION_RUNNER;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function executable(path: string, body: string): string {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function rig() {
  const directory = mkdtempSync(join(tmpdir(), "database-admission-phase-"));
  temporaryDirectories.push(directory);
  const timeline = join(directory, "timeline");
  const writes = join(directory, "writes");
  const runner = executable(
    join(directory, "runner"),
    `phase="$1"
owner="$2"
shift 2
if [ "\${1:-}" = "--" ]; then shift; fi
case " $* " in
  *" --admission-phase read "*) label=read ;;
  *" --admission-phase write "*) label=writes ;;
  *) exit 2 ;;
esac
printf 'acquire\\n%s\\n' "$label" >> "${timeline}"
"$@"
status="$?"
printf 'release\\n' >> "${timeline}"
exit "$status"`,
  );
  const fluncle = executable(
    join(directory, "fluncle"),
    `case " $* " in
  *" admin tracks enrich --queue "*) printf '{"tracks":[{"logId":"42","trackId":"track-42"}]}' ;;
  *" tracks get track-42 "*) printf '{"artists":["Calibre"],"isrc":"GBTEST42","logId":"42","title":"Phase Test","trackId":"track-42"}' ;;
  *" admin tracks update track-42 "*) printf 'track-42\\n' >> "${writes}"; printf '{"ok":true}' ;;
  *) printf 'unexpected fluncle call: %s\\n' "$*" >&2; exit 2 ;;
esac`,
  );
  const analyzer = join(directory, "analyze.ts");
  writeFileSync(
    analyzer,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(timeline)}, "external\\n");
console.log(JSON.stringify({ bpm: 174, bpmConfidence: 1, bpmSource: "audio-file", features: {}, key: "8A", keyConfidence: 1, keySource: "audio-file" }));
`,
    "utf8",
  );

  return { analyzer, directory, fluncle, runner, timeline, writes };
}

function baseEnvironment(fixture: ReturnType<typeof rig>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BUN_BIN: process.execPath,
    DATABASE_ADMISSION_RUNNER: fixture.runner,
    FLUNCLE_ANALYZE_SCRIPT: fixture.analyzer,
    FLUNCLE_API_TOKEN: "",
    FLUNCLE_BIN: fixture.fluncle,
    HOME: join(fixture.directory, "home"),
  };
}

describe("phased enrichment", () => {
  test("holds admission around one read window and one write window, not DSP", () => {
    const fixture = rig();
    const result = Bun.spawnSync([process.execPath, ENRICH], {
      env: baseEnvironment(fixture),
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(fixture.timeline, "utf8").trim().split("\n")).toEqual([
      "acquire",
      "read",
      "release",
      "external",
      "acquire",
      "writes",
      "release",
    ]);
    expect(readFileSync(fixture.writes, "utf8").trim()).toBe("track-42");
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      checked: 1,
      done: 1,
      ok: true,
      produced: 1,
    });
  });

  test("exit 75 stops the run, records paused backpressure, and applies no write", () => {
    const fixture = rig();
    executable(
      fixture.runner,
      `shift 2
if [ "\${1:-}" = "--" ]; then shift; fi
case " $* " in
  *" --admission-phase read "*) FLUNCLE_API_TOKEN= "$@" ;;
  *" --admission-phase write "*) exit 75 ;;
  *) exit 2 ;;
esac`,
    );
    const curlLog = join(fixture.directory, "curl-log");
    const fakeBin = join(fixture.directory, "bin");
    Bun.spawnSync(["mkdir", "-p", fakeBin]);
    executable(join(fakeBin, "curl"), `printf '%s\\n' "$*" >> "${curlLog}"`);
    const output = join(fixture.directory, "cron-output");
    const result = Bun.spawnSync(["bash", ENRICH_WRAPPER], {
      env: {
        ...baseEnvironment(fixture),
        FLUNCLE_API_BASE_URL: "https://ledger.invalid",
        FLUNCLE_API_TOKEN: "fixture-token",
        HEALTHCHECK_CRON_OUTPUT_DIR: output,
        PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(() => readFileSync(fixture.writes, "utf8")).toThrow();
    const markerDirectory = join(output, "fluncle-enrich");
    const markerName = readdirSync(markerDirectory).find((name) => name.endsWith(".md"));
    expect(markerName).toBeDefined();
    const marker = readFileSync(join(markerDirectory, markerName ?? ""), "utf8");
    expect(marker).toContain('"admissionOutcome":"phase-yielded"');
    expect(marker).toContain('"gateState":"paused"');
    expect(marker).toContain('"produced":0');
    expect(markerSignals(marker)).toEqual({ backpressure: 1, strain: 0 });
    const ledgerPost = readFileSync(curlLog, "utf8");
    expect(ledgerPost).toContain('"exit_code":0');
    expect(ledgerPost).toContain('\\"gateState\\":\\"paused\\"');
    expect(ledgerPost).toContain('\\"throttled\\":true');
  });
});

describe("bounded phase-yield replay", () => {
  test("retries only when the caller supplies the registry-approved retry budget", () => {
    const directory = mkdtempSync(join(tmpdir(), "database-admission-retry-"));
    temporaryDirectories.push(directory);
    const attempts = join(directory, "attempts");
    const runner = executable(
      join(directory, "runner"),
      `printf 'attempt\\n' >> "${attempts}"
count="$(wc -l < "${attempts}")"
if [ "$count" -eq 1 ]; then exit 75; fi
exit 0`,
    );
    process.env.DATABASE_ADMISSION_RUNNER = runner;

    const safe = runDatabaseAdmissionPhase({
      command: ["true"],
      owner: "fluncle-artist-bio",
      yieldRetries: 1,
    });
    expect(safe).toMatchObject({ attempts: 2, kind: "completed" });

    writeFileSync(attempts, "", "utf8");
    const unsafe = runDatabaseAdmissionPhase({
      command: ["true"],
      owner: "fluncle-enrich",
      yieldRetries: 0,
    });
    expect(unsafe).toEqual({ attempts: 1, kind: "yielded" });
    expect(readFileSync(attempts, "utf8").trim().split("\n")).toEqual(["attempt"]);
  });
});
