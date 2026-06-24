#!/usr/bin/env bun
// fluncle-healthcheck.ts — the bun orchestrator behind the `fluncle-healthcheck`
// `--no-agent` Hermes cron. The prober for Fluncle's public /status dashboard.
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (fluncle-healthcheck.sh)
// the cron runner execs every ~10m — see that file's header for the env keys + the
// `hermes cron create` wire-up, and ../cron/README.md § The healthcheck cron.
//
// THE TICK (all deterministic — no model time):
//   1. PROBE each service in parallel, each with a short timeout (3–5s) so one hung
//      target can't blow the runner's ~120s budget:
//        web         — GET ${HEALTHCHECK_WORKER_URL}/api/health, timed.
//        r2          — HEAD ${HEALTHCHECK_R2_PROBE_URL}.
//        dns         — dig +short ${HEALTHCHECK_DNS_QUERY} (non-empty answer = ok).
//        ssh         — TCP-connect ${HEALTHCHECK_SSH_HOST}:${HEALTHCHECK_SSH_PORT}.
//        automation  — read ~/.hermes/cron/output/<job>/ per Hermes cron: newest *.md,
//                      its last line parsed as JSON (`.ok !== false`), AND fresh within
//                      ~3× the cron's cadence. Aggregated to ONE service.
//        render-box  — read ${HOME}/.render-conductor/state (idle|rendering both ok;
//                      missing = "not yet provisioned", ok). NEVER wakes the box.
//        hermes      — self-evident: this cron runs ON the box, so ok.
//      (onion — OUT OF SCOPE for v1; see the TODO below.)
//   2. TRANSITIONS: load ${HOME}/.healthcheck/state.json (service → last status); a
//      probe `transitioned` when prev !== current. Write the new map back.
//   3. ALERT: if any service transitioned to `down`, OR any recovered (down → ok/
//      degraded), Discord-ping once (best-effort) naming what changed. Nothing
//      changed → no ping (no spam).
//   4. POST the snapshot to ${HEALTHCHECK_WORKER_URL}/api/admin/health (record_health,
//      Authorization: Bearer ${FLUNCLE_API_TOKEN}). Best-effort: the alert already
//      fired, so a failed POST is logged, never thrown.
//
// stdout: ONE JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config — every probe target comes from the file-sourced env (the .sh sources
// ${HOME}/.healthcheck.env before exec'ing us); FLUNCLE_API_TOKEN rides the cron
// env. NO hostnames/ports/paths are hard-coded — public-safe by construction.
// ---------------------------------------------------------------------------

const HOME = process.env.HOME ?? homedir() ?? "/opt/data/home";

const WORKER_URL = (process.env.HEALTHCHECK_WORKER_URL ?? "").replace(/\/+$/, "");
const R2_PROBE_URL = process.env.HEALTHCHECK_R2_PROBE_URL ?? "";
const DNS_QUERY = process.env.HEALTHCHECK_DNS_QUERY ?? "";
const SSH_HOST = process.env.HEALTHCHECK_SSH_HOST ?? "";
const SSH_PORT = Number.parseInt(process.env.HEALTHCHECK_SSH_PORT ?? "", 10);
const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK ?? "";
const FLUNCLE_API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

// OPTIONAL external dead-man's-switch beacon. A completed tick means "the prober
// ran", so we ping this URL at the end of every tick; an external service
// (healthchecks.io / BetterUptime / a self-hosted instance — provider-agnostic)
// alerts when the pings STOP, which is the only signal that catches THIS box going
// dark (a dead prober can't alert about itself). Unset ⇒ skipped silently.
const BEACON_URL = process.env.HEALTHCHECK_BEACON_URL ?? "";

// Per-probe network timeout. Short on purpose: a hung target degrades to a clean
// "down" well inside the ~120s runner kill rather than starving the budget.
const PROBE_TIMEOUT_MS = Number.parseInt(process.env.HEALTHCHECK_TIMEOUT_MS ?? "", 10) || 4000;

// State (the transition memory) lives in the mounted, writable HOME.
const STATE_DIR = join(HOME, ".healthcheck");
const STATE_FILE = join(STATE_DIR, "state.json");

// Where the Hermes cron runner saves each job's per-run output.
const CRON_OUTPUT_DIR = join(HOME, ".hermes", "cron", "output");
// The render conductor's state file (idle | rendering).
const RENDER_STATE_FILE = join(HOME, ".render-conductor", "state");

// The box.ascii CLI (render-box plan usage is a best-effort extra). Resolved via
// PATH with an absolute fallback, like the other sweeps' bins.
const BOX_BIN = process.env.BOX_BIN ?? "box";

// onion — OUT OF SCOPE for v1: Tor reachability needs a SOCKS proxy the box may not
// have, so the status page simply won't show the onion until a later pass.
// TODO(onion): probe the .onion via a SOCKS5 proxy once the box has a Tor client.

const log = (message: string) => console.error(`[fluncle-healthcheck] ${message}`);

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

type Status = "ok" | "degraded" | "down";

type Check = {
  latencyMs: number | null;
  // Public-safe, ≤120 chars, NEVER an IP / host / path.
  message: string | null;
  service: string;
  status: Status;
};

type CheckWithTransition = Check & { transitioned: boolean };

type StateMap = Record<string, Status>;

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

/** Cap a message to a public-safe length; an empty string degrades to null. */
function msg(text: string): string | null {
  const trimmed = text.replace(/\s+/g, " ").trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
}

/** A `fetch` with a hard AbortController timeout — resolves or throws, never hangs. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Run a command with a hard timeout; returns code + captured streams (never throws). */
function runQuiet(
  bin: string,
  args: string[],
  timeoutMs: number,
): { code: number; stderr: string; stdout: string } {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs,
  });

  return {
    code: result.status ?? (result.signal ? 124 : 1),
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

// ---------------------------------------------------------------------------
// PROBE: web — GET ${WORKER_URL}/api/health, timed. ok on a 200; down otherwise.
// The message reports the code + elapsed ms (no host).
// ---------------------------------------------------------------------------

async function probeWeb(): Promise<Check> {
  const service = "web";

  if (!WORKER_URL) {
    return { latencyMs: null, message: msg("not configured"), service, status: "down" };
  }

  const started = Date.now();

  try {
    const response = await fetchWithTimeout(`${WORKER_URL}/api/health`, { method: "GET" });
    const latencyMs = Date.now() - started;

    if (response.status === 200) {
      return { latencyMs, message: msg(`200 in ${latencyMs}ms`), service, status: "ok" };
    }

    return {
      latencyMs,
      message: msg(`HTTP ${response.status} in ${latencyMs}ms`),
      service,
      status: "down",
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const reason =
      error instanceof Error && error.name === "AbortError" ? "timeout" : "unreachable";

    return { latencyMs, message: msg(`${reason} after ${latencyMs}ms`), service, status: "down" };
  }
}

// ---------------------------------------------------------------------------
// PROBE: r2 — HEAD ${R2_PROBE_URL}. ok on any 2xx.
// ---------------------------------------------------------------------------

async function probeR2(): Promise<Check> {
  const service = "r2";

  if (!R2_PROBE_URL) {
    return { latencyMs: null, message: msg("not configured"), service, status: "down" };
  }

  const started = Date.now();

  try {
    const response = await fetchWithTimeout(R2_PROBE_URL, { method: "HEAD" });
    const latencyMs = Date.now() - started;

    if (response.status >= 200 && response.status < 300) {
      return {
        latencyMs,
        message: msg(`${response.status} in ${latencyMs}ms`),
        service,
        status: "ok",
      };
    }

    return {
      latencyMs,
      message: msg(`HTTP ${response.status} in ${latencyMs}ms`),
      service,
      status: "down",
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const reason =
      error instanceof Error && error.name === "AbortError" ? "timeout" : "unreachable";

    return { latencyMs, message: msg(`${reason} after ${latencyMs}ms`), service, status: "down" };
  }
}

// ---------------------------------------------------------------------------
// PROBE: dns — `dig +short +time=3 +tries=1 ${DNS_QUERY}`. ok on a non-empty
// answer; down on empty / timeout. The message reports the answer COUNT, never an
// address (public-safe).
// ---------------------------------------------------------------------------

function probeDns(): Check {
  const service = "dns";

  if (!DNS_QUERY) {
    return { latencyMs: null, message: msg("not configured"), service, status: "down" };
  }

  const started = Date.now();
  const { code, stdout } = runQuiet(
    "dig",
    ["+short", "+time=3", "+tries=1", DNS_QUERY],
    PROBE_TIMEOUT_MS,
  );
  const latencyMs = Date.now() - started;
  const answers = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (code === 0 && answers.length > 0) {
    return {
      latencyMs,
      message: msg(`${answers.length} answer${answers.length === 1 ? "" : "s"} in ${latencyMs}ms`),
      service,
      status: "ok",
    };
  }

  return {
    latencyMs,
    message: msg(code === 124 ? "dig timeout" : "no answer"),
    service,
    status: "down",
  };
}

// ---------------------------------------------------------------------------
// PROBE: ssh — a TCP-connect to ${SSH_HOST}:${SSH_PORT} (node:net, hard timeout).
// ok if it connects. We never speak the SSH protocol — a successful TCP handshake
// is liveness enough. The message reports latency only (no host/port).
// ---------------------------------------------------------------------------

function probeSsh(): Promise<Check> {
  const service = "ssh";

  if (!SSH_HOST || !Number.isInteger(SSH_PORT) || SSH_PORT <= 0) {
    return Promise.resolve({
      latencyMs: null,
      message: msg("not configured"),
      service,
      status: "down",
    });
  }

  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;

    const socket = connect({ host: SSH_HOST, port: SSH_PORT });

    const finish = (status: Status, message: string) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve({ latencyMs: Date.now() - started, message: msg(message), service, status });
    };

    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish("ok", `connected in ${Date.now() - started}ms`));
    socket.once("timeout", () => finish("down", "tcp timeout"));
    socket.once("error", () => finish("down", "tcp refused"));
  });
}

// ---------------------------------------------------------------------------
// PROBE: automation — the on-box Hermes crons, aggregated to ONE service. For each
// known cron, find its output dir (matched by name within ~/.hermes/cron/output/),
// take the newest *.md, parse its LAST content line as JSON and check `.ok !== false`,
// AND require the file mtime within ~3× the cron's cadence. ok if all healthy+fresh;
// degraded (naming the laggards) otherwise. A cron with NO output dir yet is
// "no data" — treated as ok-unknown, NOT down (a freshly-rebuilt box hasn't ticked).
// ---------------------------------------------------------------------------

// Each cron's NAME (as it appears in its output dir name) + its cadence in ms. The
// staleness budget is 3× the cadence: a job that hasn't produced output in three of
// its own cycles is genuinely lagging.
const AUTOMATION_CRONS: { cadenceMs: number; name: string }[] = [
  { cadenceMs: 5 * 60_000, name: "enrich" },
  { cadenceMs: 5 * 60_000, name: "context-note" },
  { cadenceMs: 10 * 60_000, name: "note" },
  { cadenceMs: 60 * 60_000, name: "observation" },
  { cadenceMs: 30 * 60_000, name: "backfill" },
  { cadenceMs: 60 * 60_000, name: "render" },
  { cadenceMs: 7 * 24 * 60 * 60_000, name: "newsletter" }, // weekly — a generous floor
];

type CronVerdict = "fresh-ok" | "lagging" | "failed" | "no-data";

/**
 * Map each cron-output dir to the cron that OWNS it — longest cron name first, and a
 * dir is claimed only ONCE. This is the fix for the "note" ⊂ "context-note" overlap:
 * a bare `note` cron must not grab the `context-note` dir (or vice versa). The runner
 * names dirs by job id, but the operator-given `--name fluncle-<cron>` is part of it,
 * so we match on the cron's bare name as a substring and let the most-specific
 * (longest) name claim each dir exclusively.
 */
function claimCronDirs(crons: { cadenceMs: number; name: string }[]): Map<string, string> {
  const claimed = new Map<string, string>(); // cron name -> dir path

  if (!existsSync(CRON_OUTPUT_DIR)) {
    return claimed;
  }

  let dirs: string[];

  try {
    dirs = readdirSync(CRON_OUTPUT_DIR)
      .map((entry) => join(CRON_OUTPUT_DIR, entry))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return claimed;
  }

  const used = new Set<string>(); // dir paths already claimed
  const byLongest = [...crons].sort((a, b) => b.name.length - a.name.length);

  for (const cron of byLongest) {
    const dir = dirs.find(
      (path) => !used.has(path) && path.toLowerCase().includes(cron.name.toLowerCase()),
    );

    if (dir) {
      claimed.set(cron.name, dir);
      used.add(dir);
    }
  }

  return claimed;
}

/** Judge one cron's claimed dir: newest *.md fresh-enough AND its last line `.ok !== false`. */
function judgeCron(
  cron: { cadenceMs: number; name: string },
  dir: string | undefined,
): CronVerdict {
  if (!dir) {
    return "no-data"; // no output dir yet — defensively ok-unknown, never down
  }

  let runFiles: { mtimeMs: number; path: string }[];

  try {
    runFiles = readdirSync(dir)
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => join(dir, entry))
      .map((path) => ({ mtimeMs: statSync(path).mtimeMs, path }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return "no-data";
  }

  const newest = runFiles[0];

  if (!newest) {
    return "no-data"; // dir exists but no runs yet
  }

  // Freshness: a run within 3× the cadence (plus a small floor for clock jitter).
  const ageMs = Date.now() - newest.mtimeMs;
  const staleBudgetMs = Math.max(cron.cadenceMs * 3, 90_000);

  if (ageMs > staleBudgetMs) {
    return "lagging";
  }

  // Content health: the LAST non-empty line parsed as JSON, `.ok !== false`. A run
  // whose summary isn't JSON (or has no `ok`) is treated as healthy — only an
  // explicit `{ ok: false }` is a failure (the sweeps emit that on a hard stop).
  let lastLine = "";

  try {
    const lines = readFileSync(newest.path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    lastLine = lines[lines.length - 1] ?? "";
  } catch {
    return "fresh-ok"; // unreadable body but fresh file — don't false-alarm
  }

  try {
    const parsed = JSON.parse(lastLine) as { ok?: unknown };

    if (parsed && typeof parsed === "object" && parsed.ok === false) {
      return "failed";
    }
  } catch {
    // Not JSON — fine; many cron summaries are a human line. Freshness governs.
  }

  return "fresh-ok";
}

function probeAutomation(): Check {
  const service = "automation";
  // Claim each output dir to its most-specific cron first (handles "note" ⊂
  // "context-note"), then judge each cron against the dir it actually owns.
  const claimed = claimCronDirs(AUTOMATION_CRONS);

  const lagging: string[] = [];
  const failed: string[] = [];
  let evaluated = 0;

  for (const cron of AUTOMATION_CRONS) {
    const verdict = judgeCron(cron, claimed.get(cron.name));

    if (verdict === "no-data") {
      continue; // ok-unknown — a cron that hasn't ticked yet doesn't count against us
    }

    evaluated += 1;

    if (verdict === "lagging") {
      lagging.push(cron.name);
    } else if (verdict === "failed") {
      failed.push(cron.name);
    }
  }

  if (failed.length > 0 || lagging.length > 0) {
    const parts: string[] = [];

    if (failed.length > 0) {
      parts.push(`failed: ${failed.join(", ")}`);
    }

    if (lagging.length > 0) {
      parts.push(`lagging: ${lagging.join(", ")}`);
    }

    return { latencyMs: null, message: msg(parts.join("; ")), service, status: "degraded" };
  }

  if (evaluated === 0) {
    return { latencyMs: null, message: msg("no cron output yet"), service, status: "ok" };
  }

  return {
    latencyMs: null,
    message: msg(`${evaluated} cron${evaluated === 1 ? "" : "s"} fresh`),
    service,
    status: "ok",
  };
}

// ---------------------------------------------------------------------------
// PROBE: render-box — read the render conductor's state file (idle | rendering,
// both ok). A missing file = "not yet provisioned" (ok — the conductor simply
// hasn't run). We NEVER wake/ssh the box (it's scale-to-zero). Optionally append
// box.ascii plan usage if `box limits --json` returns it (best-effort; `box status`
// exits 0 even unauthed, so we don't trust an exit code — only parse JSON usage).
// ---------------------------------------------------------------------------

function probeRenderBox(): Check {
  const service = "render-box";

  let conductorState = "";

  if (existsSync(RENDER_STATE_FILE)) {
    try {
      conductorState = readFileSync(RENDER_STATE_FILE, "utf8").trim();
    } catch {
      conductorState = "";
    }
  }

  const stateLabel =
    conductorState === "idle" || conductorState === "rendering"
      ? conductorState
      : conductorState
        ? "unknown state"
        : "not yet provisioned";

  // Best-effort plan usage. `box limits --json` is the documented command (an earlier
  // scan wrongly said `box list`/`box limits` don't exist — they do). We DON'T gate
  // on `box status` (it exits 0 even unauthed); we only enrich the message if limits
  // returns parseable usage. A missing CLI / non-JSON output is silently skipped.
  let usageSuffix = "";

  const limits = runQuiet(BOX_BIN, ["limits", "--json"], PROBE_TIMEOUT_MS);

  if (limits.code === 0 && limits.stdout.trim()) {
    try {
      const parsed = JSON.parse(limits.stdout) as Record<string, unknown>;
      const used = parsed.used ?? parsed.hoursUsed ?? parsed.usage;
      const cap = parsed.limit ?? parsed.hours ?? parsed.cap;

      // Only format genuine primitive usage values — narrowing to number|string
      // both satisfies no-base-to-string and skips any object/array shape that
      // would otherwise stringify to "[object Object]".
      const isPrimitive = (value: unknown): value is number | string =>
        typeof value === "number" || typeof value === "string";

      if (isPrimitive(used) && isPrimitive(cap)) {
        usageSuffix = `, plan ${used}/${cap}`;
      }
    } catch {
      // Not parseable usage — skip; the state alone is the health signal.
    }
  }

  return {
    latencyMs: null,
    message: msg(`${stateLabel}${usageSuffix}`),
    service,
    status: "ok",
  };
}

// ---------------------------------------------------------------------------
// PROBE: hermes — this cron runs ON the Hermes box, so reaching this line is
// self-evident liveness. Always ok.
// ---------------------------------------------------------------------------

function probeHermes(): Check {
  return {
    latencyMs: null,
    message: msg("cron host responsive"),
    service: "hermes",
    status: "ok",
  };
}

// ---------------------------------------------------------------------------
// State: the transition memory. Load the prior map, compute `transitioned` per
// check, write the new map back. A read/parse failure starts from an empty map (so
// the FIRST tick after a state loss reports every service as a fresh transition —
// acceptable, it just re-baselines).
// ---------------------------------------------------------------------------

function loadState(): StateMap {
  if (!existsSync(STATE_FILE)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as unknown;

    if (parsed && typeof parsed === "object") {
      return parsed as StateMap;
    }
  } catch (error) {
    log(
      `could not read state (${error instanceof Error ? error.message : String(error)}) — re-baselining`,
    );
  }

  return {};
}

function writeState(checks: Check[]): void {
  const next: StateMap = {};

  for (const check of checks) {
    next[check.service] = check.status;
  }

  try {
    // mkdir -p the state dir (recursive is a no-op when it already exists).
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (error) {
    log(`could not write state (${error instanceof Error ? error.message : String(error)})`);
  }
}

// ---------------------------------------------------------------------------
// ALERT: Discord-ping ONLY on a transition — a service going down, or recovering
// (down → ok/degraded). Steady state pings nothing (no spam). Best-effort; never
// throws. Reuses observe-sweep's curl-webhook shape.
// ---------------------------------------------------------------------------

function pingDiscord(content: string): void {
  if (!DISCORD_ALERT_WEBHOOK) {
    log("no DISCORD_ALERT_WEBHOOK — skipping the transition ping");

    return;
  }

  try {
    const body = JSON.stringify({ content });
    const { code } = runQuiet(
      "curl",
      [
        "-sS",
        "-X",
        "POST",
        "-H",
        "Content-Type: application/json",
        "-d",
        body,
        "--max-time",
        "10",
        DISCORD_ALERT_WEBHOOK,
      ],
      12_000,
    );

    if (code !== 0) {
      log(`discord alert POST exited ${code} (best-effort, ignored)`);
    }
  } catch (error) {
    log(
      `discord alert failed (best-effort, ignored): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// BEACON: the external dead-man's-switch ping. A completed tick = "the prober
// ran", so we curl the operator-set ${BEACON_URL} at the end of every tick. The
// external service (healthchecks.io / BetterUptime / self-hosted) flips when the
// pings STOP — the only signal that catches THIS box (the prober) going dark,
// since a dead prober can't alert about itself. Provider-agnostic (just a URL),
// OPTIONAL (unset ⇒ skipped), and strictly best-effort: a short --max-time curl
// that never throws and only logs to stderr on failure. A failed beacon must never
// affect the tick's exit status (the snapshot + Discord alert have already fired).
// ---------------------------------------------------------------------------

function pingBeacon(): void {
  if (!BEACON_URL) {
    return; // No beacon configured — skip silently (it's optional).
  }

  try {
    const { code } = runQuiet(
      "curl",
      ["-sS", "-o", "/dev/null", "--max-time", "10", BEACON_URL],
      12_000,
    );

    if (code !== 0) {
      log(`beacon ping exited ${code} (best-effort, ignored)`);
    }
  } catch (error) {
    log(
      `beacon ping failed (best-effort, ignored): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Build the alert text from the transitions; returns null when nothing alert-worthy. */
function buildAlert(checks: CheckWithTransition[], prev: StateMap): string | null {
  const nowDown: string[] = [];
  const recovered: string[] = [];

  for (const check of checks) {
    if (!check.transitioned) {
      continue;
    }

    if (check.status === "down") {
      nowDown.push(check.service);
    } else if (prev[check.service] === "down") {
      // A flip OUT of `down` (→ ok or degraded) is a recovery worth announcing.
      recovered.push(check.service);
    }
  }

  if (nowDown.length === 0 && recovered.length === 0) {
    return null;
  }

  const parts: string[] = [];

  if (nowDown.length > 0) {
    parts.push(`🔴 DOWN: ${nowDown.join(", ")}`);
  }

  if (recovered.length > 0) {
    parts.push(`🟢 recovered: ${recovered.join(", ")}`);
  }

  return `Fluncle status: ${parts.join(" — ")}`;
}

// ---------------------------------------------------------------------------
// POST: send the snapshot to the agent-tier record_health endpoint. Best-effort —
// the alert already fired, so a failed POST is logged, never thrown. Returns true
// on a 2xx ack.
// ---------------------------------------------------------------------------

async function postSnapshot(at: string, checks: CheckWithTransition[]): Promise<boolean> {
  if (!WORKER_URL) {
    log("no HEALTHCHECK_WORKER_URL — cannot POST the snapshot");

    return false;
  }

  if (!FLUNCLE_API_TOKEN) {
    log("no FLUNCLE_API_TOKEN in the cron env — cannot POST the snapshot");

    return false;
  }

  const body = JSON.stringify({
    at,
    checks: checks.map((check) => ({
      latencyMs: check.latencyMs,
      message: check.message,
      service: check.service,
      status: check.status,
      transitioned: check.transitioned,
    })),
  });

  try {
    const response = await fetchWithTimeout(`${WORKER_URL}/api/admin/health`, {
      body,
      headers: {
        Authorization: `Bearer ${FLUNCLE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    if (!response.ok) {
      log(`record_health POST returned HTTP ${response.status} (best-effort, ignored)`);

      return false;
    }

    return true;
  } catch (error) {
    log(
      `record_health POST failed (best-effort, ignored): ${error instanceof Error ? error.message : String(error)}`,
    );

    return false;
  }
}

// ---------------------------------------------------------------------------
// Main — probe everything (parallel), compute transitions, alert + POST.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const at = new Date().toISOString();

  // Network probes run concurrently; the file/state probes are synchronous and
  // cheap. All probes are individually timeout-bounded, so the whole tick stays
  // well under the runner's ~120s kill.
  const [web, r2, ssh] = await Promise.all([probeWeb(), probeR2(), probeSsh()]);
  const dns = probeDns();
  const automation = probeAutomation();
  const renderBox = probeRenderBox();
  const hermes = probeHermes();

  const checks: Check[] = [web, r2, dns, ssh, automation, renderBox, hermes];

  // Transitions against the prior state map.
  const prev = loadState();
  const withTransition: CheckWithTransition[] = checks.map((check) => ({
    ...check,
    transitioned: prev[check.service] !== undefined && prev[check.service] !== check.status,
  }));

  // Persist the new map for the next tick BEFORE the network POST (so a POST failure
  // never loses the transition baseline).
  writeState(checks);

  // Alert ONLY on a transition to down or a recovery from down.
  const alert = buildAlert(withTransition, prev);

  if (alert) {
    pingDiscord(alert);
  }

  // Persist the snapshot to the page (best-effort).
  const posted = await postSnapshot(at, withTransition);

  // Reaching here means the tick completed — ping the external dead-man's-switch
  // beacon so an outside service can alert if THIS box (the prober) ever stops
  // ticking. Best-effort + optional; never affects the run's exit status.
  pingBeacon();

  // One JSON summary line — the cron run output. `ok` reflects the PROBE run, not the
  // services' health (the snapshot carries that); a down service is a normal,
  // successful tick. `ok:false` would only mean the prober itself couldn't run.
  const summary = {
    alerted: alert !== null,
    at,
    down: withTransition.filter((c) => c.status === "down").map((c) => c.service),
    ok: true as const,
    posted,
    services: withTransition.map((c) => ({
      service: c.service,
      status: c.status,
      transitioned: c.transitioned,
    })),
    transitions: withTransition.filter((c) => c.transitioned).map((c) => c.service),
  };

  console.log(JSON.stringify(summary));
}

main().catch((error) => {
  // A truly unexpected failure (not a probe failure — those are caught per-probe).
  log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  console.log(JSON.stringify({ ok: false, reason: "prober_error" }));
  process.exit(1);
});
