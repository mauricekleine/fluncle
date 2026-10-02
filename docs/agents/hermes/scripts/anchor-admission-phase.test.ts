import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { markerSignals } from "./fluncle-healthcheck";

const SCRIPT = join(import.meta.dir, "anchor-sweep.sh");
const temporaryDirectories: string[] = [];
const servers: Subprocess[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.kill();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("anchor fixture did not reach the expected state");
    }
    await Bun.sleep(10);
  }
}

async function rig(options: { paid?: boolean; pausePortWrite?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "anchor-admission-phase-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "actor-list-clock"), String(Date.now()));
  if (options.paid) {
    writeFileSync(join(directory, "paid-mode"), "1");
  }
  const serverPath = join(directory, "server.ts");
  writeFileSync(
    serverPath,
    `import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.argv[2] ?? "";
const at = (name: string) => join(directory, name);
const json = (body: unknown) => Response.json(body);
const server = Bun.serve({ port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/catalogue/anchor/breaker")) return json({ rungs: { apifyBudget: { remainingRows: 300, spent: false }, apifyEnabled: !existsSync(at("apify-disabled")), gateReason: "open", spotifySearchEnabled: true } });
  if (path.endsWith("/tracks/work")) {
    appendFileSync(at("timeline"), "worklist-read\\n");
    if (existsSync(at("paid-mode"))) {
      const ids = existsSync(at("single-paid-row")) ? ["track-1"] : ["track-1", "track-2"];
      const tracks = ids.filter((trackId) => !existsSync(at("reported-" + trackId))).map((trackId) => ({ anchorQuery: "query-" + trackId, trackId }));
      return json({ queued: tracks.length, tracks });
    }
    return json({ queued: existsSync(at("committed")) ? 0 : 1, tracks: existsSync(at("committed")) ? [] : [{ anchorQuery: "Test Anchor", trackId: "track-1" }] });
  }
  if (path.endsWith("/catalogue/anchor/prepares")) {
    const body = await request.json() as { items: { trackId: string }[] };
    appendFileSync(at("timeline"), "prepare-batch:" + body.items.map((item) => item.trackId).join(",") + "\\n");
    if (existsSync(at("race-checkpoint-track-1"))) {
      const progress = at("paid-progress");
      mkdirSync(progress, { recursive: true });
      const name = createHash("sha256").update("track-1").digest("hex") + ".json";
      writeFileSync(join(progress, name), JSON.stringify({ anchorQuery: "saved-query", createdAt: Date.now(), evidence: "saved-evidence", paidResultToken: "saved-token", prepared: "saved-prepared", stage: "actor_started", trackId: "track-1" }));
    }
    return json({ ok: true, items: body.items.map((item) => ({ trackId: item.trackId, status: "done", prepared: "prepared:" + item.trackId, receiptAt: "receipt:" + item.trackId, elapsedMs: 1 })) });
  }
  if (path.endsWith("/catalogue/anchor/prepare")) {
    if (existsSync(at("paid-mode"))) {
      const body = await request.json() as { trackId: string };
      return json({ ok: true, prepared: "prepared:" + body.trackId, receiptAt: "receipt:" + body.trackId });
    }
    return json({ ok: true, prepared: "prepared-1" });
  }
  if (path.endsWith("/catalogue/anchor/candidates/resolve")) {
    appendFileSync(at("timeline"), "probe-start\\n");
    appendFileSync(at("timeline"), readFileSync(at("lease"), "utf8") === "free" ? "probe-free\\n" : "probe-held\\n");
    await Bun.sleep(existsSync(at("paid-mode")) ? 10 : 700);
    appendFileSync(at("timeline"), "probe-end\\n");
    if (existsSync(at("paid-mode"))) {
      const body = await request.json() as { prepared: string };
      return json({ ok: true, evidence: "evidence:" + body.prepared });
    }
    return json({ ok: true, evidence: "evidence-1" });
  }
  if (path.endsWith("/catalogue/anchor/commits")) {
    const body = await request.json() as { items: { allowPaid?: boolean; prepared: string; trackId: string }[] };
    appendFileSync(at("timeline"), "commit-batch:" + body.items.map((item) => item.trackId).join(",") + "\\n");
    return json({ ok: true, items: body.items.map((item) => {
      const trackId = item.trackId;
      if (!existsSync(at("paid-mode"))) {
        writeFileSync(at("committed"), "1");
        return { trackId, status: "done", anchored: true, apifyEligible: false, paidReceiptPending: false, source: "spotify-isrc", spotifyIsrcAsked: true, spotifySearchDone: true, verifiedBy: "isrc", elapsedMs: 1 };
      }
      if (existsSync(at("free-batch"))) {
        writeFileSync(at("reported-" + trackId), "1");
        return { trackId, status: "done", anchored: true, apifyEligible: false, paidReceiptPending: false, source: "spotify-isrc", verifiedBy: "isrc", elapsedMs: 1 };
      }
      if (trackId === "track-1" && existsSync(at("commit-409-track-1"))) {
        appendFileSync(at("timeline"), "rejected-commit:" + trackId + "\\n");
        return { trackId, status: "error", httpStatus: 409, error: "row changed", elapsedMs: 1 };
      }
      if (trackId === "track-1" && existsSync(at("commit-503-track-1"))) {
        appendFileSync(at("timeline"), "ambiguous-commit:" + trackId + "\\n");
        if (existsSync(at("charged-commit-503-track-1"))) writeFileSync(at("paid-commit-" + trackId), "1");
        return { trackId, status: "error", error: "uncertain commit", elapsedMs: 1 };
      }
      if (trackId === "track-1" && existsSync(at("batch-anchored-paid"))) {
        writeFileSync(at("paid-commit-" + trackId), "1");
        return { trackId, status: "done", anchored: true, apifyEligible: false, ...(existsSync(at("legacy-verdict")) ? {} : { paidReceiptPending: true }), source: "spotify-isrc", verifiedBy: "isrc", elapsedMs: 1 };
      }
      if (trackId === "track-2" && existsSync(at("batch-defer-track-2"))) {
        appendFileSync(at("timeline"), "batch-deferred:" + trackId + "\\n");
        return { trackId, status: "deferred", elapsedMs: 1 };
      }
      if (item.allowPaid === false) {
        appendFileSync(at("timeline"), "free-commit:" + trackId + "\\n");
        writeFileSync(at("reported-" + trackId), "1");
        return { trackId, status: "done", anchored: true, apifyEligible: false, paidReceiptPending: false, source: "spotify-isrc", spotifyIsrcAsked: true, spotifySearchDone: true, verifiedBy: "isrc", elapsedMs: 1 };
      }
      appendFileSync(at("timeline"), "paid-commit:" + trackId + "\\n");
      writeFileSync(at("paid-commit-" + trackId), "1");
      return { trackId, status: "done", anchored: false, apifyEligible: true, apifyEnabled: true, paidReceiptPending: true, paidResultToken: "result:" + trackId, spotifySearchDone: true, verifiedBy: null, elapsedMs: 1 };
    }) });
  }
  if (path.endsWith("/catalogue/anchor/commit")) {
    if (existsSync(at("paid-mode"))) {
      const body = await request.json() as { allowPaid?: boolean; prepared: string };
      const trackId = body.prepared.replace("prepared:", "");
      if (trackId === "track-1" && existsSync(at("commit-409-track-1"))) {
        appendFileSync(at("timeline"), "rejected-commit:" + trackId + "\\n");
        return new Response("row changed", { status: 409 });
      }
      if (trackId === "track-1" && existsSync(at("commit-503-track-1"))) {
        appendFileSync(at("timeline"), "ambiguous-commit:" + trackId + "\\n");
        return new Response("uncertain commit", { status: 503 });
      }
      if (trackId === "track-1" && existsSync(at("commit-replay-anchored"))) {
        appendFileSync(at("timeline"), "replay-anchored:" + trackId + "\\n");
        return json({ anchored: true, apifyEligible: false, ...(existsSync(at("legacy-verdict")) ? {} : { paidReceiptPending: true }), source: "spotify-isrc", verifiedBy: "isrc" });
      }
      if (trackId === "track-1" && existsSync(at("single-anchored-paid"))) {
        writeFileSync(at("paid-commit-" + trackId), "1");
        return json({ anchored: true, apifyEligible: false, paidReceiptPending: true, source: "spotify-isrc", verifiedBy: "isrc" });
      }
      if (body.allowPaid === false) {
        if (existsSync(at("paid-commit-" + trackId))) {
          appendFileSync(at("timeline"), "replay-paid-no-charge:" + trackId + "\\n");
          return json({ anchored: false, apifyEligible: true, apifyEnabled: !existsSync(at("apify-disabled")), paidReceiptPending: true, paidResultToken: existsSync(at("apify-disabled")) ? undefined : "result:" + trackId, spotifySearchDone: true, verifiedBy: null });
        }
        appendFileSync(at("timeline"), "free-commit:" + trackId + "\\n");
        writeFileSync(at("reported-" + trackId), "1");
        return json({ anchored: true, apifyEligible: false, paidReceiptPending: false, source: "spotify-isrc", spotifyIsrcAsked: true, spotifySearchDone: true, verifiedBy: "isrc" });
      }
      appendFileSync(at("timeline"), "paid-commit:" + trackId + "\\n");
      return json({ anchored: false, apifyEligible: true, apifyEnabled: !existsSync(at("apify-disabled")), paidReceiptPending: true, paidResultToken: existsSync(at("apify-disabled")) ? undefined : "result:" + trackId, spotifySearchDone: true, verifiedBy: null });
    }
    writeFileSync(at("committed"), "1");
    return json({ anchored: true, apifyEligible: false, source: "spotify-isrc", spotifyIsrcAsked: true, spotifySearchDone: true, verifiedBy: "isrc" });
  }
  if (path.endsWith("/catalogue/anchor/failure")) {
    const body = await request.json() as { trackId: string };
    appendFileSync(at("timeline"), "failure:" + body.trackId + "\\n");
    writeFileSync(at("reported-" + body.trackId), "1");
    return json({ terminal: true });
  }
  if (path.endsWith("/catalogue/anchor/receipt")) {
    const body = await request.json() as { trackId: string };
    appendFileSync(at("timeline"), "receipt-read:" + body.trackId + "\\n");
    const admitted = existsSync(at("paid-commit-" + body.trackId));
    return json({ ok: true, admitted, paidState: admitted ? existsSync(at("reported-" + body.trackId)) ? "settled" : "pending" : null });
  }
  if (path.endsWith("/catalogue/anchor/paid-result/token")) {
    const body = await request.json() as { trackId: string };
    appendFileSync(at("timeline"), "token-refresh:" + body.trackId + "\\n");
    return json({ ok: true, paidResultToken: "fresh-result:" + body.trackId });
  }
  if (path.endsWith("/catalogue/anchor/paid-result/cancel")) {
    const body = await request.json() as { refundCap?: boolean; trackId: string };
    appendFileSync(at("timeline"), "cancel-paid:" + body.trackId + "\\n");
    if (body.refundCap) appendFileSync(at("timeline"), "refund-paid:" + body.trackId + "\\n");
    if (existsSync(at("cancel-refuse"))) return new Response("receipt changed", { status: 409 });
    if (existsSync(at("backoff-on-cancel"))) writeFileSync(at("reported-" + body.trackId), "1");
    return json({ ok: true, settled: true });
  }
  if (path.endsWith("/catalogue/anchor/paid-result/resolve")) {
    const body = await request.json() as { trackId: string };
    appendFileSync(at("timeline"), "resolve-paid:" + body.trackId + "\\n");
    if (existsSync(at("resolve-refuse"))) return new Response("receipt still pending", { status: 409 });
    writeFileSync(at("reported-" + body.trackId), "1");
    return json({ ok: true, reason: "settled" });
  }
  if (path.endsWith("/catalogue/anchor")) {
    const body = await request.json() as { paidResultToken?: string; trackId: string };
    appendFileSync(at("timeline"), "report:" + body.trackId + "\\n");
    if (body.paidResultToken) appendFileSync(at("timeline"), "token-used:" + body.paidResultToken + "\\n");
    if (existsSync(at("report-invalid"))) return new Response("invalid", { status: 400 });
    if (existsSync(at("report-gone"))) return new Response("already changed", { status: 409 });
    writeFileSync(at("reported-" + body.trackId), "1");
    return json({ anchored: true, verifiedBy: "isrc" });
  }
  if ((path.includes("/v2/acts/") || path.includes("/v2/actors/")) && path.endsWith("/runs")) {
    if (request.method === "GET") {
      appendFileSync(at("timeline"), "actor-list\\n");
      const search = new URL(request.url).searchParams;
      const now = Number(readFileSync(at("actor-list-clock"), "utf8"));
      const recent = existsSync(at("actor-list-overflow")) ? Array.from({ length: 51 }, (_, index) => ({ id: "run-overflow-" + index, startedAt: new Date(now - index).toISOString() })) : existsSync(at("actor-list-many")) ? Array.from({ length: 26 }, (_, index) => ({ id: "run-other-" + index, startedAt: new Date(now - index).toISOString() })) : [];
      const matches = existsSync(at("actor-list-match")) ? [{ id: "run-ambiguous", startedAt: new Date(existsSync(at("actor-clock-behind-19m")) ? now - 19 * 60_000 : existsSync(at("actor-clock-behind")) ? now - 30_000 : now).toISOString() }] : [];
      if (existsSync(at("actor-list-double-match"))) matches.push({ id: "run-earlier", startedAt: new Date(now - 10_000).toISOString() });
      const old = existsSync(at("actor-list-history")) ? Array.from({ length: 60 }, (_, index) => ({ id: "run-old-" + index, startedAt: new Date(now - 60 * 60_000 - index).toISOString() })) : [];
      const items = [...recent, ...matches, ...old].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
      const offset = Number(search.get("offset") ?? 0);
      const limit = Number(search.get("limit") ?? items.length);
      return json({ data: { count: items.length, items: items.slice(offset, offset + limit), total: items.length } });
    }
    const body = await request.json() as { tracks: string[] };
    appendFileSync(at("timeline"), "actor-run:" + body.tracks.join(",") + "\\n");
    if (existsSync(at("actor-start-fail"))) return new Response("actor did not start", { status: 400 });
    if (existsSync(at("actor-start-429"))) return new Response("actor rate limited", { status: 429 });
    if (existsSync(at("actor-start-503"))) return new Response("actor outcome unknown", { status: 503 });
    const runId = "run-" + String(existsSync(at("actor-count")) ? Number(readFileSync(at("actor-count"), "utf8")) + 1 : 1);
    writeFileSync(at("actor-count"), runId.replace("run-", ""));
    return json({ data: { id: runId, status: "READY" } });
  }
  if (path.includes("/v2/actor-runs/") && path.endsWith("/key-value-store/records/INPUT")) {
    appendFileSync(at("timeline"), "actor-input\\n");
    if (path.includes("run-other-") && existsSync(at("actor-unrelated-input-fail"))) return new Response("unreadable", { status: 503 });
    if (path.includes("run-other-") || path.includes("run-old-")) return json({ tracks: ["other-query"] });
    return json({ tracks: existsSync(at("actor-input-mismatch")) ? ["other-query"] : existsSync(at("actor-input-two")) ? ["query-track-1", "query-track-2"] : ["query-track-1"] });
  }
  if (path.includes("/v2/actor-runs/") && path.endsWith("/dataset/items")) return json([]);
  if (path.includes("/v2/actor-runs/")) {
    appendFileSync(at("timeline"), "actor-poll:" + path.split("/").at(-1) + "\\n");
    if (existsSync(at("actor-poll-hold"))) await Bun.sleep(900);
    if (existsSync(at("actor-fail"))) return new Response("unknown actor outcome", { status: 502 });
    if (existsSync(at("actor-run-gone"))) return new Response("run not found", { status: 404 });
    if (existsSync(at("actor-terminal"))) return json({ data: { status: "FAILED" } });
    if (existsSync(at("actor-running"))) return json({ data: { status: "RUNNING" } });
    return json({ data: { status: "SUCCEEDED" } });
  }
  if (path.endsWith("/telemetry/runs")) return json({ ok: true });
  return new Response("unknown fixture path", { status: 404 });
}});
writeFileSync(at("port.tmp"), String(server.port));
renameSync(at("port.tmp"), at("port"));
`,
  );
  const preload = join(directory, "pause-port-write.cjs");
  if (options.pausePortWrite) {
    writeFileSync(
      preload,
      `const fs = require("node:fs");
const original = fs.writeFileSync;
fs.writeFileSync = function (path, data, ...args) {
  if (typeof path === "string" && /\\/port(?:\\.tmp)?$/.test(path)) {
    const fd = fs.openSync(path, "w");
    original(${JSON.stringify(join(directory, "port-write-started"))}, "1");
    while (!fs.existsSync(${JSON.stringify(join(directory, "release-port-write"))})) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    try { return original(fd, data, ...args); }
    finally { fs.closeSync(fd); }
  }
  return original(path, data, ...args);
};
`,
    );
  }
  const server = Bun.spawn(
    [
      process.execPath,
      ...(options.pausePortWrite ? ["--preload", preload] : []),
      serverPath,
      directory,
    ],
    {
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  servers.push(server);
  await until(() => existsSync(join(directory, "port")));
  const baseUrl = `http://127.0.0.1:${readFileSync(join(directory, "port"), "utf8")}`;
  writeFileSync(join(directory, "lease"), "free");
  const runner = join(directory, "runner");
  executable(
    runner,
    `owner="$2"
shift 2
if [ "\${1:-}" = "--" ]; then shift; fi
state="\${*: -1}"
if [ "$owner" = "fluncle-anchor" ] && [ -f "${directory}/yield-commit" ] && grep -q '/api/v1/admin/catalogue/anchor/commits' "$state"; then
  printf '{"event":"database.admission.runner","yield_reason":"queue"}\\n' >&2
  exit 75
fi
if [ "$owner" = "fluncle-anchor" ] && [ -f "${directory}/yield-second-commit" ] && grep -q '/api/v1/admin/catalogue/anchor/commits' "$state" && grep -q 'track-2' "$state"; then
  printf '{"event":"database.admission.runner","yield_reason":"queue"}\\n' >&2
  exit 75
fi
if [ "$owner" = "fluncle-anchor" ] && [ -f "${directory}/yield-report" ] && grep -q '"path":"/api/v1/admin/catalogue/anchor"' "$state"; then
  printf '{"event":"database.admission.runner","yield_reason":"queue"}\\n' >&2
  exit 75
fi
if [ "$(cat "${directory}/lease")" != "free" ]; then exit 88; fi
printf held > "${directory}/lease"
printf 'acquire:%s\\n' "$owner" >> "${directory}/timeline"
set +e
"$@"
status="$?"
set -e
printf free > "${directory}/lease"
printf 'release:%s\\n' "$owner" >> "${directory}/timeline"
exit "$status"`,
  );
  return {
    directory,
    environment: {
      ...process.env,
      APIFY_API_TOKEN: "fixture-apify-token",
      BUN_BIN: process.execPath,
      DATABASE_ADMISSION_RUNNER: runner,
      FLUNCLE_ANCHOR_APIFY_BASE_URL: baseUrl,
      FLUNCLE_ANCHOR_ISRC_WINDOW_UTC: "0-24",
      FLUNCLE_ANCHOR_PROGRESS_DIR: join(directory, "paid-progress"),
      FLUNCLE_API_BASE_URL: baseUrl,
      FLUNCLE_API_TOKEN: "fixture-agent-token",
      HEALTHCHECK_CRON_OUTPUT_DIR: join(directory, "markers"),
      HOME: join(directory, "home"),
    },
    runner,
  };
}

test("fixture readiness publishes a complete port before the sweep starts", async () => {
  const pending = rig({ pausePortWrite: true });
  const directory = temporaryDirectories.at(-1);
  if (!directory) {
    throw new Error("missing anchor fixture directory");
  }
  try {
    await until(() => existsSync(join(directory, "port-write-started")));
    expect(existsSync(join(directory, "port"))).toBe(false);
  } finally {
    writeFileSync(join(directory, "release-port-write"), "1");
    await pending;
  }
  const fixture = await pending;
  const result = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
    env: fixture.environment,
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ ok: true, produced: 1 });
}, 15_000);

test(
  "a slow anchor probe leaves the lease free for a sibling phase",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig();
    const anchor = Bun.spawn(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    await until(
      () =>
        existsSync(join(fixture.directory, "timeline")) &&
        readFileSync(join(fixture.directory, "timeline"), "utf8").includes("probe-start"),
    );
    const sibling = Bun.spawnSync(["bash", fixture.runner, "phase", "sibling", "--", "true"]);
    expect(sibling.exitCode).toBe(0);
    expect(await anchor.exited).toBe(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("probe-free");
    expect(timeline.indexOf("acquire:sibling")).toBeGreaterThan(timeline.indexOf("probe-start"));
    expect(timeline.indexOf("release:sibling")).toBeLessThan(timeline.indexOf("probe-end"));
    expect(JSON.parse(await new Response(anchor.stdout).text())).toMatchObject({
      checked: 1,
      ok: true,
      produced: 1,
    });
  },
);

test(
  "an inherited whole-sweep lease uses direct calls without nested phase acquisition",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig();
    writeFileSync(join(fixture.directory, "lease"), "held");
    const result = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: { ...fixture.environment, FLUNCLE_ADMISSION_RUNNER_PID: "4242" },
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ checked: 1, produced: 1 });
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("probe-held");
    expect(timeline).not.toContain("acquire:fluncle-anchor");
    expect(readFileSync(join(fixture.directory, "lease"), "utf8")).toBe("held");
  },
);

test(
  "a yielded commit records paused health and resumes without a duplicate write",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig();
    writeFileSync(join(fixture.directory, "yield-commit"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    expect(existsSync(join(fixture.directory, "committed"))).toBe(false);
    const paused = JSON.parse(first.stdout.toString());
    expect(paused).toMatchObject({
      admissionOutcome: "phase-yielded",
      admissionYieldReason: "queue",
      blockedReason: "database_admission",
      gateReason: "open",
      gateState: "paused",
      reason: "database_admission",
    });
    const markerDirectory = join(fixture.directory, "markers", "fluncle-anchor");
    const marker = readFileSync(
      join(markerDirectory, readdirSync(markerDirectory)[0] ?? ""),
      "utf8",
    );
    expect(marker).toContain('"admissionOutcome":"phase-yielded"');
    expect(markerSignals(marker)).toEqual({
      backpressure: 1,
      backpressureReason: "database_admission:queue",
      strain: 0,
    });
    rmSync(join(fixture.directory, "yield-commit"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(JSON.parse(resumed.stdout.toString())).toMatchObject({ produced: 1 });
    expect(readFileSync(join(fixture.directory, "committed"), "utf8")).toBe("1");
  },
);

test(
  "a second-row commit yield replays paid rows before another worklist read",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "yield-second-commit"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "2"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    expect(JSON.parse(first.stdout.toString())).toMatchObject({
      admissionOutcome: "phase-yielded",
      checked: 2,
      gateState: "paused",
    });
    const progress = join(fixture.directory, "paid-progress");
    expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toHaveLength(2);
    expect(readFileSync(join(fixture.directory, "timeline"), "utf8")).not.toContain("actor-run");

    rmSync(join(fixture.directory, "yield-second-commit"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "2"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(JSON.parse(resumed.stdout.toString())).toMatchObject({ produced: 2 });
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline.match(/prepare-batch:track-1,track-2/g)).toHaveLength(1);
    expect(timeline).not.toContain("commit-batch:track-1,track-2");
    expect(timeline.match(/paid-commit:track-1/g)).toHaveLength(1);
    expect(timeline.match(/paid-commit:track-2/g)).toHaveLength(1);
    expect(timeline.match(/actor-run/g)).toHaveLength(2);
    expect(timeline.lastIndexOf("worklist-read")).toBeGreaterThan(
      timeline.lastIndexOf("report:track-2"),
    );
    expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toHaveLength(0);
  },
);

test(
  "post-actor admission yield replays saved candidates across a day boundary",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "yield-report"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "2"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    expect(JSON.parse(first.stdout.toString())).toMatchObject({
      admissionOutcome: "phase-yielded",
      apifyResults: 0,
      gateState: "paused",
    });
    const progress = join(fixture.directory, "paid-progress");
    const files = readdirSync(progress).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(2);
    for (const name of files) {
      const path = join(progress, name);
      const checkpoint = JSON.parse(readFileSync(path, "utf8"));
      expect(checkpoint).toMatchObject({ candidates: [], stage: "results" });
      writeFileSync(
        path,
        JSON.stringify({ ...checkpoint, createdAt: Date.now() - 23 * 60 * 60 * 1000 }),
      );
    }
    rmSync(join(fixture.directory, "yield-report"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "2"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(JSON.parse(resumed.stdout.toString())).toMatchObject({ produced: 2 });
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline.match(/actor-run/g)).toHaveLength(1);
    expect(timeline.match(/report:track-/g)).toHaveLength(2);
    expect(timeline.lastIndexOf("worklist-read")).toBeGreaterThan(
      timeline.lastIndexOf("report:track-2"),
    );
    expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toHaveLength(0);
  },
);

test(
  "a definitive first commit conflict clears its unpaid checkpoint for a later tick",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "commit-409-track-1"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    expect(JSON.parse(first.stdout.toString())).toMatchObject({ freeRungErrors: 1 });
    const progress = join(fixture.directory, "paid-progress");
    expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    rmSync(join(fixture.directory, "commit-409-track-1"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(JSON.parse(resumed.stdout.toString())).toMatchObject({ produced: 1 });
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline.match(/rejected-commit:track-1/g)).toHaveLength(1);
    expect(timeline.match(/paid-commit:track-1/g)).toHaveLength(1);
    expect(timeline.match(/actor-run/g)).toHaveLength(1);
  },
);

test(
  "one bad checkpoint does not prevent a later saved paid result from settling",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "yield-report"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "2"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const progress = join(fixture.directory, "paid-progress");
    const files = readdirSync(progress).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(2);
    const firstPath = files
      .map((name) => join(progress, name))
      .find((path) => {
        const checkpoint = JSON.parse(readFileSync(path, "utf8"));
        return checkpoint.trackId === "track-1";
      });
    if (!firstPath) {
      throw new Error("missing first paid checkpoint");
    }
    const firstCheckpoint = JSON.parse(readFileSync(firstPath, "utf8"));
    writeFileSync(
      firstPath,
      JSON.stringify({ ...firstCheckpoint, apifyRunId: undefined, stage: "actor_started" }),
    );
    rmSync(join(fixture.directory, "yield-report"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "2"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(resumed.stdout.toString())).toMatchObject({
      blockedReason: "awaiting_paid_result",
      ok: true,
      produced: 1,
    });
    const checkpointAfter = JSON.parse(readFileSync(firstPath, "utf8"));
    expect(checkpointAfter).toMatchObject({
      anchorQuery: firstCheckpoint.anchorQuery,
      paidResultToken: firstCheckpoint.paidResultToken,
      prepared: firstCheckpoint.prepared,
      trackId: firstCheckpoint.trackId,
    });
    const remaining = readdirSync(progress)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(progress, name), "utf8")).trackId);
    expect(remaining).toEqual(["track-1"]);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline.match(/actor-run/g)).toHaveLength(1);
    expect(timeline.match(/report:track-2/g)).toHaveLength(1);
  },
);

test(
  "a blocked checkpoint disarms another checkpoint's commit replay",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "yield-second-commit"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "2"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const progress = join(fixture.directory, "paid-progress");
    const firstPath = readdirSync(progress)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(progress, name))
      .find((path) => JSON.parse(readFileSync(path, "utf8")).trackId === "track-1");
    if (!firstPath) {
      throw new Error("missing first checkpoint");
    }
    const checkpoint = JSON.parse(readFileSync(firstPath, "utf8"));
    writeFileSync(
      firstPath,
      JSON.stringify({ ...checkpoint, paidResultToken: "result:track-1", stage: "actor_started" }),
    );
    rmSync(join(fixture.directory, "yield-second-commit"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "2"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(JSON.parse(resumed.stdout.toString())).toMatchObject({
      blockedReason: "paid_result_recovery",
      ok: true,
    });
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("free-commit:track-2");
    expect(timeline).not.toContain("paid-commit:track-2");
    expect(timeline).not.toContain("actor-run:");
    expect(JSON.parse(readFileSync(firstPath, "utf8"))).toMatchObject({
      paidResultToken: "result:track-1",
      stage: "actor_started",
      trackId: "track-1",
    });
  },
);

test(
  "a checkpoint created during batch prepare is never overwritten and its sibling proceeds",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "race-checkpoint-track-1"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "2"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    expect(JSON.parse(first.stdout.toString())).toMatchObject({
      blockedReason: "paid_result_recovery",
      ok: true,
      produced: 1,
    });
    const progress = join(fixture.directory, "paid-progress");
    const checkpoints = readdirSync(progress)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(progress, name), "utf8")));
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      anchorQuery: "saved-query",
      paidResultToken: "saved-token",
      prepared: "saved-prepared",
      stage: "actor_started",
      trackId: "track-1",
    });
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("prepare-batch:track-1,track-2");
    expect(timeline).toContain("free-commit:track-2");
    expect(timeline).not.toContain("paid-commit:track-1");
  },
);

test(
  "an uncertain first commit keeps its checkpoint for the original receipt replay",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "commit-503-track-1"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const progress = join(fixture.directory, "paid-progress");
    const files = readdirSync(progress).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(progress, files[0] ?? ""), "utf8"))).toMatchObject({
      stage: "commit",
      trackId: "track-1",
    });
    rmSync(join(fixture.directory, "commit-503-track-1"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(JSON.parse(resumed.stdout.toString())).toMatchObject({ produced: 1 });
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline.match(/ambiguous-commit:track-1/g)).toHaveLength(1);
    expect(timeline.match(/paid-commit:track-1/g)).toHaveLength(1);
    expect(timeline.match(/actor-run/g)).toHaveLength(1);
  },
);

test(
  "a charged commit replay with Apify OFF keeps the exact pending receipt without starting an actor",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "commit-503-track-1"), "1");
    writeFileSync(join(fixture.directory, "charged-commit-503-track-1"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    rmSync(join(fixture.directory, "commit-503-track-1"));
    writeFileSync(join(fixture.directory, "apify-disabled"), "1");
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    const progress = join(fixture.directory, "paid-progress");
    const checkpoints = readdirSync(progress)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(progress, name), "utf8")));
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ stage: "admitted", trackId: "track-1" });
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("token-refresh:track-1");
    expect(timeline).not.toContain("receipt-read:track-1");
    expect(timeline).not.toContain("actor-run:");
  },
);

test(
  "an anchored commit replay settles its exact pending paid receipt before clearing",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "commit-503-track-1"), "1");
    writeFileSync(join(fixture.directory, "charged-commit-503-track-1"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    rmSync(join(fixture.directory, "commit-503-track-1"));
    writeFileSync(join(fixture.directory, "commit-replay-anchored"), "1");
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).not.toContain("receipt-read:track-1");
    expect(timeline).toContain("resolve-paid:track-1");
    expect(
      readdirSync(join(fixture.directory, "paid-progress")).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(0);
  },
);

test(
  "a refused anchored commit replay retains its pending checkpoint",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "commit-503-track-1"), "1");
    writeFileSync(join(fixture.directory, "charged-commit-503-track-1"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    rmSync(join(fixture.directory, "commit-503-track-1"));
    writeFileSync(join(fixture.directory, "commit-replay-anchored"), "1");
    writeFileSync(join(fixture.directory, "resolve-refuse"), "1");
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(JSON.parse(resumed.stdout.toString())).toMatchObject({
      blockedReason: "paid_result_recovery",
      ok: true,
    });
    expect(
      readdirSync(join(fixture.directory, "paid-progress")).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(1);
  },
);

test(
  "a batch anchored verdict settles the same pending receipt before clearing",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "batch-anchored-paid"), "1");
    const result = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).not.toContain("receipt-read:track-1");
    expect(timeline).toContain("resolve-paid:track-1");
    expect(
      readdirSync(join(fixture.directory, "paid-progress")).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(0);
  },
);

test(
  "a single anchored verdict settles the same pending receipt before clearing",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-anchored-paid"), "1");
    const moduleUrl = new URL("./anchor-sweep.ts", import.meta.url).href;
    const script = `const anchor = await import(${JSON.stringify(moduleUrl)}); await anchor.resolveAnchorPhased("track-1", undefined, { anchorQuery: "query-track-1" });`;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).not.toContain("receipt-read:track-1");
    expect(timeline).toContain("resolve-paid:track-1");
    expect(
      readdirSync(join(fixture.directory, "paid-progress")).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(0);
  },
);

test(
  "a K-row free commit clears checkpoints without per-row receipt reads",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "free-batch"), "1");
    const result = Bun.spawnSync(["bash", SCRIPT, "--limit", "2"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ produced: 2 });
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("commit-batch:track-1,track-2");
    expect(timeline).not.toContain("receipt-read:");
    expect(
      readdirSync(join(fixture.directory, "paid-progress")).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(0);
  },
);

test(
  "a legacy anchored verdict without receipt state reads and resolves its exact receipt",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "batch-anchored-paid"), "1");
    writeFileSync(join(fixture.directory, "legacy-verdict"), "1");
    const result = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("receipt-read:track-1");
    expect(timeline).toContain("resolve-paid:track-1");
    expect(
      readdirSync(join(fixture.directory, "paid-progress")).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(0);
  },
);

test(
  "expired commit evidence with a pending paid receipt resumes through its exact token",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "commit-503-track-1"), "1");
    writeFileSync(join(fixture.directory, "charged-commit-503-track-1"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const progress = join(fixture.directory, "paid-progress");
    const file = readdirSync(progress).find((name) => name.endsWith(".json"));
    if (!file) {
      throw new Error("missing charged commit checkpoint");
    }
    const path = join(progress, file);
    const checkpoint = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify({ ...checkpoint, createdAt: Date.now() - 3 * 60 * 60 * 1000 }),
    );
    rmSync(join(fixture.directory, "commit-503-track-1"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(JSON.parse(resumed.stdout.toString())).toMatchObject({ ok: true, produced: 1 });
    expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("receipt-read:track-1");
    expect(timeline).toContain("token-refresh:track-1");
    expect(timeline).not.toContain("paid-commit:track-1");
    expect(timeline.match(/actor-run:query-track-1/g)).toHaveLength(1);
  },
);

test(
  "a server batch tail deferral still runs already admitted rows and keeps the due label",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "batch-defer-track-2"), "1");
    const result = Bun.spawnSync(["bash", SCRIPT, "--limit", "2"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      apifyRowsSent: 1,
      ok: true,
      produced: 1,
      spotifyIsrcDue: 1,
    });
    const summary = JSON.parse(result.stdout.toString());
    expect(summary.admissionOutcome).toBeUndefined();
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("batch-deferred:track-2");
    expect(timeline).toContain("actor-run:query-track-1");
    expect(timeline).toContain("report:track-1");
  },
);

test(
  "a confirmed terminal actor run cancels its exact paid receipt",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "actor-terminal"), "1");
    const result = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ apifyActorErrors: 1, ok: true });
    expect(
      readdirSync(join(fixture.directory, "paid-progress")).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(0);
    expect(readFileSync(join(fixture.directory, "timeline"), "utf8")).toContain(
      "cancel-paid:track-1",
    );
  },
);

test(
  "a definite 429 start refunds the cap slot and stops paid work for the tick",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "actor-start-429"), "1");
    const result = Bun.spawnSync(["bash", SCRIPT, "--limit", "2"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline.match(/actor-run:/g)).toHaveLength(1);
    expect(timeline).toContain("refund-paid:track-1");
    expect(timeline).toContain("refund-paid:track-2");
  },
);

test(
  "an uncertain actor start adopts a matching run without another POST",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "actor-start-503"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode).toBe(1);
    writeFileSync(join(fixture.directory, "actor-list-match"), "1");
    rmSync(join(fixture.directory, "actor-start-503"));
    const second = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("actor-list");
    expect(timeline).toContain("actor-input");
    expect(timeline.match(/actor-run:/g)).toHaveLength(1);
    expect(timeline).toContain("report:track-1");
  },
);

test(
  "a recovered batch matches the full actor input and polls its run once",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "actor-start-503"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "2"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode).toBe(1);
    writeFileSync(join(fixture.directory, "actor-list-match"), "1");
    writeFileSync(join(fixture.directory, "actor-input-two"), "1");
    rmSync(join(fixture.directory, "actor-start-503"));
    const second = Bun.spawnSync(["bash", SCRIPT, "--limit", "2"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline.match(/actor-list/g)).toHaveLength(1);
    expect(timeline.match(/actor-input/g)).toHaveLength(1);
    expect(timeline.match(/actor-poll/g)).toHaveLength(1);
    expect(timeline.match(/actor-run:/g)).toHaveLength(1);
    expect(timeline).toContain("report:track-1");
    expect(timeline).toContain("report:track-2");
  },
);

test(
  "an uncertain actor start with no run settles after its grace window",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "actor-start-503"), "1");
    writeFileSync(join(fixture.directory, "backoff-on-cancel"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode).toBe(1);
    const progress = join(fixture.directory, "paid-progress");
    const file = readdirSync(progress).find((name) => name.endsWith(".json"));
    if (!file) {
      throw new Error("missing actor start checkpoint");
    }
    const path = join(progress, file);
    const checkpoint = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...checkpoint, actorStartedAt: Date.now() - 5 * 60_000 }));
    writeFileSync(join(fixture.directory, "actor-list-history"), "1");
    rmSync(join(fixture.directory, "actor-start-503"));
    const second = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("actor-list");
    expect(timeline).toContain("refund-paid:track-1");
    expect(timeline.match(/actor-run:/g)).toHaveLength(1);
  },
);

test(
  "an old ambiguous actor start refreshes its exact token before unpaid cancellation",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "actor-start-503"), "1");
    writeFileSync(join(fixture.directory, "backoff-on-cancel"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode).toBe(1);
    const progress = join(fixture.directory, "paid-progress");
    const file = readdirSync(progress).find((name) => name.endsWith(".json"));
    if (!file) {
      throw new Error("missing actor start checkpoint");
    }
    const path = join(progress, file);
    const checkpoint = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify({
        ...checkpoint,
        actorStartedAt: Date.now() - 5 * 60_000,
        createdAt: Date.now() - 25 * 60 * 60_000,
      }),
    );
    rmSync(join(fixture.directory, "actor-start-503"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("token-refresh:track-1");
    expect(timeline).toContain("refund-paid:track-1");
  },
);

test(
  "a legacy batch without saved actor input cannot be declared unpaid",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "actor-start-503"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "2"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode).toBe(1);
    const progress = join(fixture.directory, "paid-progress");
    const files = readdirSync(progress).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(2);
    for (const file of files) {
      const path = join(progress, file);
      const checkpoint = JSON.parse(readFileSync(path, "utf8"));
      delete checkpoint.actorQueries;
      writeFileSync(
        path,
        JSON.stringify({ ...checkpoint, actorStartedAt: Date.now() - 5 * 60_000 }),
      );
    }
    writeFileSync(join(fixture.directory, "actor-list-match"), "1");
    writeFileSync(join(fixture.directory, "actor-input-two"), "1");
    rmSync(join(fixture.directory, "actor-start-503"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "2"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toHaveLength(2);
    expect(readFileSync(join(fixture.directory, "timeline"), "utf8")).not.toContain(
      "refund-paid:track-1",
    );
  },
);

test(
  "a run started thirty seconds behind the box clock is adopted",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "actor-start-503"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode).toBe(1);
    writeFileSync(join(fixture.directory, "actor-list-match"), "1");
    writeFileSync(join(fixture.directory, "actor-clock-behind"), "1");
    rmSync(join(fixture.directory, "actor-start-503"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("actor-input");
    expect(timeline).toContain("report:track-1");
    expect(timeline).not.toContain("refund-paid:track-1");
  },
);

test(
  "an ambiguous actor start recovers through an unfiltered paged run list",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "actor-start-503"), "1");
    expect(
      Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
        env: fixture.environment,
        stderr: "pipe",
        stdout: "pipe",
      }).exitCode,
    ).toBe(1);
    writeFileSync(join(fixture.directory, "actor-list-many"), "1");
    writeFileSync(join(fixture.directory, "actor-list-history"), "1");
    writeFileSync(join(fixture.directory, "actor-list-match"), "1");
    rmSync(join(fixture.directory, "actor-start-503"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline.match(/actor-list/g)?.length).toBe(2);
    expect(timeline).toContain("actor-poll:run-ambiguous");
    expect(timeline).toContain("report:track-1");
  },
);

test(
  "an actor run nineteen minutes behind the box clock is adopted",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "actor-start-503"), "1");
    expect(
      Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
        env: fixture.environment,
        stderr: "pipe",
        stdout: "pipe",
      }).exitCode,
    ).toBe(1);
    writeFileSync(join(fixture.directory, "actor-list-match"), "1");
    writeFileSync(join(fixture.directory, "actor-clock-behind-19m"), "1");
    rmSync(join(fixture.directory, "actor-start-503"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(readFileSync(join(fixture.directory, "timeline"), "utf8")).toContain(
      "actor-poll:run-ambiguous",
    );
  },
);

test("identical actor inputs adopt the earliest matching run", { timeout: 15_000 }, async () => {
  const fixture = await rig({ paid: true });
  writeFileSync(join(fixture.directory, "single-paid-row"), "1");
  writeFileSync(join(fixture.directory, "actor-start-503"), "1");
  expect(
    Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    }).exitCode,
  ).toBe(1);
  writeFileSync(join(fixture.directory, "actor-list-match"), "1");
  writeFileSync(join(fixture.directory, "actor-list-double-match"), "1");
  rmSync(join(fixture.directory, "actor-start-503"));
  const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
    env: fixture.environment,
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
  expect(readFileSync(join(fixture.directory, "timeline"), "utf8")).toContain(
    "actor-poll:run-earlier",
  );
});

test(
  "an unrelated unreadable actor input does not hide a matching run",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "actor-start-503"), "1");
    expect(
      Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
        env: fixture.environment,
        stderr: "pipe",
        stdout: "pipe",
      }).exitCode,
    ).toBe(1);
    writeFileSync(join(fixture.directory, "actor-list-many"), "1");
    writeFileSync(join(fixture.directory, "actor-list-match"), "1");
    writeFileSync(join(fixture.directory, "actor-unrelated-input-fail"), "1");
    rmSync(join(fixture.directory, "actor-start-503"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("actor-poll:run-ambiguous");
    expect(timeline).toContain("report:track-1");
  },
);

test(
  "an oversized actor run window stays blocked without reading every run input",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "actor-start-503"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode).toBe(1);
    writeFileSync(join(fixture.directory, "actor-list-overflow"), "1");
    rmSync(join(fixture.directory, "actor-start-503"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(JSON.parse(resumed.stdout.toString())).toMatchObject({
      blockedReason: "paid_result_recovery",
      ok: true,
    });
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("actor-list");
    expect(timeline).not.toContain("actor-input");
    expect(timeline).not.toContain("refund-paid:track-1");
  },
);

test("a report conflict resolves only its exact paid receipt", { timeout: 15_000 }, async () => {
  const fixture = await rig({ paid: true });
  writeFileSync(join(fixture.directory, "single-paid-row"), "1");
  writeFileSync(join(fixture.directory, "report-gone"), "1");
  const result = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
    env: fixture.environment,
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ ok: true });
  expect(
    readdirSync(join(fixture.directory, "paid-progress")).filter((name) => name.endsWith(".json")),
  ).toHaveLength(0);
  expect(readFileSync(join(fixture.directory, "timeline"), "utf8")).toContain(
    "resolve-paid:track-1",
  );
});

test("a refused report resolution keeps the paid checkpoint", { timeout: 15_000 }, async () => {
  const fixture = await rig({ paid: true });
  writeFileSync(join(fixture.directory, "single-paid-row"), "1");
  writeFileSync(join(fixture.directory, "report-gone"), "1");
  writeFileSync(join(fixture.directory, "resolve-refuse"), "1");
  const result = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
    env: fixture.environment,
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    blockedReason: "paid_result_recovery",
    ok: true,
  });
  expect(
    readdirSync(join(fixture.directory, "paid-progress")).filter((name) => name.endsWith(".json")),
  ).toHaveLength(1);
  expect(readFileSync(join(fixture.directory, "timeline"), "utf8")).toContain(
    "resolve-paid:track-1",
  );
});

test("an Apify run lookup 404 keeps the paid checkpoint", { timeout: 15_000 }, async () => {
  const fixture = await rig({ paid: true });
  writeFileSync(join(fixture.directory, "single-paid-row"), "1");
  writeFileSync(join(fixture.directory, "actor-run-gone"), "1");
  const result = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
    env: fixture.environment,
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(result.exitCode).toBe(1);
  const progress = join(fixture.directory, "paid-progress");
  const checkpointFile = readdirSync(progress).find((name) => name.endsWith(".json"));
  if (!checkpointFile) {
    throw new Error("missing paid actor checkpoint");
  }
  expect(JSON.parse(readFileSync(join(progress, checkpointFile), "utf8"))).toMatchObject({
    apifyRunId: "run-1",
    stage: "actor_started",
  });
  expect(readFileSync(join(fixture.directory, "timeline"), "utf8")).not.toContain(
    "cancel-paid:track-1",
  );
});

test(
  "a terminal actor run refreshes its expired paid token before cancellation",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "actor-fail"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode).toBe(1);
    const progress = join(fixture.directory, "paid-progress");
    const checkpointFile = readdirSync(progress).find((name) => name.endsWith(".json"));
    if (!checkpointFile) {
      throw new Error("missing paid actor checkpoint");
    }
    const checkpointPath = join(progress, checkpointFile);
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    writeFileSync(
      checkpointPath,
      JSON.stringify({ ...checkpoint, createdAt: Date.now() - 25 * 60 * 60 * 1000 }),
    );
    rmSync(join(fixture.directory, "actor-fail"));
    writeFileSync(join(fixture.directory, "actor-terminal"), "1");
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("token-refresh:track-1");
    expect(timeline).toContain("cancel-paid:track-1");
  },
);

test(
  "an expired unpaid commit checks the exact receipt before dropping its checkpoint",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "commit-503-track-1"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const progress = join(fixture.directory, "paid-progress");
    const file = readdirSync(progress).find((name) => name.endsWith(".json"));
    if (!file) {
      throw new Error("missing commit checkpoint");
    }
    const path = join(progress, file);
    const checkpoint = JSON.parse(readFileSync(path, "utf8"));
    expect(checkpoint).toMatchObject({ allowPaid: true, receiptAt: "receipt:track-1" });
    writeFileSync(
      path,
      JSON.stringify({ ...checkpoint, createdAt: Date.now() - 3 * 60 * 60 * 1000 }),
    );
    writeFileSync(join(fixture.directory, "reported-track-1"), "1");
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("receipt-read:track-1");
    expect(timeline).not.toContain("paid-commit:track-1");
  },
);

test(
  "a definite 409 settles an unpaid commit checkpoint before two hours",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "commit-503-track-1"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode).toBe(0);
    rmSync(join(fixture.directory, "commit-503-track-1"));
    writeFileSync(join(fixture.directory, "commit-409-track-1"), "1");
    writeFileSync(join(fixture.directory, "reported-track-1"), "1");
    const second = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    expect(
      readdirSync(join(fixture.directory, "paid-progress")).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("rejected-commit:track-1");
    expect(timeline).toContain("receipt-read:track-1");
  },
);

test("one recovery pass polls a shared running run only once", { timeout: 15_000 }, async () => {
  const fixture = await rig({ paid: true });
  const progress = join(fixture.directory, "paid-progress");
  mkdirSync(progress);
  writeFileSync(join(fixture.directory, "actor-running"), "1");
  for (const trackId of ["track-1", "track-2"]) {
    const file = `${createHash("sha256").update(trackId).digest("hex")}.json`;
    writeFileSync(
      join(progress, file),
      JSON.stringify({
        actorQueries: ["query-track-1", "query-track-2"],
        actorStartedAt: Date.now() - 1_000,
        allowPaid: true,
        anchorQuery: `query-${trackId}`,
        apifyRunId: "run-shared",
        createdAt: Date.now(),
        evidence: `evidence:${trackId}`,
        paidResultToken: `result:${trackId}`,
        prepared: `prepared:${trackId}`,
        receiptAt: `receipt:${trackId}`,
        stage: "actor_started",
        trackId,
      }),
    );
  }
  const child = Bun.spawn(["bash", SCRIPT, "--limit", "2"], {
    env: fixture.environment,
    stderr: "pipe",
    stdout: "pipe",
  });
  const finished = await Promise.race([
    child.exited,
    Bun.sleep(3_000).then(() => "timeout" as const),
  ]);
  if (finished === "timeout") {
    child.kill();
  }
  expect(finished).not.toBe("timeout");
  const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
  expect(timeline.match(/actor-poll/g)).toHaveLength(1);
  expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toHaveLength(2);
});

test(
  "a legacy single-row prepare preserves receipt coordinates for expired unpaid recovery",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "commit-503-track-1"), "1");
    const moduleUrl = new URL("./anchor-sweep.ts", import.meta.url).href;
    const script = `const anchor = await import(${JSON.stringify(moduleUrl)}); try { await anchor.resolveAnchorPhased("track-1", undefined, { anchorQuery: "query-track-1" }); } catch (error) { console.log(String(error)); }`;
    const first = Bun.spawnSync([process.execPath, "-e", script], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const progress = join(fixture.directory, "paid-progress");
    const file = readdirSync(progress).find((name) => name.endsWith(".json"));
    if (!file) {
      throw new Error("missing legacy commit checkpoint");
    }
    const path = join(progress, file);
    const checkpoint = JSON.parse(readFileSync(path, "utf8"));
    expect(checkpoint).toMatchObject({ receiptAt: "receipt:track-1", stage: "commit" });
    writeFileSync(
      path,
      JSON.stringify({ ...checkpoint, createdAt: Date.now() - 3 * 60 * 60 * 1000 }),
    );
    writeFileSync(join(fixture.directory, "reported-track-1"), "1");
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    expect(readFileSync(join(fixture.directory, "timeline"), "utf8")).toContain(
      "receipt-read:track-1",
    );
  },
);

test(
  "a failed poll recovers its run ID without a second actor POST",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "actor-fail"), "1");
    const environment = { ...fixture.environment, FLUNCLE_ANCHOR_APIFY_CHUNK: "1" };
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode).toBe(1);
    expect(JSON.parse(first.stdout.toString())).toMatchObject({
      apifyActorErrors: 1,
      blockedReason: "paid_result_recovery",
      ok: false,
    });
    const progress = join(fixture.directory, "paid-progress");
    const stages = readdirSync(progress)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(progress, name), "utf8")).stage)
      .sort((left: string, right: string) => left.localeCompare(right));
    expect(stages).toEqual(["actor_started", "admitted"]);
    rmSync(join(fixture.directory, "actor-fail"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(resumed.stdout.toString())).toMatchObject({
      ok: true,
      produced: 2,
    });
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline.match(/actor-run:query-track-1/g)).toHaveLength(1);
    expect(timeline.match(/actor-run:query-track-2/g)).toHaveLength(1);
    expect(timeline.match(/worklist-read/g)).toHaveLength(2);
    expect(timeline.match(/paid-commit:track-2/g)).toHaveLength(1);
  },
);

test(
  "a saved Apify run refreshes its exact paid token after a day and settles without a second start",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "actor-fail"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode).toBe(1);
    const progress = join(fixture.directory, "paid-progress");
    const file = readdirSync(progress).find((name) => name.endsWith(".json"));
    if (!file) {
      throw new Error("missing actor checkpoint");
    }
    const path = join(progress, file);
    const checkpoint = JSON.parse(readFileSync(path, "utf8"));
    expect(checkpoint).toMatchObject({
      apifyRunId: "run-1",
      receiptAt: "receipt:track-1",
      stage: "actor_started",
    });
    writeFileSync(
      path,
      JSON.stringify({ ...checkpoint, createdAt: Date.now() - 25 * 60 * 60 * 1000 }),
    );
    rmSync(join(fixture.directory, "actor-fail"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(JSON.parse(resumed.stdout.toString())).toMatchObject({ ok: true, produced: 1 });
    expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("token-refresh:track-1");
    expect(timeline).toContain("token-used:fresh-result:track-1");
    expect(timeline.match(/actor-run:query-track-1/g)).toHaveLength(1);
  },
);

test(
  "a blocked paid checkpoint still allows another row through free rungs",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "actor-fail"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode).toBe(1);
    rmSync(join(fixture.directory, "single-paid-row"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(resumed.stdout.toString())).toMatchObject({
      blockedReason: "paid_result_recovery",
      ok: true,
      produced: 1,
    });
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline.match(/actor-run/g)).toHaveLength(1);
    expect(timeline.match(/paid-commit:track-1/g)).toHaveLength(1);
    expect(timeline).toContain("free-commit:track-2");
    expect(timeline).not.toContain("paid-commit:track-2");
  },
);

test(
  "Apify OFF lets a started run settle but prevents an admitted row from starting",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "actor-fail"), "1");
    const environment = { ...fixture.environment, FLUNCLE_ANCHOR_APIFY_CHUNK: "1" };
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode).toBe(1);
    writeFileSync(join(fixture.directory, "apify-disabled"), "1");
    rmSync(join(fixture.directory, "actor-fail"));
    const before =
      readFileSync(join(fixture.directory, "timeline"), "utf8").match(/actor-poll/g)?.length ?? 0;
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(JSON.parse(resumed.stdout.toString())).toMatchObject({
      blockedReason: "paid_result_recovery",
      ok: true,
      produced: 1,
    });
    const after =
      readFileSync(join(fixture.directory, "timeline"), "utf8").match(/actor-poll/g)?.length ?? 0;
    expect(after).toBeGreaterThan(before);
    expect(
      readFileSync(join(fixture.directory, "timeline"), "utf8").match(/actor-run:/g),
    ).toHaveLength(1);
  },
);

test(
  "a definitive rejected Apify start settles the unpaid result without retiring its track",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "actor-start-fail"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const progress = join(fixture.directory, "paid-progress");
    expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    rmSync(join(fixture.directory, "actor-start-fail"));
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    expect(JSON.parse(resumed.stdout.toString())).toMatchObject({ produced: 1 });
    expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("cancel-paid:track-1");
    expect(timeline).not.toContain("failure:track-1");
    expect(timeline.match(/paid-commit:track-1/g)).toHaveLength(2);
    expect(timeline.match(/actor-run:query-track-1/g)).toHaveLength(2);
  },
);

test(
  "a terminal invalid paid report settles its strike and removes its checkpoint",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "report-invalid"), "1");
    const first = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    expect(JSON.parse(first.stdout.toString())).toMatchObject({ failed: 1, skipped: 1 });
    const progress = join(fixture.directory, "paid-progress");
    expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    const resumed = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline.match(/failure:track-1/g)).toHaveLength(1);
    expect(timeline.match(/actor-run/g)).toHaveLength(1);
    expect(timeline).toContain("cancel-paid:track-1");
  },
);

test(
  "a refused invalid-strike cancel retains the paid checkpoint",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "report-invalid"), "1");
    writeFileSync(join(fixture.directory, "cancel-refuse"), "1");
    const result = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(
      readdirSync(join(fixture.directory, "paid-progress")).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(1);
    expect(readFileSync(join(fixture.directory, "timeline"), "utf8")).toContain(
      "cancel-paid:track-1",
    );
  },
);

test(
  "a concurrent direct sweep reports busy while the wrapper owns the whole tick",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    writeFileSync(join(fixture.directory, "single-paid-row"), "1");
    writeFileSync(join(fixture.directory, "actor-poll-hold"), "1");
    const first = Bun.spawn(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    await until(
      () =>
        existsSync(join(fixture.directory, "timeline")) &&
        readFileSync(join(fixture.directory, "timeline"), "utf8").includes("actor-poll"),
    );
    const second = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "anchor-sweep.ts"), "--limit", "1"],
      {
        env: fixture.environment,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    expect(JSON.parse(second.stdout.toString())).toMatchObject({
      blockedReason: "anchor_tick_busy",
      ok: true,
    });
    expect(await first.exited).toBe(0);
    expect(JSON.parse(await new Response(first.stdout).text())).toMatchObject({ produced: 1 });
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline.match(/actor-poll/g)).toHaveLength(1);
    expect(timeline.match(/actor-run/g)).toHaveLength(1);
  },
);

test(
  "systemic invalid recovered reports preserve every paid checkpoint",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    const progress = join(fixture.directory, "paid-progress");
    mkdirSync(progress);
    writeFileSync(join(fixture.directory, "report-invalid"), "1");
    for (const trackId of ["track-a", "track-b", "track-c"]) {
      const file = `${createHash("sha256").update(trackId).digest("hex")}.json`;
      writeFileSync(
        join(progress, file),
        JSON.stringify({
          anchorQuery: `query-${trackId}`,
          candidates: [],
          createdAt: Date.now(),
          evidence: `evidence:${trackId}`,
          paidResultToken: `result:${trackId}`,
          prepared: `prepared:${trackId}`,
          receiptAt: `receipt:${trackId}`,
          stage: "results",
          trackId,
        }),
      );
    }
    const result = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      blockedReason: "anchor_contract_fault",
      ok: false,
    });
    expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toHaveLength(3);
    expect(readFileSync(join(fixture.directory, "timeline"), "utf8")).not.toContain("failure:");
  },
);

test(
  "a malformed checkpoint blocks new paid admission while valid saved results replay",
  { timeout: 15_000 },
  async () => {
    const fixture = await rig({ paid: true });
    const progress = join(fixture.directory, "paid-progress");
    mkdirSync(progress);
    writeFileSync(join(progress, "corrupt.json"), "{bad json");
    const trackId = "track-1";
    const file = `${createHash("sha256").update(trackId).digest("hex")}.json`;
    writeFileSync(
      join(progress, file),
      JSON.stringify({
        anchorQuery: "query-track-1",
        candidates: [],
        createdAt: Date.now(),
        evidence: "evidence:track-1",
        paidResultToken: "result:track-1",
        prepared: "prepared:track-1",
        receiptAt: "receipt:track-1",
        stage: "results",
        trackId,
      }),
    );
    const result = Bun.spawnSync(["bash", SCRIPT, "--limit", "1"], {
      env: fixture.environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      blockedReason: "paid_result_recovery",
      ok: true,
    });
    expect(readdirSync(progress).filter((name) => name.endsWith(".json"))).toEqual([
      "corrupt.json",
    ]);
    const timeline = readFileSync(join(fixture.directory, "timeline"), "utf8");
    expect(timeline).toContain("report:track-1");
    expect(timeline).not.toContain("actor-run:");
  },
);
