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
// lagging. Mirror of @fluncle/registry cronSurfaces() — when a cron is added there,
// add it here too (this script can't import the workspace package on the box).
// One known cron: the registry surface id we emit, the bare token its output-dir
// header carries, and its cadence.
export type CronDef = { cadenceMs: number; match: string; service: string };

const AUTOMATION_CRONS: CronDef[] = [
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
  // The weekly Frontier playlist refresh (E2) — Fri 07:00 Amsterdam; same generous weekly floor
  // as the newsletter. No token collision: no other cron token contains "frontier-refresh".
  { cadenceMs: 7 * 24 * 60 * 60_000, match: "frontier-refresh", service: "cron.frontier-refresh" },
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
  const lines = body
    .split("\n")
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
  // The stale budget: a run within 3× the cadence (plus a small floor for clock jitter).
  const staleBudgetMs = Math.max(cron.cadenceMs * 3, 90_000);

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
function probeCrons(): Check[] {
  const claimed = claimCronDirs(AUTOMATION_CRONS);
  const uptimeMs = boxUptimeMs();

  return AUTOMATION_CRONS.map((cron) =>
    cronCheck(cron, judgeCron(cron, claimed.get(cron.service), uptimeMs)),
  );
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

const STATE_VERSION = 2;

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

function loadState(): StateMap {
  if (!existsSync(STATE_FILE)) {
    return {};
  }

  try {
    return normalizeState(JSON.parse(readFileSync(STATE_FILE, "utf8")) as unknown);
  } catch (error) {
    log(
      `could not read state (${error instanceof Error ? error.message : String(error)}) — re-baselining`,
    );
  }

  return {};
}

/** Exactly what goes on disk — exported so the round-trip is tested through the real shape. */
export function serializeState(next: StateMap): string {
  return `${JSON.stringify({ services: next, version: STATE_VERSION }, null, 2)}\n`;
}

function writeState(next: StateMap): void {
  try {
    // mkdir -p the state dir (recursive is a no-op when it already exists).
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, serializeState(next), "utf8");
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

  for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt++) {
    try {
      const response = await fetchWithTimeout(
        `${WORKER_URL}/api/v1/admin/health`,
        {
          body,
          headers: {
            Authorization: `Bearer ${FLUNCLE_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        },
        POST_TIMEOUT_MS,
      );

      if (response.ok) {
        return true;
      }

      // A 4xx/5xx is a definitive answer, not a transient abort — don't retry it.
      log(`record_health POST returned HTTP ${response.status} (best-effort, ignored)`);

      return false;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      if (attempt < POST_ATTEMPTS) {
        log(`record_health POST attempt ${attempt}/${POST_ATTEMPTS} failed (${detail}); retrying`);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        continue;
      }

      log(
        `record_health POST failed after ${POST_ATTEMPTS} attempts (best-effort, ignored): ${detail}`,
      );

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
  const crons = probeCrons();
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
  const checks: Check[] = [
    web,
    db,
    r2,
    sonar,
    dns,
    ssh,
    disk,
    ...crons,
    healthcheck,
    renderBox,
    hermes,
  ];

  // Transitions against the prior state map.
  const prev = loadState();
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
  // never loses the transition baseline or the streaks).
  writeState(next);

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
    alerted: alert !== null || escalationAlert !== null,
    at,
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
