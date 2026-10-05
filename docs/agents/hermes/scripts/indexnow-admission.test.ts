import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "indexnow.ts");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a full accepted batch crosses admission without exceeding the single-argument limit", () => {
  const directory = mkdtempSync(join(tmpdir(), "indexnow-admission-test-"));
  directories.push(directory);
  const preload = join(directory, "fetch.ts");
  const runner = join(directory, "runner.ts");
  const wrapper = join(directory, "runner.sh");
  const phases = join(directory, "phases.jsonl");
  const ack = join(directory, "ack.json");
  writeFileSync(
    preload,
    `import { writeFileSync } from "node:fs";
const versions = Array.from({ length: 1000 }, (_, index) => ({
  changedAt: "2026-10-05T04:00:00.000Z",
  fingerprint: "f".repeat(32),
  kind: "track",
  subjectId: "00000000-0000-0000-0000-" + String(index).padStart(12, "0"),
}));
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (typeof init?.body !== "string") throw new Error("Missing fixture JSON body");
  const body = JSON.parse(init.body);
  if (url === "https://api.indexnow.org/indexnow") {
    if (body.urlList.length !== 1000 || body.host !== "example.com") throw new Error("Unexpected vendor batch");
    return new Response(null, { status: 202 });
  }
  if (url !== "https://indexnow.invalid/api/v1/admin/indexnow/submit") throw new Error("Unexpected network call: " + url);
  if (body.phase === "walk") return Response.json({ changed: 0, checked: 1000, inserted: 0, kind: "track", next: null, ok: true, phase: "walk", removed: 0 });
  if (body.phase === "claim") return Response.json({ due: 1000, indexNow: { host: "example.com", key: "fixture-key", keyLocation: "https://example.com/key.txt" }, items: versions.map((version) => ({ ...version, url: "https://example.com/track/" + version.subjectId })), ok: true, phase: "claim" });
  if (body.phase === "ack") {
    if (JSON.stringify(body.versions) !== JSON.stringify(versions)) throw new Error("Acknowledgement changed accepted versions");
    writeFileSync(process.env.INDEXNOW_TEST_ACK, init.body);
    return Response.json({ due: 0, ok: true, phase: "ack", stamped: 1000 });
  }
  throw new Error("Unexpected fixture phase");
};
`,
  );
  writeFileSync(
    runner,
    `import { appendFileSync, readFileSync, statSync } from "node:fs";
const runnerArguments = process.argv.slice(2);
if (runnerArguments.some((argument) => Buffer.byteLength(argument) >= 128 * 1024)) {
  console.error("single argument exceeds Linux 128 KiB limit");
  process.exit(1);
}
const boundary = runnerArguments.indexOf("--");
if (boundary < 0) throw new Error("Missing admission command");
const command = runnerArguments.slice(boundary + 1);
const phaseBoundary = command.indexOf("--admission-phase");
const path = command[phaseBoundary + 1];
if (!path) throw new Error("Missing admission request file");
const body = readFileSync(path, "utf8");
appendFileSync(process.env.INDEXNOW_TEST_PHASES, JSON.stringify({ bytes: Buffer.byteLength(body), mode: statSync(path).mode & 0o777, path, phase: JSON.parse(body).phase }) + "\\n");
const result = Bun.spawnSync([command[0], "--preload", process.env.INDEXNOW_TEST_PRELOAD, ...command.slice(1)], { env: { ...process.env, FLUNCLE_ADMISSION_RUNNER_PID: "fixture" }, stderr: "inherit", stdout: "inherit" });
process.exit(result.exitCode ?? 1);
`,
  );
  writeFileSync(
    wrapper,
    '#!/usr/bin/env bash\nexec "$INDEXNOW_TEST_BUN" "$INDEXNOW_TEST_RUNNER" "$@"\n',
  );
  chmodSync(wrapper, 0o700);
  const result = Bun.spawnSync([process.execPath, "--preload", preload, SCRIPT], {
    env: {
      ...process.env,
      DATABASE_ADMISSION_RUNNER: wrapper,
      FLUNCLE_ADMISSION_RUNNER_PID: "",
      FLUNCLE_API_BASE_URL: "https://indexnow.invalid",
      FLUNCLE_API_TOKEN: "fixture-token",
      INDEXNOW_STATE_DIR: join(directory, "state"),
      INDEXNOW_TEST_ACK: ack,
      INDEXNOW_TEST_BUN: process.execPath,
      INDEXNOW_TEST_PHASES: phases,
      INDEXNOW_TEST_PRELOAD: preload,
      INDEXNOW_TEST_RUNNER: runner,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString().trim().split("\n").at(-1) ?? "")).toMatchObject({
    errors: 0,
    produced: 1000,
    queueDepth: 0,
    submitted: 1000,
    vendorCalls: 1,
  });
  expect(JSON.parse(readFileSync(ack, "utf8")).versions).toHaveLength(1000);
  const requests = readFileSync(phases, "utf8")
    .trim()
    .split("\n")
    .map(
      (line) => JSON.parse(line) as { bytes: number; mode: number; path: string; phase: string },
    );
  expect(requests.map((request) => request.phase)).toEqual(["walk", "claim", "ack"]);
  expect(requests.find((request) => request.phase === "ack")?.bytes).toBeGreaterThan(128 * 1024);
  for (const request of requests) {
    expect(request.mode).toBe(0o600);
    expect(existsSync(request.path)).toBe(false);
  }
}, 60_000);
