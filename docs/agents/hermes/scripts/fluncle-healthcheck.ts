#!/usr/bin/env bun
// fluncle-healthcheck.ts — the bun orchestrator behind `fluncle-healthcheck`, the
// prober for Fluncle's public /status dashboard.
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (fluncle-healthcheck.sh)
// which a rave-02 HOST systemd timer `docker exec`s every ~10m — NOT a Hermes
// `--no-agent` gateway cron. It was moved to a host timer so the prober isn't starved
// by the busy gateway it monitors; see ../healthcheck-timer/README.md (the units + the
// one-time deploy) and that .sh's header for the env keys.
//
// THE TICK (all deterministic — no model time):
//   1. PROBE each service in parallel, each with a short timeout (3–5s) so one hung
//      target can't blow the runner's ~120s budget:
//        web         — GET ${HEALTHCHECK_WORKER_URL}/api/v1/health, timed.
//        r2          — HEAD ${HEALTHCHECK_R2_PROBE_URL}.
//        sonar       — GET ${HEALTHCHECK_SONAR_URL}/health; ok ONLY when the body
//                      parses and says `ok: true` (the similarity engine holds its
//                      corpus in memory and answers nothing until it is built).
//        dns         — dig +short ${HEALTHCHECK_DNS_QUERY} (non-empty answer = ok).
//        ssh         — TCP-connect ${HEALTHCHECK_SSH_HOST}:${HEALTHCHECK_SSH_PORT}.
//        disk        — `df` the box's root fs (via the /opt/data mount); degraded
//                      past ~85% full, down past ~93% — catches a filling disk
//                      before it strands the next pin-watch rebuild.
//        cron.*      — read ~/.hermes/cron/output/<job>/ per Hermes cron: newest *.md,
//                      fresh within ~3× the cron's cadence, AND carrying the sweep's
//                      contracted JSON summary with `.ok !== false`. A marker with NO
//                      summary is a run that was KILLED before it could speak → down (see
//                      judgeCron). Emitted as ONE service PER cron (service id = the
//                      registry surface name, e.g. `cron.enrich`), so /status shows every
//                      humming system on its own row — not one aggregate.
//        render-box  — read ${HOME}/.render-conductor/state (idle|rendering both ok;
//                      missing = "not yet provisioned", ok). NEVER wakes the box.
//        hermes      — self-evident: this prober runs ON the box, so ok.
//        cron.healthcheck — self-evident: this IS the prober; reaching here means its
//                      host timer fired → ok (it has no gateway output dir to read).
//      (onion — OUT OF SCOPE for v1; see the TODO below.)
//   2. TRANSITIONS + STREAKS: load ${HOME}/.healthcheck/state.json (service → last
//      status + how many consecutive ticks it has been down); a probe `transitioned`
//      when prev !== current. Write the new map back.
//   3. ALERT: if any service transitioned to `down`, OR any recovered (down → ok/
//      degraded), Discord-ping once (best-effort) naming what changed. Nothing
//      changed → no ping (no spam). PLUS: a service that stays down long enough
//      escalates on a doubling ladder (see ESCALATE_AFTER_TICKS) so a sustained
//      outage keeps speaking instead of going quiet after its one edge-triggered ping.
//   4. POST the snapshot to ${HEALTHCHECK_WORKER_URL}/api/v1/admin/health (record_health,
//      Authorization: Bearer ${FLUNCLE_API_TOKEN}). Best-effort: the alert already
//      fired, so a failed POST is logged, never thrown.
//
// stdout: ONE JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Config — every probe target comes from the file-sourced env (the .sh sources
// ${HOME}/.healthcheck.env before exec'ing us); FLUNCLE_API_TOKEN rides the cron
// env. NO hostnames/ports/paths are hard-coded — public-safe by construction.
// ---------------------------------------------------------------------------

const HOME = process.env.HOME ?? homedir() ?? "/opt/data/home";

const WORKER_URL = (process.env.HEALTHCHECK_WORKER_URL ?? "").replace(/\/+$/, "");
const R2_PROBE_URL = process.env.HEALTHCHECK_R2_PROBE_URL ?? "";
// The sonic-similarity engine's health origin — deliberately its PUBLIC URL, not the
// origin behind it (see probeSonar). Unset ⇒ the row reports "not configured".
const SONAR_URL = (process.env.HEALTHCHECK_SONAR_URL ?? "").replace(/\/+$/, "");
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

// The snapshot POST is a Turso WRITE through the Worker, not a cheap probe GET, so it
// needs a far longer budget than PROBE_TIMEOUT_MS — a cold Worker + DB write under box
// load runs many seconds. Sharing the 4s probe timeout was aborting the vast majority
// of posts, starving /status and flapping the rave-01 watchdog. It also retries a
// transient abort before giving up (best-effort delivery of an already-computed
// snapshot; a lost tick simply goes stale on /status). Both env-overridable.
const POST_TIMEOUT_MS = Number.parseInt(process.env.HEALTHCHECK_POST_TIMEOUT_MS ?? "", 10) || 20000;
const POST_ATTEMPTS = Number.parseInt(process.env.HEALTHCHECK_POST_ATTEMPTS ?? "", 10) || 3;

// ESCALATION — the counterpart to edge-triggered alerting. The transition alert fires
// ONCE, when a service flips to down; a service that then STAYS down is silent forever
// after by construction. (Measured 2026-07-27: one sweep failed every hour for ~20 hours
// and every single tick read `transitioned: false ⇒ alerted: false`. The prober was right
// the whole time and never said so twice.) So the prober also counts CONSECUTIVE down
// ticks per service and speaks again once that count crosses a threshold — which turns
// DURATION into its own signal, the one thing neither notification path could express.
//
// The default of 6 ticks reads off the prober's own cadence: the host timer fires every
// ~10m (OnUnitActiveSec in ../healthcheck-timer/fluncle-healthcheck.timer), so 6
// consecutive down ticks ≈ 1 hour of unbroken failure — long enough that every
// self-healing sweep has had several retries and a flap has resolved, short enough that a
// terminal condition (a depleted budget, a revoked credential) is heard the same hour.
//
// DEAD-MAN'S CAVEAT: this escalates only for surfaces the prober probes WHILE IT IS
// ALIVE. A prober that dies escalates nothing about anything — that case is covered by
// the separate external dead-man's-switch beacon (pingBeacon below), which alerts when
// the ticks STOP. Out of scope here; noted so this is never mistaken for full coverage.
const ESCALATE_AFTER_TICKS = Number.parseInt(process.env.HEALTHCHECK_ESCALATE_AFTER ?? "", 10) || 6;

// The tick cadence, used ONLY to turn a streak into the approximate wall-clock duration
// the escalation text carries. Mirrors the timer unit's OnUnitActiveSec; if that ever
// changes, change this with it (or set HEALTHCHECK_TICK_MS in the box env).
const TICK_INTERVAL_MS = Number.parseInt(process.env.HEALTHCHECK_TICK_MS ?? "", 10) || 10 * 60_000;

// State (the transition + streak memory) lives in the mounted, writable HOME.
const STATE_DIR = join(HOME, ".healthcheck");
const STATE_FILE = join(STATE_DIR, "state.json");

// Where the Hermes cron runner saves each job's per-run output.
// The Hermes gateway writes per-run cron output to <data-root>/cron/output/<job-id>/.
// The data root is the parent of the cron user's HOME (HOME=/opt/data/home → the
// /opt/data mount); operator-overridable via HEALTHCHECK_CRON_OUTPUT_DIR for a
// non-standard layout.
const CRON_OUTPUT_DIR =
  process.env.HEALTHCHECK_CRON_OUTPUT_DIR ?? join(dirname(HOME), "cron", "output");
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

/**
 * What the prober remembers about one service between ticks: its last status, how many
 * CONSECUTIVE ticks it has read `down` (0 whenever it isn't), and the streak at which it
 * was last escalated (0 = never, which re-arms the ladder on every recovery).
 */
export type ServiceState = { downStreak: number; escalatedStreak: number; status: Status };

type StateMap = Record<string, ServiceState>;

/** One service due an escalation this tick. */
export type Escalation = { service: string; streak: number };

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
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
// PROBE: web — GET ${WORKER_URL}/api/v1/health, timed. ok on a 200; down otherwise.
// The message reports the code + elapsed ms (no host).
// ---------------------------------------------------------------------------

async function probeWeb(): Promise<Check> {
  const service = "web";

  if (!WORKER_URL) {
    return { latencyMs: null, message: msg("not configured"), service, status: "down" };
  }

  const started = Date.now();

  try {
    const response = await fetchWithTimeout(`${WORKER_URL}/api/v1/health`, { method: "GET" });
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
// PROBE: db — GET ${WORKER_URL}/api/v1/status and read `dbProbe.roundTripMs`, the WORKER's own
// `select 1` round-trip to the Turso primary (aws-eu-west-1, Dublin). That is the path a
// visitor's page load pays (edge Worker → Dublin), NOT this box's path — the honest read on
// Turso latency + jitter over time. ok when snappy, degraded when it drags, down when the
// Worker could not reach Turso (the field is null) or /api/v1/status is unreachable. Recording
// it as its own service feeds the sample into the existing `service_check_samples` uptime bar.
// ---------------------------------------------------------------------------

const DB_OK_MS = Number.parseInt(process.env.HEALTHCHECK_DB_OK_MS ?? "", 10) || 250;
const DB_DEGRADED_MS = Number.parseInt(process.env.HEALTHCHECK_DB_DEGRADED_MS ?? "", 10) || 1500;

async function probeDb(): Promise<Check> {
  const service = "db";

  if (!WORKER_URL) {
    return { latencyMs: null, message: msg("not configured"), service, status: "down" };
  }

  try {
    const response = await fetchWithTimeout(`${WORKER_URL}/api/v1/status`, { method: "GET" });

    if (response.status !== 200) {
      return {
        latencyMs: null,
        message: msg(`/api/v1/status HTTP ${response.status}`),
        service,
        status: "down",
      };
    }

    const body = (await response.json()) as { dbProbe?: { roundTripMs?: number } | null };
    const roundTripMs = body.dbProbe?.roundTripMs ?? null;

    if (roundTripMs === null) {
      return {
        latencyMs: null,
        message: msg("Worker could not reach Turso"),
        service,
        status: "down",
      };
    }

    const status: Status =
      roundTripMs <= DB_OK_MS ? "ok" : roundTripMs <= DB_DEGRADED_MS ? "degraded" : "down";

    return {
      latencyMs: roundTripMs,
      message: msg(`select 1 in ${roundTripMs}ms`),
      service,
      status,
    };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError" ? "timeout" : "unreachable";

    return { latencyMs: null, message: msg(`/api/v1/status ${reason}`), service, status: "down" };
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
// PROBE: sonar — GET ${SONAR_URL}/health. The similarity engine holds its whole
// corpus in memory and only starts answering once both indexes are built, so a
// reachable-but-unbuilt engine is exactly the state worth catching: ok ONLY when the
// response is 2xx AND the body parses AND `ok` is true. A non-2xx, an unreadable
// body, or a timeout is an honest down.
//
// SONAR_URL is deliberately the engine's PUBLIC URL rather than its origin: the
// origin's firewall admits only the CDN, so the origin isn't reachable from here
// anyway — and probing the path a visitor's search actually travels catches a
// CDN-side misconfiguration too, not just a dead engine.
//
// The message reports the code + elapsed ms, never a host.
// ---------------------------------------------------------------------------

async function probeSonar(): Promise<Check> {
  const service = "sonar";

  if (!SONAR_URL) {
    return { latencyMs: null, message: msg("not configured"), service, status: "down" };
  }

  const started = Date.now();

  try {
    const response = await fetchWithTimeout(`${SONAR_URL}/health`, { method: "GET" });
    const latencyMs = Date.now() - started;

    if (response.status < 200 || response.status >= 300) {
      return {
        latencyMs,
        message: msg(`HTTP ${response.status} in ${latencyMs}ms`),
        service,
        status: "down",
      };
    }

    // The body parse is its own try so a 200 carrying junk reads as "unreadable",
    // not as the outer catch's misleading "unreachable".
    let ready = false;

    try {
      const body = (await response.json()) as { ok?: unknown };

      ready = body.ok === true;
    } catch {
      return { latencyMs, message: msg("unreadable health body"), service, status: "down" };
    }

    if (!ready) {
      return { latencyMs, message: msg("engine reports not ready"), service, status: "down" };
    }

    return { latencyMs, message: msg(`200 in ${latencyMs}ms`), service, status: "ok" };
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
  // Split DNS_QUERY into argv so the query can carry a record TYPE, e.g.
  // "random.dig.fluncle.com TXT" → ["random.dig.fluncle.com", "TXT"]. Fluncle's
  // own nameserver (fluncle-dns) serves TXT records, so a bare name (default A)
  // would get NODATA and read as a false "down"; the type is required.
  const { code, stdout } = runQuiet(
    "dig",
    ["+short", "+time=3", "+tries=1", ...DNS_QUERY.trim().split(/\s+/)],
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
// PROBE: disk — the agent box's root-filesystem headroom. This prober runs INSIDE
// the hermes container, whose HOME (/opt/data/home) sits under the /opt/data bind
// mount from the host's root fs, so `df` there reports the SAME disk the host fills.
// Each fluncle-hermes image is large and a pin-watch rebuild transiently needs a
// second one, so a quietly filling disk is the recurring failure that strands the
// next rebuild with "no space left on device". Surfacing it here catches it BEFORE
// a rebuild fails: degraded past DISK_DEGRADED_PCT, down past DISK_DOWN_PCT. The
// message reports the percent used only — never a host, mount, or path (public-safe).
// A missing/unparsable `df` degrades to ok, never a false alarm. All env-overridable.
// ---------------------------------------------------------------------------

const DISK_PROBE_PATH = process.env.HEALTHCHECK_DISK_PATH ?? HOME;
const DISK_DEGRADED_PCT =
  Number.parseInt(process.env.HEALTHCHECK_DISK_DEGRADED_PCT ?? "", 10) || 85;
const DISK_DOWN_PCT = Number.parseInt(process.env.HEALTHCHECK_DISK_DOWN_PCT ?? "", 10) || 93;

function probeDisk(): Check {
  const service = "disk";

  // `df -P -k <path>`: POSIX-portable, one filesystem row after the header; the
  // "Use%" column carries the integer percentage we key off.
  const { code, stdout } = runQuiet("df", ["-P", "-k", DISK_PROBE_PATH], PROBE_TIMEOUT_MS);

  if (code !== 0) {
    return { latencyMs: null, message: msg("df unavailable"), service, status: "ok" };
  }

  const dataLine = stdout.trim().split("\n").slice(1).pop() ?? "";
  const percentMatch = dataLine.match(/(\d+)%/);
  const usedPct = Number.parseInt(percentMatch?.[1] ?? "", 10);

  if (!Number.isFinite(usedPct)) {
    return { latencyMs: null, message: msg("df unparsable"), service, status: "ok" };
  }

  if (usedPct >= DISK_DOWN_PCT) {
    return { latencyMs: null, message: msg(`${usedPct}% full`), service, status: "down" };
  }

  if (usedPct >= DISK_DEGRADED_PCT) {
    return { latencyMs: null, message: msg(`${usedPct}% full`), service, status: "degraded" };
  }

  return { latencyMs: null, message: msg(`${usedPct}% used`), service, status: "ok" };
}

// ---------------------------------------------------------------------------
// PROBE: crons — the on-box Hermes crons, ONE service row PER cron (not one
// aggregate). For each known cron, find its output dir (dirs are named by job id,
// so each is resolved to its cron via the run-file's `# Cron Job:` header), take the
// newest *.md, parse its LAST content line as JSON and check `.ok !== false`, AND
// require the file mtime within ~3× the cron's cadence. Per cron: ok if fresh+healthy,
// degraded if lagging, down if its last run failed (`{ ok: false }`). A cron with NO
// output dir yet is "no data" — emitted as ok with a "no runs yet" note, NEVER down
// (a freshly-rebuilt box hasn't ticked). The service id is the cron's @fluncle/registry
// surface name (e.g. `cron.enrich`) so the box prober and the Worker /status page share
// one vocabulary; this file is deployed standalone to the box (no workspace resolution),
// so the list is mirrored inline here — keep it in lockstep with the registry's
// cronSurfaces().
// ---------------------------------------------------------------------------

// Each cron's registry surface name (the emitted service id) + the bare token its
// output-dir `# Cron Job:` header contains (e.g. the dir for `fluncle-context-note`
// matches "context-note") + its cadence in ms. The staleness budget is 3× the
// cadence: a job that hasn't produced output in three of its own cycles is genuinely
// lagging.
//
// THIS LIST IS NO LONGER HAND-KEPT — it is hand-CARRIED, and asserted.
// cron-roster.ts DERIVES the same roster from the committed systemd timer units
// (docs/agents/hermes/*/*.timer → the paired .service's ExecStart → the
// `emit_cron_output <token>` it reaches → the timer's own OnUnitActiveSec/OnCalendar),
// and cron-roster.test.ts fails the build when this literal and that derivation
// disagree, in either direction, on either the token set or the cadence. It binds
// @fluncle/registry's cron surfaces to the same units in the same pass, so all three
// statements of one fact move together.
//
// It stays a literal here because the prober is deployed standalone: the image bakes
// docs/agents/hermes/scripts/ and nothing else, while the timer units are laid down on
// the HOST by install-host-timers.sh and never enter the container — so the box cannot
// read a unit at tick time. The comments below (the claim-collision notes) are the part
// no derivation can produce; keep writing them.
//
// The largest `RandomizedDelaySec` any committed sweep timer carries, in ms. Every timer
// under docs/agents/hermes/*-timer/ jitters each firing so that a mass restart (a pin-watch
// quiesce/restore) cannot re-align the roster onto libSQL's single writer — so an observed
// gap is ALWAYS the cadence plus up to this much, and any freshness budget that omits it is
// judging the fleet against a period no timer was ever going to hit.
//
// One constant rather than a per-cron mirror of the unit files, because a hand-kept mirror
// drifts and this is the conservative direction: taking the maximum can only ever make a
// budget more forgiving, never wrongly strict. `fluncle-healthcheck.test.ts` reads every
// committed .timer and fails the build if one ever exceeds this, so the constant cannot
// silently fall behind the units it stands for.
export const MAX_TIMER_JITTER_MS = 90_000;

// One known cron: the registry surface id we emit, the bare token its output-dir
// header carries, and its cadence.
export type CronDef = { cadenceMs: number; match: string; service: string };

export const AUTOMATION_CRONS: CronDef[] = [
  { cadenceMs: 5 * 60_000, match: "enrich", service: "cron.enrich" },
  { cadenceMs: 5 * 60_000, match: "embed", service: "cron.embed" },
  { cadenceMs: 24 * 60 * 60_000, match: "cluster", service: "cron.cluster" }, // nightly sonic-galaxy assignment
  // NB: `social-capture` (a longer match) claims the fluncle-social-capture dir FIRST
  // (claimCronDirs is longest-match-first), so a bare `capture` never mis-claims it —
  // it resolves to the fluncle-capture dir. Keep both entries.
  { cadenceMs: 5 * 60_000, match: "capture", service: "cron.capture" },
  { cadenceMs: 5 * 60_000, match: "context-note", service: "cron.context-note" },
  { cadenceMs: 10 * 60_000, match: "note", service: "cron.note" },
  { cadenceMs: 30 * 60_000, match: "artist-bio", service: "cron.artist-bio" }, // artist voiced-bio author — every 30m
  { cadenceMs: 30 * 60_000, match: "label-bio", service: "cron.label-bio" }, // label voiced-bio author — every 30m
  { cadenceMs: 30 * 60_000, match: "album-bio", service: "cron.album-bio" }, // album voiced-bio author — every 30m
  { cadenceMs: 15 * 60_000, match: "triage", service: "cron.triage" }, // submission pre-chew — every 15m
  { cadenceMs: 60 * 60_000, match: "observation", service: "cron.observation" },
  { cadenceMs: 30 * 60_000, match: "backfill", service: "cron.backfill" },
  { cadenceMs: 10 * 60_000, match: "crawl", service: "cron.crawl" }, // catalogue crawl — one bounded MusicBrainz pass per tick
  { cadenceMs: 24 * 60 * 60_000, match: "label-releases", service: "cron.label-releases" }, // freshness tap — day-one Spotify releases for enabled seed labels
  { cadenceMs: 30 * 60_000, match: "rank", service: "cron.rank" }, // The Ear's ranking — drains the stale catalogue
  { cadenceMs: 60 * 60_000, match: "anchor", service: "cron.anchor" }, // catalogue Spotify anchors via Apify — one bounded batch per hour
  { cadenceMs: 60 * 60_000, match: "isrc-recovery", service: "cron.isrc-recovery" }, // free Deezer ISRC recovery — one paced batch per hour
  { cadenceMs: 60 * 60_000, match: "device-mirror", service: "cron.device-mirror" }, // shared anchored-cut device replica — full diff, in-place writes
  { cadenceMs: 60 * 60_000, match: "label-images", service: "cron.label-images" }, // label logos — resolve one bounded batch of pending labels per tick
  { cadenceMs: 60 * 60_000, match: "recording-mbids", service: "cron.recording-mbids" }, // MusicBrainz recording MBIDs — crawler PK strip + ISRC resolve, one bounded batch per tick
  { cadenceMs: 60 * 60_000, match: "artist-edges", service: "cron.artist-edges" }, // track_artists graph backfill — fold artists_json names onto existing artist identities, one bounded batch per tick
  { cadenceMs: 5 * 60_000, match: "artist-credits", service: "cron.artist-credits" }, // MB credit sweep — mint identity-true artists from MusicBrainz credits for slice 0's zero-matched residual, one bounded batch per tick
  { cadenceMs: 60 * 60_000, match: "label-lineage", service: "cron.label-lineage" }, // label founding + parent imprint from MusicBrainz — one bounded batch per tick
  { cadenceMs: 60 * 60_000, match: "cover-masters", service: "cron.cover-masters" }, // owned album/artist cover masters — one bounded batch per tick
  { cadenceMs: 60 * 60_000, match: "artist-sweep", service: "cron.artist-sweep" },
  { cadenceMs: 10 * 60_000, match: "social-capture", service: "cron.social-capture" },
  // `verify-captures` (a longer match) claims the fluncle-verify-captures dir before the bare
  // `capture` token can (claimCronDirs is longest-match-first), exactly like social-capture.
  { cadenceMs: 30 * 60_000, match: "verify-captures", service: "cron.verify-captures" },
  { cadenceMs: 15 * 60_000, match: "studio-clip", service: "cron.studio-clip" },
  // The Twitch live-set poller — every 1m. `live` is not a substring of any other cron's
  // `fluncle-…` header, so it claims fluncle-live cleanly. It ran unregistered for months
  // (no registry surface, no row here), which is why a dead poller was invisible on /status.
  { cadenceMs: 60_000, match: "live", service: "cron.live" },
  { cadenceMs: 60 * 60_000, match: "render", service: "cron.render" },
  // The render → publish auto-advance — every 30m. It is the LAST link of the chain, so a
  // silent stop is exactly the failure worth seeing: a stalled tick lands here as `lagging`
  // on /status. (A tick that RUNS but pushes nothing is honest and stays `fresh-ok` — the
  // kill switch or an unready queue; the findings themselves stay in the /admin attention
  // queue, which is where a HELD finding is visible.)
  { cadenceMs: 30 * 60_000, match: "publish-advance", service: "cron.publish-advance" },
  // NB: cron.healthcheck is NOT here — this prober IS that cron, now run by a host
  // systemd timer (../healthcheck-timer/), so it has no gateway output dir to read and
  // a self-read would be circular. Its /status row is emitted self-evidently by
  // probeHealthcheck() below instead.
  { cadenceMs: 7 * 24 * 60 * 60_000, match: "newsletter", service: "cron.newsletter" }, // weekly — a generous floor
  // The Frontier playlist drain (E2) — every 15m. It USED to be a Friday-07:00 burst, and this
  // entry kept saying so for as long as the burst had been gone: a 7-day cadence means a 21-day
  // staleness budget, so a dead drain would have read `fresh` on /status for three weeks.
  // @fluncle/registry's probeConfig had already been corrected; only this copy was left behind,
  // which is precisely why cron-roster.test.ts now binds both to the timer unit. The crew still
  // sees a ~weekly refresh — the pacing is in the sweep's due-gate, never in the cadence here.
  // No token collision: no other cron token contains "frontier-refresh".
  { cadenceMs: 15 * 60_000, match: "frontier-refresh", service: "cron.frontier-refresh" },
  { cadenceMs: 24 * 60 * 60_000, match: "backup", service: "cron.backup" }, // daily DB backup → private R2
  // The nightly hub-counts reconciliation (docs/db-scale-backlog Wave 2 keystone 2, slice C).
  // `reconcile-hub-counts` is the longest token here and no other cron's `fluncle-…` dir header is a
  // substring of it (nor it of theirs), so claimCronDirs' longest-match-first pass claims
  // fluncle-reconcile-hub-counts cleanly.
  {
    cadenceMs: 24 * 60 * 60_000,
    match: "reconcile-hub-counts",
    service: "cron.reconcile-hub-counts",
  },
  { cadenceMs: 24 * 60 * 60_000, match: "logbook", service: "cron.logbook" }, // daily Logbook author — a generous floor
  // The daily /reach snapshot. `reach` is a substring of no other cron's fluncle-<token> dir
  // header (and no other token is a substring of "reach"), so claimCronDirs' longest-match-first
  // pass gives it its own fluncle-reach dir cleanly — no collision guard needed.
  { cadenceMs: 24 * 60 * 60_000, match: "reach", service: "cron.reach" },
  // The nightly demand reorder (docs/catalogue-crawler.md § Demand). `demand` is a substring of no
  // other cron's fluncle-<token> dir header (and vice versa), so claimCronDirs' longest-match-first
  // pass claims fluncle-demand cleanly.
  { cadenceMs: 24 * 60 * 60_000, match: "demand", service: "cron.demand" },
  // The daily catalogue-funnel snapshot (docs/admin-shell.md). `funnel-snapshot`
  // is a substring of no other cron's fluncle-<token> dir header (and vice versa), so
  // claimCronDirs' longest-match-first pass claims fluncle-funnel-snapshot cleanly.
  { cadenceMs: 24 * 60 * 60_000, match: "funnel-snapshot", service: "cron.funnel-snapshot" },
  // The daily per-post social-metrics snapshot. `social-metrics` and `social-capture` are the same
  // length and neither is a substring of the other's `fluncle-…` dir header, so claimCronDirs'
  // longest-match-first pass gives each its own dir cleanly (the social-capture/verify-captures
  // pattern). Keep both entries.
  { cadenceMs: 24 * 60 * 60_000, match: "social-metrics", service: "cron.social-metrics" },
  // The two nightly-audit crons: `audit-review` (12 chars) is claimed before `audit` (5) by
  // longest-match-first, and neither is a substring of the other's `fluncle-…` dir header, so
  // each claims its own dir cleanly (same pattern as social-capture/capture). Both daily.
  { cadenceMs: 24 * 60 * 60_000, match: "audit-review", service: "cron.audit-review" },
  { cadenceMs: 24 * 60 * 60_000, match: "audit", service: "cron.audit" },
  // Nightly Sentry triage. `sentry-triage` (13 chars) is claimed before the submission-triage
  // `triage` (6) by longest-match-first, and "sentry-triage" is not a substring of "fluncle-triage"
  // (nor vice versa), so each claims its own dir cleanly (same pattern as audit-review/audit). Daily.
  { cadenceMs: 24 * 60 * 60_000, match: "sentry-triage", service: "cron.sentry-triage" },
];

export type CronVerdict =
  | "fresh-ok"
  | "lagging"
  | "failed"
  | "failed-once"
  | "no-data"
  | "no-summary";

/**
 * The cron NAME a given output dir belongs to (from the newest run-file's
 * `# Cron Job: <name>` header, e.g. `fluncle-enrich`), plus that file's mtime. The
 * runner names dirs by job id, so the header is the only link to the cron; the mtime
 * lets a recreated cron's CURRENT dir outrank a stale leftover with the same name.
 * jobName is "" if the dir has no readable run file.
 */
function dirInfo(dir: string): { jobName: string; mtimeMs: number } {
  try {
    const newest = readdirSync(dir)
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => join(dir, entry))
      .map((path) => ({ mtimeMs: statSync(path).mtimeMs, path }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

    if (!newest) {
      return { jobName: "", mtimeMs: 0 };
    }

    const match = readFileSync(newest.path, "utf8")
      .slice(0, 600)
      .match(/^#\s*Cron Job:\s*(.+)$/m);

    return { jobName: (match?.[1]?.trim() ?? "").toLowerCase(), mtimeMs: newest.mtimeMs };
  } catch {
    return { jobName: "", mtimeMs: 0 };
  }
}

/**
 * Map each cron to the output dir it OWNS, keyed by the cron's registry `service` id.
 * Dirs are named by job id, so resolve each dir to its recorded cron name (the run-file
 * header), FRESHEST dir first (so a recreated cron's current dir wins over a stale
 * leftover), then claim longest-MATCH first so the most-specific cron wins each dir
 * exclusively. This is the fix for the "note" ⊂ "context-note" overlap: the
 * `fluncle-context-note` header contains both substrings, so `context-note` claims its
 * dir before a bare `note` can.
 */
function claimCronDirs(crons: CronDef[]): Map<string, string> {
  const claimed = new Map<string, string>(); // service id -> dir path

  if (!existsSync(CRON_OUTPUT_DIR)) {
    return claimed;
  }

  let resolved: { dir: string; jobName: string; mtimeMs: number }[];

  try {
    resolved = readdirSync(CRON_OUTPUT_DIR)
      .map((entry) => join(CRON_OUTPUT_DIR, entry))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      })
      .map((dir) => ({ dir, ...dirInfo(dir) }))
      .filter((entry) => entry.jobName !== "")
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return claimed;
  }

  const used = new Set<string>(); // dir paths already claimed
  const byLongest = [...crons].sort((a, b) => b.match.length - a.match.length);

  for (const cron of byLongest) {
    const hit = resolved.find(
      (entry) => !used.has(entry.dir) && entry.jobName.includes(cron.match.toLowerCase()),
    );

    if (hit) {
      claimed.set(cron.service, hit.dir);
      used.add(hit.dir);
    }
  }

  return claimed;
}

/**
 * The JSON summary line a marker carries, or null when it carries none.
 *
 * EVERY sweep is contracted to end its stdout with one JSON summary line — that is the whole
 * point of `cron-output.sh`'s "the LAST line is the sweep's JSON summary". But the marker is
 * WRITTEN BY THE WRAPPER, not by the sweep: `emit_cron_output` runs the payload, captures its
 * stdout, and writes the header + whatever it captured. So a sweep that is SIGKILLed (an OOM,
 * the runner's ~120s budget) still leaves a marker — a 28-byte file whose only line is the
 * `# Cron Job: …` header. Reading just the LAST non-empty line and shrugging when it isn't
 * JSON therefore graded a totally dead run as healthy: `fluncle-backup` was OOM-killed three
 * nights running (2026-07-24/25/26, status=137) and `cron.backup` read GREEN throughout.
 *
 * So: scan UPWARDS for the last line that parses as a JSON object. That keeps the two
 * legitimate shapes healthy — a clean summary on the last line, and a summary followed by
 * trailing log noise — while a marker with no summary at all is what it looks like: a run
 * that never got to speak.
 */
export function findJsonSummary(body: string): Record<string, unknown> | null {
  // Only ever scan the STDOUT region. cron-output.sh appends a delimited stderr tail below it
  // (see STDERR_DELIMITER), and the summary lives in the sweep's stdout by contract — reading
  // past the delimiter would let a stderr line that happens to be a JSON object impersonate
  // the summary. An old-shaped marker has no delimiter and is unaffected.
  const lines = splitMarker(body)
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";

    // Cheap gate before the parse: only an object literal can be a summary.
    if (!line.startsWith("{")) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(line);

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not this line — keep walking up.
    }
  }

  return null;
}

/**
 * How long this box has been up, in ms — or null where that can't be known (no procfs).
 * Used to age a never-ran cron out of "no runs yet": on a box that has been up for days, a
 * cron with no output has not "not started yet", it has never fired.
 */
export function boxUptimeMs(): number | null {
  try {
    const seconds = Number.parseFloat(readFileSync("/proc/uptime", "utf8").split(/\s+/)[0] ?? "");

    return Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Judge one cron's claimed dir: the newest *.md must be fresh enough AND carry a JSON summary
 * that doesn't say `ok: false`.
 *
 * `uptimeMs` is the box's uptime (null = unknown). It only matters for the no-runs-at-all
 * case: a timer that never installed, or never fired, used to read "no runs yet / ok" FOREVER.
 * Once the box has been up longer than this cron's own stale budget, that silence is the same
 * signal as a stale marker — `lagging`.
 */
export function judgeCron(
  cron: CronDef,
  dir: string | undefined,
  uptimeMs: number | null = null,
): CronVerdict {
  // The stale budget: a run within 3× the cadence, PLUS the per-firing jitter every sweep
  // timer carries. The jitter term is not decoration — `cadenceMs` describes what the unit
  // asks for (`OnUnitActiveSec`), while the gap actually observed is that plus a fresh
  // `RandomizedDelaySec` roll on every firing. For the slow crons the two are the same
  // number to within rounding, but the faster the cron the more the jitter dominates, and
  // at the fleet's fastest cadence it stops being a rounding error: `cron.live` asks for 60s
  // and rolls up to 90s on top, so its real period is 60–150s against a 3× budget of 180s.
  // Measured across its last 100 ticks: mean 114s, max 188s — over the budget, on a timer
  // behaving exactly as configured. Without this term the board reports a healthy sweep as
  // `lagging`, which is the flap that teaches an operator to stop reading the row.
  const staleBudgetMs = Math.max(cron.cadenceMs * 3, 90_000) + MAX_TIMER_JITTER_MS;

  // No output dir at all, or an unreadable one. Fresh box ⇒ genuinely "no runs yet"; a box
  // that has been up past this cron's whole stale budget ⇒ it should have produced something.
  const noData = (): CronVerdict =>
    uptimeMs !== null && uptimeMs > staleBudgetMs ? "lagging" : "no-data";

  if (!dir) {
    return noData();
  }

  let runFiles: { mtimeMs: number; path: string }[];

  try {
    runFiles = readdirSync(dir)
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => join(dir, entry))
      .map((path) => ({ mtimeMs: statSync(path).mtimeMs, path }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return noData();
  }

  const newest = runFiles[0];

  if (!newest) {
    return noData(); // dir exists but no runs yet
  }

  // Freshness first — a stale marker is "behind schedule" whatever it says.
  if (Date.now() - newest.mtimeMs > staleBudgetMs) {
    return "lagging";
  }

  let body: string;

  try {
    body = readFileSync(newest.path, "utf8");
  } catch {
    return "fresh-ok"; // unreadable body but fresh file — don't false-alarm
  }

  const summary = findJsonSummary(body);

  if (!summary) {
    // NO SUMMARY AT ALL. The wrapper wrote a marker but the sweep never emitted its
    // contracted JSON line — the signature of a run that was KILLED mid-flight (OOM, the
    // runner budget). Unlike `ok: false` (a sweep reporting a handled, usually transient
    // failure and retrying on its own cadence) this is the process dying, so it does NOT get
    // the one-miss grace: it is a failure the first time it is seen. Three OOM-killed backup
    // nights read green under the old lenience; never again.
    return "no-summary";
  }

  if (summary.ok === false) {
    // ONE failed run is not an outage — every sweep retries on its own cadence, and a
    // transient (a MusicBrainz slow day timing out one crawl tick) self-heals on the next
    // tick. Alarming DOWN on a single miss made /status + Discord flap all morning
    // (2026-07-13). So: the newest run failed AND the one before it also failed ⇒ the job
    // is genuinely stuck ⇒ "failed" (down). A lone failure ⇒ "failed-once" (degraded,
    // "watching the retry") — visible, never silent, but not a page.
    return runFailed(runFiles[1]?.path) ? "failed" : "failed-once";
  }

  return "fresh-ok";
}

/**
 * Did a (previous) run file fail? `ok: false` counts, and so does a marker with NO summary —
 * a killed run is a failed run, so two killed nights escalate the same way two reported
 * failures do. Unreadable/absent ⇒ no (never invent a failure).
 */
function runFailed(path: string | undefined): boolean {
  if (!path) {
    return false;
  }

  try {
    const summary = findJsonSummary(readFileSync(path, "utf8"));

    return summary === null || summary.ok === false;
  } catch {
    return false;
  }
}

/** Map one cron's verdict to its public Check (status + a short, public-safe note). */
export function cronCheck(cron: CronDef, verdict: CronVerdict): Check {
  const base = { latencyMs: null, service: cron.service };

  if (verdict === "no-summary") {
    // The marker exists but the sweep never emitted its summary — it was killed mid-run.
    // Down on the first sighting: a process that died is not a job "watching its retry".
    return { ...base, message: msg("last run died mid-flight"), status: "down" };
  }

  if (verdict === "failed") {
    // Two consecutive failed runs — the job is stuck, not unlucky. A real outage.
    return { ...base, message: msg("last runs failed"), status: "down" };
  }

  if (verdict === "failed-once") {
    // A single failed run with a healthy one before it — the sweep's own retry is the
    // remediation, so this surfaces as degraded and resolves (or escalates) on the next tick.
    return { ...base, message: msg("last run failed; watching the retry"), status: "degraded" };
  }

  if (verdict === "lagging") {
    // Healthy-looking output, but stale beyond 3× the cadence — the job is behind.
    return { ...base, message: msg("behind schedule"), status: "degraded" };
  }

  if (verdict === "no-data") {
    // No output dir / no runs yet — a freshly-rebuilt box, not a fault. ok-unknown.
    return { ...base, message: msg("no runs yet"), status: "ok" };
  }

  return { ...base, message: msg("fresh"), status: "ok" };
}

/**
 * Probe every known Hermes cron and emit ONE Check PER cron (service id = its registry
 * surface name, e.g. `cron.enrich`). Claim each output dir to its most-specific cron
 * first (handles "note" ⊂ "context-note"), then judge each cron against the dir it
 * actually owns. Each cron stands or falls on its own row — "look how many systems are
 * humming" — instead of collapsing into a single aggregate.
 */
function probeCrons(claimed: Map<string, string>): Check[] {
  const uptimeMs = boxUptimeMs();

  return AUTOMATION_CRONS.map((cron) =>
    cronCheck(cron, judgeCron(cron, claimed.get(cron.service), uptimeMs)),
  );
}

// ---------------------------------------------------------------------------
// PROBE: sweep-errors — the SECOND signal over the same markers, and a deliberately
// SEPARATE one.
//
// THE HOLE THIS FILLS. `judgeCron` above reads exactly one thing out of a marker: the
// sweep's own `{ ok }` verdict. That verdict is the sweep's opinion of its TICK, not of its
// WORK — a sweep that walks a batch of 10, fails all 10 for the same reason, and returns
// `{"ok":true,"failed":10}` is telling the truth (the tick ran, the queue is intact, it will
// retry) and reads perfectly green. Two days of real box output, aggregated: 610 capture
// bot-challenges, and three entity slugs each rejected ~90 times by the bio voice gate — the
// SAME three, over and over, a queue that could not drain. Every one of those ticks was
// `ok: true`, and `/status` was right to say so. Nothing anywhere was reading the rest.
//
// THE RULE, in one sentence: count the evidence a sweep leaves that WORK DID NOT GET DONE,
// sum it over a rolling window, and say so when it crosses a threshold — without ever
// touching the sweep's own verdict.
//
// The evidence is two explicit, reviewable lists and nothing else:
//   • STRAIN_PHRASES — classified stderr substrings. A run-level line scores directly. An
//     item-level line supplies a `failed`-shaped numerator and only scores as a rate against the
//     marker's `checked` denominator. Empirically tuned against the sweeps' actual `log()` lines,
//     not guessed: there is deliberately no /error/i catch-all.
//   • STRAIN_COUNTER_KEYS + the nullable `error` field — run-level failures and stuck-loop
//     counters the sweeps ALREADY put in their JSON summaries (`errors`, `gateSkipped`, `error`).
//   • STRAIN_RATE_COUNTERS — item-level `failed` is ordinary batch fallout unless its rate against
//     `checked` is high. With no denominator it says nothing; the detector never assumes the worst.
//     `skipped` and `unmatched` are likewise ordinary outcomes here, not failures.
//
// Designed vendor backpressure is counted separately. A sweep that says `throttled: true`
// stopped cleanly and will resume next tick, so it stays visible on the healthy sweep-errors
// row but can never contribute to an alarm.
//
// WHY IT IS ITS OWN ROW. The sweep's `{ ok }` contract stays exactly as it was, and this
// never edits, wraps, or overrides it: `cron.capture` still reads whatever capture said about
// itself. Strain lands on ONE separate `sweep-errors` row instead of ~35 per-sweep rows,
// because `service_status` rows are upserted and never deleted — a row minted for a
// one-afternoon condition would sit on the public board forever (`RETIRED_SERVICE_IDS` in
// apps/web/src/lib/server/status.ts is the hand-curated cost of exactly that mistake).
// The row carries the count; the Discord line names the sweeps.
// ---------------------------------------------------------------------------

/**
 * The line cron-output.sh writes between a marker's captured stdout and its captured stderr
 * tail. MIRRORED there as CRON_OUTPUT_STDERR_DELIMITER — change one, change the other; a test
 * pins the pair in lockstep by reading the shell source.
 */
export const STDERR_DELIMITER = "<!-- fluncle-cron-output: stderr tail -->";

/**
 * Split a marker into its stdout region (the summary lives here) and its stderr tail (the
 * errors live here). A marker written before the tail existed has no delimiter and is all
 * stdout — which is exactly how it used to read, so nothing about the old shape changes.
 */
export function splitMarker(body: string): { stderr: string; stdout: string } {
  const index = body.indexOf(STDERR_DELIMITER);

  if (index === -1) {
    return { stderr: "", stdout: body };
  }

  return { stderr: body.slice(index + STDERR_DELIMITER.length), stdout: body.slice(0, index) };
}

/**
 * THE VOCABULARY — the whole stderr detector's false-positive surface, kept classified at the
 * source so prose and counters cannot disagree about `errors` (the RUN failed) versus `failed`
 * (ITEMS failed and the run continued). A line matching both levels is run-level: the explicit
 * `fatal:` / batch-abort wrapper is the stronger statement.
 */
export const STRAIN_PHRASES = [
  // Every producer follows these with a non-zero exit: the auth branches stop the batch and the
  // top-level catches print `fatal:` before their failed summary.
  { level: "run", phrase: "aborting the batch" },
  { level: "run", phrase: "fatal:" },
  // Capture's spent re-roll loses one track, then the batch continues.
  { level: "item", phrase: "bot-challenged" },
  // Ambiguous English, therefore not safe as a run verdict. Actual producers use it for optional
  // context fallbacks, best-effort state writes, and individual unavailable resources; a fatal
  // wrapper still wins when one really ends the run.
  { level: "item", phrase: "could not" },
  // The shared per-row catch in the batch sweeps. The trailing space is load-bearing: it matches
  // `error on <id>` / `unexpected error on <id>`, not the word "error" loose in prose.
  { level: "item", phrase: "error on " },
  // One entity/finding/day exhausted its authoring budget; the sweep moves to the next item.
  { level: "item", phrase: "giving up" },
  // Claude's error reply leaves one authoring target queued; it does not abort the sweep.
  { level: "item", phrase: "is_error" },
  // These are all continuation/backoff or per-item rejection diagnostics in their producers.
  { level: "item", phrase: "rate-limited" },
  { level: "item", phrase: "rejected the" },
  { level: "item", phrase: "retrying" },
  { level: "item", phrase: "stays queued" },
  { level: "item", phrase: "stays un-triaged" },
  { level: "item", phrase: "timed out" },
  { level: "item", phrase: "unable to" },
  { level: "item", phrase: "unavailable" },
] as const satisfies readonly { level: "item" | "run"; phrase: string }[];

/**
 * Summary fields that COUNT run-level failures or a stuck loop. Each unit is one point — these
 * are the sweeps' own numbers, so there is nothing to interpret. Item-level `failed` is handled
 * separately as a rate. Deliberately excluded: `skipped` and `unmatched`, both of which are
 * ordinary outcomes (an already-noted finding, a capture whose fingerprint did not match).
 */
export const STRAIN_COUNTER_KEYS: readonly string[] = ["errors", "gateSkipped"];

/** Item-failure counters that need a real work denominator before they can say anything. */
export const STRAIN_RATE_COUNTERS = [{ denominator: "checked", numerator: "failed" }] as const;

/** Summary fields that record designed backpressure, not failed work. One yielded tick each. */
export const BACKPRESSURE_FLAG_KEYS: readonly string[] = ["throttled"];

type DistressEvidence = { itemFailures: number; runFailures: number };

/** Classified evidence from a marker's stderr tail: at most one observation per line. */
function countDistressEvidence(stderrRegion: string): DistressEvidence {
  const evidence: DistressEvidence = { itemFailures: 0, runFailures: 0 };

  for (const raw of stderrRegion.split("\n")) {
    // Strip the blockquote prefix cron-output.sh writes, then normalise for matching.
    const line = raw
      .replace(/^\s*>\s?/, "")
      .trim()
      .toLowerCase();

    if (!line) {
      continue;
    }

    if (STRAIN_PHRASES.some(({ level, phrase }) => level === "run" && line.includes(phrase))) {
      evidence.runFailures += 1;
    } else if (
      STRAIN_PHRASES.some(({ level, phrase }) => level === "item" && line.includes(phrase))
    ) {
      evidence.itemFailures += 1;
    }
  }

  return evidence;
}

/** A summary counter's non-negative integer value; arrays use their item count. */
function summaryCount(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }

  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** One rate-gated point from item failures, shared by structured counters and stderr prose. */
function countItemFailureRateStrain(failedValue: unknown, checkedValue: unknown): number {
  const checked =
    typeof checkedValue === "number" && Number.isFinite(checkedValue) && checkedValue > 0
      ? Math.floor(checkedValue)
      : 0;
  const failed = summaryCount(failedValue);

  return checked > 0 && failed / checked >= STRAIN_ITEM_FAILURE_RATE ? 1 : 0;
}

/**
 * Strain points from stderr alone. Run failures score directly; item failures use the same rate
 * gate as structured `failed`, and therefore say nothing without a `checked` denominator.
 */
export function countDistressLines(stderrRegion: string, checked: unknown = null): number {
  const evidence = countDistressEvidence(stderrRegion);

  return evidence.runFailures + countItemFailureRateStrain(evidence.itemFailures, checked);
}

/** Strain points from a marker's JSON summary: direct counters, high item-failure rate, and error. */
export function countSummaryStrain(summary: Record<string, unknown> | null): number {
  if (!summary) {
    return 0;
  }

  let points = 0;

  for (const key of STRAIN_COUNTER_KEYS) {
    points += summaryCount(summary[key]);
  }

  for (const { denominator, numerator } of STRAIN_RATE_COUNTERS) {
    points += countItemFailureRateStrain(summary[numerator], summary[denominator]);
  }

  if (typeof summary.error === "string") {
    points += 1;
  }

  return points;
}

/** Designed-backpressure ticks from a marker summary. These are observable but never strain. */
export function countSummaryBackpressure(summary: Record<string, unknown> | null): number {
  if (!summary) {
    return 0;
  }

  let points = 0;

  for (const key of BACKPRESSURE_FLAG_KEYS) {
    if (summary[key] === true) {
      points += 1;
    }
  }

  return points;
}

/**
 * The two signals one marker (one tick) contributes. Structured `failed` owns the item-failure
 * numerator when present; otherwise classified item prose supplies it. Both use the SAME rate
 * scorer and the summary's `checked` denominator. Run-level prose always scores directly.
 * Designed backpressure has its own axis and cannot leak into `strain`.
 */
export function markerSignals(body: string): { backpressure: number; strain: number } {
  const summary = findJsonSummary(body);
  const distress = countDistressEvidence(splitMarker(body).stderr);
  const hasStructuredItemFailures =
    summary !== null &&
    STRAIN_RATE_COUNTERS.some(({ numerator }) => Object.hasOwn(summary, numerator));
  const proseItemStrain = hasStructuredItemFailures
    ? 0
    : countItemFailureRateStrain(distress.itemFailures, summary?.checked);

  return {
    backpressure: countSummaryBackpressure(summary),
    strain: distress.runFailures + proseItemStrain + countSummaryStrain(summary),
  };
}

export function markerStrain(body: string): number {
  return markerSignals(body).strain;
}

export function markerBackpressure(body: string): number {
  return markerSignals(body).backpressure;
}

// ── THE STRAIN DIAL — the ONE place these numbers are tuned. ──────────────────
// Every threshold is env-overridable on the box, so tuning after a day of real data needs no
// rebake: set it in the box env, restart the timer, done.
//
// ITEM FAILURE RATE (50%, per tick). Structured `failed` and classified item-failure prose share
// this scorer; an occurrence count without `checked` has no denominator and contributes nothing.
// At least half of checked work must fail before the tick earns ONE strain point; a capture-shaped
// 4/12 tick is ordinary, while 6/12 is signal. The
// outer cadence gate still applies: the fastest cron needs 90 such ticks out of 360 scheduled
// in 6h; the slowest needs all three scheduled ticks in its 21d window. One point per high-rate
// tick prevents a large batch from overpowering that cadence-relative gate.
const CONFIGURED_ITEM_FAILURE_RATE = Number.parseFloat(
  process.env.HEALTHCHECK_STRAIN_ITEM_FAILURE_RATE ?? "",
);
export const STRAIN_ITEM_FAILURE_RATE =
  Number.isFinite(CONFIGURED_ITEM_FAILURE_RATE) &&
  CONFIGURED_ITEM_FAILURE_RATE > 0 &&
  CONFIGURED_ITEM_FAILURE_RATE <= 1
    ? CONFIGURED_ITEM_FAILURE_RATE
    : 0.5;
//
// WINDOW (max(6h, 3 × cadence)). Fast crons clear a fixed condition the same morning. Daily and
// weekly crons get exactly the three scheduled opportunities required by the repeated-tick gate;
// no cron in AUTOMATION_CRONS is silently too slow to be judged.
//
// REPEATED-TICK RATE (25%). The point bar scales with scheduled ticks in that cron's window
// instead of making a fast cron buy the same 12 points as a slow one. At the fleet's fastest cadence,
// `live` gets 360 scheduled ticks in 6h and needs 90 points: 0.25 failure points/tick. At the
// slowest cadence, `newsletter` gets three scheduled ticks in 21d; rounding makes the rate gate
// one point (0.33/tick), while the three-distinct-error-ticks gate below makes the effective
// minimum three points across three ticks (1.0/tick). That stricter slow-cron result is
// deliberate: with only three observations, all three must show failed work before this
// standing-condition row speaks.
//
// TICKS (3). The spread requirement, and the reason one catastrophic tick does NOT land here:
// that case is already `judgeCron`'s (`ok:false`, or a killed run with no summary). This row
// is only ever about a condition that KEEPS happening.
//
// The window is measured with a per-cron rolling state (hourly buckets in the prober's state
// file) rather than by re-reading the marker dir, because cron-output.sh prunes to ~20 markers
// — for the 1-minute `live` cron that is 20 minutes of history, far short of any useful window.
const STRAIN_WINDOW_FLOOR_MS =
  Number.parseInt(process.env.HEALTHCHECK_STRAIN_WINDOW_MS ?? "", 10) || 6 * 60 * 60_000;
const STRAIN_WINDOW_CADENCES = 3;
const STRAIN_FAILURE_RATE =
  Number.parseFloat(process.env.HEALTHCHECK_STRAIN_FAILURE_RATE ?? "") || 0.25;
const STRAIN_MIN_TICKS = Number.parseInt(process.env.HEALTHCHECK_STRAIN_TICKS ?? "", 10) || 3;

/** This cron's rolling evidence window. Every known cadence can contribute three ticks. */
export function strainWindowMs(
  cadenceMs: number,
  floorMs: number = STRAIN_WINDOW_FLOOR_MS,
): number {
  return Math.max(floorMs, cadenceMs * STRAIN_WINDOW_CADENCES);
}

/** Rate-relative point gate for the scheduled ticks in one cron's own rolling window. */
export function strainMinimumPoints(
  cadenceMs: number,
  windowMs: number = strainWindowMs(cadenceMs),
  failureRate: number = STRAIN_FAILURE_RATE,
): number {
  return Math.max(1, Math.ceil((windowMs / cadenceMs) * failureRate));
}

/** Bucket granularity for the rolling window. Sparse buckets keep slow-cron windows tiny too. */
const STRAIN_BUCKET_MS = 60 * 60_000;

/** One hour of accrued strain for one cron. */
export type StrainBucket = { backpressure?: number; points: number; ticks: number };

/**
 * What the prober remembers about one cron's strain between ticks: the hourly buckets inside
 * the window, whether it was already reported strained (so the Discord line is edge-triggered),
 * and the newest marker mtime already folded in (so no marker is ever counted twice).
 */
export type StrainState = {
  buckets: Record<string, StrainBucket>;
  strained: boolean;
  watermarkMs: number;
};

type StrainMap = Record<string, StrainState>;

/**
 * Fold this tick's new markers into a cron's rolling window: accrue each sample into its own
 * hour bucket, advance the watermark past everything seen, and drop whatever has aged out.
 *
 * The watermark is what makes this exact rather than approximate — the prober ticks every
 * ~10m and every marker written since the last tick is still on disk (the pruner keeps ~20),
 * so every tick of every cron is counted once and only once.
 */
export function foldStrain(
  prev: StrainState | undefined,
  samples: { atMs: number; backpressure?: number; points: number }[],
  now: number,
  windowMs: number = STRAIN_WINDOW_FLOOR_MS,
): StrainState {
  const buckets: Record<string, StrainBucket> = { ...prev?.buckets };
  let watermarkMs = prev?.watermarkMs ?? 0;

  for (const sample of samples) {
    watermarkMs = Math.max(watermarkMs, sample.atMs);

    if (sample.points <= 0 && (sample.backpressure ?? 0) <= 0) {
      continue; // An entirely clean tick advances the watermark and nothing else.
    }

    const key = String(Math.floor(sample.atMs / STRAIN_BUCKET_MS) * STRAIN_BUCKET_MS);
    const bucket = buckets[key] ?? { points: 0, ticks: 0 };
    const backpressure = (bucket.backpressure ?? 0) + (sample.backpressure ?? 0);

    buckets[key] = {
      ...(backpressure > 0 ? { backpressure } : {}),
      points: bucket.points + Math.max(0, sample.points),
      ticks: bucket.ticks + (sample.points > 0 ? 1 : 0),
    };
  }

  const cutoff = now - windowMs;
  const kept: Record<string, StrainBucket> = {};

  for (const [key, bucket] of Object.entries(buckets)) {
    const start = Number.parseInt(key, 10);

    if (Number.isFinite(start) && start + STRAIN_BUCKET_MS > cutoff) {
      kept[key] = bucket;
    }
  }

  return { buckets: kept, strained: prev?.strained ?? false, watermarkMs };
}

/** A cron's totals across the buckets still inside the window. */
export function strainTotals(
  state: StrainState | undefined,
  now: number,
  windowMs: number = STRAIN_WINDOW_FLOOR_MS,
): StrainBucket {
  const cutoff = now - windowMs;
  const totals: StrainBucket = { points: 0, ticks: 0 };

  for (const [key, bucket] of Object.entries(state?.buckets ?? {})) {
    const start = Number.parseInt(key, 10);

    if (Number.isFinite(start) && start + STRAIN_BUCKET_MS > cutoff) {
      totals.points += bucket.points;
      totals.ticks += bucket.ticks;
    }
  }

  return totals;
}

/** Designed-backpressure ticks across the same cron-relative rolling window. Never an alarm. */
export function backpressureTotal(
  state: StrainState | undefined,
  now: number,
  windowMs: number = STRAIN_WINDOW_FLOOR_MS,
): number {
  const cutoff = now - windowMs;
  let total = 0;

  for (const [key, bucket] of Object.entries(state?.buckets ?? {})) {
    const start = Number.parseInt(key, 10);

    if (Number.isFinite(start) && start + STRAIN_BUCKET_MS > cutoff) {
      total += bucket.backpressure ?? 0;
    }
  }

  return total;
}

/** Both gates: enough evidence, AND spread across enough separate ticks to be standing. */
export function isStrained(
  totals: StrainBucket,
  minPoints: number,
  minTicks = STRAIN_MIN_TICKS,
): boolean {
  return totals.points >= minPoints && totals.ticks >= minTicks;
}

/**
 * The `sweep-errors` row. `degraded`, never `down`: every one of these sweeps is RUNNING and
 * reporting for itself on its own row, so calling the box down would be a lie the /status
 * headline would then repeat. The operator's loud channel is the Discord line below.
 */
export function sweepStrainCheck(strained: string[], backpressured: string[] = []): Check {
  const service = "sweep-errors";

  if (strained.length === 0) {
    const names = backpressured.map((id) => id.replace(/^cron\./, "")).join(", ");
    const message =
      backpressured.length === 0
        ? "no repeat errors"
        : `no repeat errors; ${backpressured.length} sweep${backpressured.length === 1 ? "" : "s"} yielded cleanly: ${names}`;

    return { latencyMs: null, message: msg(message), service, status: "ok" };
  }

  const names = strained.map((id) => id.replace(/^cron\./, "")).join(", ");

  return {
    latencyMs: null,
    message: msg(
      `${strained.length} sweep${strained.length === 1 ? "" : "s"} logging repeat errors: ${names}`,
    ),
    service,
    status: "degraded",
  };
}

/**
 * The strain markers a cron has written since the prober last looked, each scored. Newly-seen
 * only — the watermark is what keeps a marker from being counted on every tick for as long as
 * it survives the pruner.
 *
 * The comparison is strictly `>`, so the one thing it can lose is a marker written in the SAME
 * MILLISECOND as the newest one the prober already folded in. That costs a few points out of a
 * six-hour window and can never invent strain, which is the direction that matters.
 */
function readStrainSamples(
  dir: string | undefined,
  watermarkMs: number,
): { atMs: number; backpressure: number; points: number }[] {
  if (!dir) {
    return [];
  }

  try {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => join(dir, entry))
      .map((path) => ({ mtimeMs: statSync(path).mtimeMs, path }))
      .filter((file) => file.mtimeMs > watermarkMs)
      .map((file) => {
        const signals = markerSignals(readFileSync(file.path, "utf8"));

        return {
          atMs: file.mtimeMs,
          backpressure: signals.backpressure,
          points: signals.strain,
        };
      });
  } catch {
    return []; // An unreadable dir is judgeCron's problem to report, never a strain alarm.
  }
}

/**
 * Score every cron's new markers, roll the window forward, and report which sweeps are now in
 * a standing error condition — plus which just entered or left it, so the Discord line can be
 * edge-triggered exactly like the service transitions are.
 */
export function probeSweepStrain(
  claimed: Map<string, string>,
  prev: StrainMap,
  now = Date.now(),
): {
  backpressured: string[];
  check: Check;
  cleared: string[];
  newly: string[];
  next: StrainMap;
  strained: string[];
} {
  const next: StrainMap = {};
  const strained: string[] = [];
  const backpressured: string[] = [];
  const newly: string[] = [];
  const cleared: string[] = [];

  for (const cron of AUTOMATION_CRONS) {
    const before = prev[cron.service];
    const samples = readStrainSamples(claimed.get(cron.service), before?.watermarkMs ?? 0);
    const windowMs = strainWindowMs(cron.cadenceMs);
    const state = foldStrain(before, samples, now, windowMs);
    const nowStrained = isStrained(
      strainTotals(state, now, windowMs),
      strainMinimumPoints(cron.cadenceMs, windowMs),
    );

    if (backpressureTotal(state, now, windowMs) > 0) {
      backpressured.push(cron.service);
    }

    if (nowStrained) {
      strained.push(cron.service);

      if (before?.strained !== true) {
        newly.push(cron.service);
      }
    } else if (before?.strained === true) {
      cleared.push(cron.service);
    }

    next[cron.service] = { ...state, strained: nowStrained };
  }

  return {
    backpressured,
    check: sweepStrainCheck(strained, backpressured),
    cleared,
    newly,
    next,
    strained,
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
// PROBE: cron.healthcheck — this prober IS the healthcheck cron, now run by its own
// rave-02 host systemd timer (../healthcheck-timer/). Reaching this line means the
// timer fired and the tick is executing, so its liveness is self-evident → ok. It is
// deliberately NOT in AUTOMATION_CRONS: a host-timer prober has no Hermes gateway
// output dir to read, and reading its own would be circular. Emitting the row here
// keeps the `cron.healthcheck` line populated on /status without a gateway-dir read.
// ---------------------------------------------------------------------------

function probeHealthcheck(): Check {
  return {
    latencyMs: null,
    message: msg("prober tick live"),
    service: "cron.healthcheck",
    status: "ok",
  };
}

// ---------------------------------------------------------------------------
// State: the transition + streak memory. Load the prior map, compute `transitioned`
// and the consecutive-down streak per check, write the new map back. A read/parse
// failure starts from an empty map (so the FIRST tick after a state loss reports every
// service as a fresh transition — acceptable, it just re-baselines).
//
// TWO SHAPES ON DISK. v1 was a flat `service → status` map; v2 wraps richer per-service
// entries under `services`. `normalizeState` reads BOTH, because the box is running a
// v1 file right now and a prober that throws on it would take the dead-man's beacon down
// with it. Anything unreadable — a v1 status string, a truncated write, a stray key —
// degrades to a fresh entry, never an exception.
// ---------------------------------------------------------------------------

// v3 added the `strain` section (the per-cron rolling error window). v4 reset v3's buckets when
// structured item counters moved to a rate; v5 resets v4 because item-level prose now uses that
// same rate instead of direct occurrence points. `services` remains untouched. Older files still
// load defensively and simply start their strain windows empty.
const STATE_VERSION = 5;

function isStatus(value: unknown): value is Status {
  return value === "ok" || value === "degraded" || value === "down";
}

/** A non-negative integer count from anything; junk (or a negative) reads as 0. */
function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Read whatever is in the state file into the current shape.
 *
 * Accepts the v2 `{ version, services: { <id>: { status, downStreak, escalatedStreak } } }`
 * and the legacy v1 flat `{ <id>: "ok" }` alike — a v1 entry simply arrives with its
 * counters at zero, i.e. its ladder restarts from this tick. Entries whose status can't be
 * resolved (including v2's own `version` scalar when the file is read flat) are dropped.
 */
export function normalizeState(parsed: unknown): StateMap {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const record = parsed as Record<string, unknown>;
  const wrapped = record.services;
  const entries =
    wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)
      ? (wrapped as Record<string, unknown>)
      : record;

  const state: StateMap = {};

  for (const [service, value] of Object.entries(entries)) {
    if (isStatus(value)) {
      // v1: the value IS the status. Counters start fresh.
      state[service] = { downStreak: 0, escalatedStreak: 0, status: value };

      continue;
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const entry = value as Record<string, unknown>;

    if (!isStatus(entry.status)) {
      continue;
    }

    state[service] = {
      downStreak: asCount(entry.downStreak),
      escalatedStreak: asCount(entry.escalatedStreak),
      status: entry.status,
    };
  }

  return state;
}

/**
 * Read the v5 `strain` section: per-cron hourly buckets + watermark + the reported flag.
 * A v3/v4 section carries points scored under an older item-count rule, so its buckets and
 * watermarks are deliberately reset while its `strained` flags survive long enough to emit the
 * edge-triggered recovery alert. Retained markers are then re-read under v5. A v1/v2 file (no
 * section), a truncated write, or junk yields an empty map. It must never throw: this is the same
 * read that carries the transition baseline.
 */
export function normalizeStrain(parsed: unknown): StrainMap {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const record = parsed as Record<string, unknown>;
  const section = record.strain;

  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return {};
  }

  const resetsOldScoring = record.version === 3 || record.version === 4;

  if (record.version !== STATE_VERSION && !resetsOldScoring) {
    return {};
  }

  const strain: StrainMap = {};

  for (const [service, value] of Object.entries(section as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const entry = value as Record<string, unknown>;

    if (resetsOldScoring) {
      strain[service] = {
        buckets: {},
        strained: entry.strained === true,
        watermarkMs: 0,
      };

      continue;
    }

    const rawBuckets = entry.buckets;
    const buckets: Record<string, StrainBucket> = {};

    if (rawBuckets && typeof rawBuckets === "object" && !Array.isArray(rawBuckets)) {
      for (const [key, bucket] of Object.entries(rawBuckets as Record<string, unknown>)) {
        if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) {
          continue;
        }

        const shape = bucket as Record<string, unknown>;

        const backpressure = asCount(shape.backpressure);

        buckets[key] = {
          ...(backpressure > 0 ? { backpressure } : {}),
          points: asCount(shape.points),
          ticks: asCount(shape.ticks),
        };
      }
    }

    strain[service] = {
      buckets,
      strained: entry.strained === true,
      watermarkMs: asCount(entry.watermarkMs),
    };
  }

  return strain;
}

function loadState(): { services: StateMap; strain: StrainMap } {
  if (!existsSync(STATE_FILE)) {
    return { services: {}, strain: {} };
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"));

    return { services: normalizeState(parsed), strain: normalizeStrain(parsed) };
  } catch (error) {
    log(
      `could not read state (${error instanceof Error ? error.message : String(error)}) — re-baselining`,
    );
  }

  return { services: {}, strain: {} };
}

/** Exactly what goes on disk — exported so the round-trip is tested through the real shape. */
export function serializeState(next: StateMap, strain: StrainMap = {}): string {
  return `${JSON.stringify({ services: next, strain, version: STATE_VERSION }, null, 2)}\n`;
}

function writeState(next: StateMap, strain: StrainMap): void {
  try {
    // mkdir -p the state dir (recursive is a no-op when it already exists).
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, serializeState(next, strain), "utf8");
  } catch (error) {
    log(`could not write state (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * This tick's memory for one service: carry the consecutive-down streak forward, or reset
 * it (and the escalation ladder) the moment the service reads anything other than `down`.
 * A recovery therefore re-arms escalation from scratch — a service that flaps down/up/down
 * never accumulates its way to an escalation.
 */
export function nextServiceState(prev: ServiceState | undefined, status: Status): ServiceState {
  if (status !== "down") {
    return { downStreak: 0, escalatedStreak: 0, status };
  }

  // Only a run of `down` carries forward; anything else is a fresh streak of one.
  const running = prev?.status === "down" ? prev : undefined;

  return {
    downStreak: (running?.downStreak ?? 0) + 1,
    escalatedStreak: running?.escalatedStreak ?? 0,
    status,
  };
}

/**
 * Is this service due an escalation on this tick?
 *
 * The first one fires at `threshold` consecutive down ticks; each one after that waits for
 * the streak to DOUBLE (6, 12, 24, 48 …). That keeps a sustained outage visible for as long
 * as it lasts while the alerts themselves thin out — an escalation that repeated every tick
 * would just become the noise the transition-only rule was protecting against.
 */
export function escalationDue(state: ServiceState, threshold = ESCALATE_AFTER_TICKS): boolean {
  if (state.status !== "down") {
    return false;
  }

  const due = state.escalatedStreak > 0 ? state.escalatedStreak * 2 : threshold;

  return state.downStreak >= due;
}

// ---------------------------------------------------------------------------
// ALERT: Discord-ping on a transition — a service going down, or recovering (down →
// ok/degraded) — and on PERSISTENCE, once a down service has held the state for
// ESCALATE_AFTER_TICKS consecutive checks and then on a doubling ladder. A steady OK
// pings nothing, and a steady DOWN pings on the ladder rather than every tick (no spam,
// but never silence either). Best-effort; never throws. Reuses observe-sweep's
// curl-webhook shape.
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
    } else if (prev[check.service]?.status === "down") {
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

/**
 * A streak rendered as the rough wall-clock time it represents. Approximate on purpose —
 * the operator needs "an hour" vs "most of a day", not a stopwatch.
 */
export function formatStreakDuration(streak: number, tickMs = TICK_INTERVAL_MS): string {
  const minutes = Math.round((streak * tickMs) / 60_000);

  if (minutes < 60) {
    return `~${minutes}m`;
  }

  const hours = minutes / 60;

  if (hours < 24) {
    return `~${Math.round(hours)}h`;
  }

  return `~${Math.round((hours / 24) * 10) / 10}d`;
}

// Past this many services escalating on the SAME tick, the alert collapses to one summary
// line. That case is a box-wide outage (every cron row escalating together), where ~45
// per-service lines would blow Discord's 2,000-character message cap and get the whole post
// rejected — the one failure mode that would turn the loudest alert into silence.
const ESCALATION_LINE_LIMIT = 8;

/**
 * The escalation text: one line per service that has now been down long enough to stop
 * being plausibly transient. Deliberately louder than the transition line (🚨 vs 🔴) and
 * deliberately carrying the two facts the transition line can't — how many checks, and how
 * long. Plain operator voice; an ops alert is not a place for the Fluncle register.
 */
export function buildEscalationAlert(
  escalations: Escalation[],
  tickMs = TICK_INTERVAL_MS,
): string | null {
  if (escalations.length === 0) {
    return null;
  }

  const line = ({ service, streak }: Escalation) =>
    `🚨 ${service} STILL DOWN — ${streak} consecutive checks (${formatStreakDuration(streak, tickMs)}). This is not a transient.`;

  if (escalations.length <= ESCALATION_LINE_LIMIT) {
    return escalations.map(line).join("\n");
  }

  // Non-empty by the guard above, so the bare reduce is safe.
  const longest = escalations.reduce((worst, next) => (next.streak > worst.streak ? next : worst));
  const named = escalations
    .slice(0, ESCALATION_LINE_LIMIT)
    .map((escalation) => escalation.service)
    .join(", ");

  return `🚨 ${escalations.length} services STILL DOWN — longest ${longest.streak} consecutive checks (${formatStreakDuration(longest.streak, tickMs)}): ${named}, +${escalations.length - ESCALATION_LINE_LIMIT} more. This is not a transient.`;
}

/**
 * The strain line — the one that actually NAMES the sweeps, which the aggregate `sweep-errors`
 * row cannot.
 *
 * EDGE-TRIGGERED, exactly like `buildAlert`: it speaks when a sweep ENTERS the condition and
 * when it LEAVES, never on the ticks in between. There is no escalation ladder here on
 * purpose — each window spans at least three of that cron's own cadences, so "still strained"
 * is the default state of a real condition and a per-tick reminder would be the noise this
 * detector exists to avoid. The standing visibility is the /status row, which stays degraded
 * for as long as it is true.
 */
export function buildStrainAlert(newly: string[], cleared: string[]): string | null {
  if (newly.length === 0 && cleared.length === 0) {
    return null;
  }

  const parts: string[] = [];

  if (newly.length > 0) {
    parts.push(
      `⚠️ logging repeat errors while still reporting ok: ${newly.join(", ")}. Their own summaries are green; the marker bodies are not.`,
    );
  }

  if (cleared.length > 0) {
    parts.push(`🟢 quiet again: ${cleared.join(", ")}`);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// POST: send the snapshot to the agent-tier record_health endpoint. Best-effort —
// the alert already fired, so a failed POST is logged, never thrown. Returns true
// on a 2xx ack.
// ---------------------------------------------------------------------------

const HEALTH_SNAPSHOT_PRODUCER = "hermes-healthcheck";

type SnapshotFetch = (input: string, init: RequestInit, timeoutMs?: number) => Promise<Response>;

function normalizeSnapshotMessage(message: string | null): string | null {
  const collapsed = message?.replace(/\s+/g, " ").trim() ?? "";

  if (collapsed.length === 0) {
    return null;
  }

  return collapsed.length > 160 ? `${collapsed.slice(0, 159)}…` : collapsed;
}

export async function healthSnapshotReceiptMetadata(
  at: string,
  checks: CheckWithTransition[],
): Promise<{
  at: string;
  checks: CheckWithTransition[];
  operationKey: string;
  producer: string;
  requestDigest: string;
}> {
  const canonicalAt = new Date(at).toISOString();
  const canonicalChecks = checks.map((check) => ({
    latencyMs: check.latencyMs,
    message: normalizeSnapshotMessage(check.message),
    service: check.service.trim(),
    status: check.status,
    transitioned: check.transitioned,
  }));
  const canonicalRequest = JSON.stringify({
    at: canonicalAt,
    checks: canonicalChecks,
    producer: HEALTH_SNAPSHOT_PRODUCER,
  });
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalRequest),
  );
  const requestDigest = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return {
    at: canonicalAt,
    checks: canonicalChecks,
    operationKey: `health.snapshot:${HEALTH_SNAPSHOT_PRODUCER}:${canonicalAt}`,
    producer: HEALTH_SNAPSHOT_PRODUCER,
    requestDigest,
  };
}

export async function postSnapshot(
  at: string,
  checks: CheckWithTransition[],
  transport: SnapshotFetch = fetchWithTimeout,
  config: {
    token?: string;
    wait?: () => Promise<void>;
    workerUrl?: string;
  } = {},
): Promise<boolean> {
  const workerUrl = config.workerUrl ?? WORKER_URL;
  const token = config.token ?? FLUNCLE_API_TOKEN;

  if (!workerUrl) {
    log("no HEALTHCHECK_WORKER_URL — cannot POST the snapshot");

    return false;
  }

  if (!token) {
    log("no FLUNCLE_API_TOKEN in the cron env — cannot POST the snapshot");

    return false;
  }

  const metadata = await healthSnapshotReceiptMetadata(at, checks);
  const body = JSON.stringify(metadata);
  const reconcileBody = JSON.stringify({
    operationId: "health.snapshot",
    operationKey: metadata.operationKey,
    requestDigest: metadata.requestDigest,
  });

  for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt++) {
    try {
      const response = await transport(
        `${workerUrl}/api/v1/admin/health`,
        {
          body,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        },
        POST_TIMEOUT_MS,
      );

      if (response.ok) {
        return true;
      }

      // A client rejection is definitive. A gateway/server failure (including Cloudflare's
      // 524) is ambiguous: the Worker may have committed before the response was lost, so it
      // must take the same digest-bound reconciliation path as a thrown transport timeout.
      if (response.status < 500) {
        log(`record_health POST returned HTTP ${response.status} (best-effort, ignored)`);
        return false;
      }

      throw new Error("record_health POST returned an ambiguous server response");
    } catch {
      try {
        const reconciliation = await transport(
          `${workerUrl}/api/v1/admin/operation-receipts/resolve`,
          {
            body: reconcileBody,
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            method: "POST",
          },
          POST_TIMEOUT_MS,
        );

        if (!reconciliation.ok) {
          log("record_health reconciliation unavailable; snapshot was not replayed");
          return false;
        }

        const payload = (await reconciliation.json()) as {
          receipt?: { outcome?: string };
        };
        const outcome = payload.receipt?.outcome;
        if (outcome === "committed") {
          return true;
        }

        if (outcome !== "safely-retryable") {
          log("record_health reconciliation did not authorize replay");
          return false;
        }
      } catch {
        log("record_health reconciliation unavailable; snapshot was not replayed");
        return false;
      }

      if (attempt < POST_ATTEMPTS) {
        log(`record_health POST attempt ${attempt}/${POST_ATTEMPTS} was safely retryable`);
        await (config.wait?.() ?? new Promise((resolve) => setTimeout(resolve, 1000)));
        continue;
      }

      log(`record_health POST failed after ${POST_ATTEMPTS} reconciled attempts`);
      return false;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Main — probe everything (parallel), compute transitions, alert + POST.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const at = new Date().toISOString();

  // Network probes run concurrently; the file/state probes are synchronous and
  // cheap. All probes are individually timeout-bounded, so the whole tick stays
  // well under the runner's ~120s kill.
  const [web, db, r2, sonar, ssh] = await Promise.all([
    probeWeb(),
    probeDb(),
    probeR2(),
    probeSonar(),
    probeSsh(),
  ]);
  const dns = probeDns();
  const disk = probeDisk();
  // The cron output dirs are claimed ONCE and read by both consumers: judgeCron for each
  // sweep's own `{ ok }` verdict, and the strain detector for what the marker bodies say.
  const claimed = claimCronDirs(AUTOMATION_CRONS);
  const crons = probeCrons(claimed);
  const renderBox = probeRenderBox();
  const hermes = probeHermes();
  // The prober's own row — self-evident (it's run by a host timer, not the gateway,
  // so it has no cron output dir for probeCrons() to read).
  const healthcheck = probeHealthcheck();

  // One row per cron (cron.*) instead of a single `automation` aggregate, so /status
  // shows every humming system on its own line. Transitions still fire per-service
  // (the state map is keyed by service id), so a single cron going down/recovering
  // pings on its own. cron.healthcheck rides alongside the gateway crons even though
  // it's emitted self-evidently.
  // Transitions + strain both read the same state file.
  const { services: prev, strain: prevStrain } = loadState();

  // The second read of the same markers: what the sweeps LOGGED, as opposed to what they
  // reported about themselves. One aggregate row; the sweeps are named in the Discord line.
  const sweepStrain = probeSweepStrain(claimed, prevStrain);

  const checks: Check[] = [
    web,
    db,
    r2,
    sonar,
    dns,
    ssh,
    disk,
    sweepStrain.check,
    ...crons,
    healthcheck,
    renderBox,
    hermes,
  ];

  const withTransition: CheckWithTransition[] = checks.map((check) => ({
    ...check,
    transitioned: prev[check.service] !== undefined && prev[check.service]?.status !== check.status,
  }));

  // Carry each service's consecutive-down streak forward and collect whoever crossed an
  // escalation rung this tick (stamping the streak we escalated at, so the next rung is a
  // doubling away rather than the very next tick).
  const next: StateMap = {};
  const escalations: Escalation[] = [];

  for (const check of checks) {
    const state = nextServiceState(prev[check.service], check.status);
    const escalate = escalationDue(state);

    if (escalate) {
      escalations.push({ service: check.service, streak: state.downStreak });
    }

    next[check.service] = escalate ? { ...state, escalatedStreak: state.downStreak } : state;
  }

  // Persist the new map for the next tick BEFORE the network POST (so a POST failure
  // never loses the transition baseline, the streaks, or the strain windows).
  writeState(next, sweepStrain.next);

  // Alert on a transition to down or a recovery from down …
  const alert = buildAlert(withTransition, prev);

  if (alert) {
    pingDiscord(alert);
  }

  // … and, separately, on persistence: a service still down after ESCALATE_AFTER_TICKS
  // consecutive checks, then again on the doubling ladder. Its own post so it reads as the
  // different, louder thing it is rather than blending into the transition line.
  const escalationAlert = buildEscalationAlert(escalations);

  if (escalationAlert) {
    pingDiscord(escalationAlert);
  }

  // … and, separately again, on STRAIN: a sweep whose own summary still says ok but whose
  // marker body has been carrying errors for hours. Its own post because it is a different
  // claim — nothing is down, something is not getting done.
  const strainAlert = buildStrainAlert(sweepStrain.newly, sweepStrain.cleared);

  if (strainAlert) {
    pingDiscord(strainAlert);
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
    alerted: alert !== null || escalationAlert !== null || strainAlert !== null,
    at,
    // Designed backpressure stays visible without joining `strained` or changing any status.
    backpressured: sweepStrain.backpressured,
    down: withTransition.filter((c) => c.status === "down").map((c) => c.service),
    // The services that crossed an escalation rung this tick, with the streak that did it —
    // so a forensic read of the markers can see WHEN a sustained outage was escalated.
    escalated: escalations,
    ok: true as const,
    posted,
    services: withTransition.map((c) => ({
      service: c.service,
      status: c.status,
      transitioned: c.transitioned,
    })),
    // The sweeps whose marker bodies are carrying repeat errors — separate from `down` by
    // construction, since every one of them is reporting itself healthy.
    strained: sweepStrain.strained,
    transitions: withTransition.filter((c) => c.transitioned).map((c) => c.service),
  };

  console.log(JSON.stringify(summary));
}

// Guarded so the unit tests can import `judgeCron` / `findJsonSummary` without firing a tick.
if (import.meta.main) {
  main().catch((error) => {
    // A truly unexpected failure (not a probe failure — those are caught per-probe).
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    console.log(JSON.stringify({ ok: false, reason: "prober_error" }));
    process.exit(1);
  });
}
