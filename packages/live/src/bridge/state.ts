// THE SHOW STATE MACHINE — the bridge's single source of truth, fused into the
// ShowState stream the glass and the phone remote both read. It owns the plan
// pointer (via the PlanMatcher), ingests ShowCommands, and tracks per-channel
// health (audio staleness, matcher readiness) + the operator dials (intensity,
// blackout). Pure of I/O: serve.ts wires it to the WebSocket and the supervisor.

import { type PlanEntry, type ShowCommand, type ShowState } from "../contract";
import { MEL_BINS } from "../contract";
import { type Fingerprint, type MatcherConfig, PlanMatcher } from "./matcher";
import { shapeNormalize } from "./mel";

/** Audio is "stale" if no mel frame arrived within this window; "silent" past it. */
const AUDIO_STALE_MS = 1_500;
const AUDIO_SILENT_MS = 5_000;

/**
 * The operator-dial intensity range the bridge accepts. Both clients that emit `intensity`
 * bound it: the glass keyboard (the reactive INPUT-drive headroom, floor 0.4 / ceiling 1.6 —
 * `glass/client/main.ts`) and the phone remote (0.4..1.3 — `bridge/remote.ts`). The wire
 * carries an unvalidated number rebroadcast to every socket at 30Hz and multiplied into the
 * glass's drive, so a stray NaN / negative / huge value must never reach the stream: clamp a
 * finite value to the widest legitimate range (the glass's [0.4, 1.6]) and reject a non-finite
 * one. Source of the range: `packages/live/src/glass/client/main.ts` (the `intensity` handler).
 */
const INTENSITY_MIN = 0.4;
const INTENSITY_MAX = 1.6;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Coerce a wire `mel` frame into exactly MEL_BINS finite numbers, or `null` when it cannot be
 * trusted — not an array, shorter than MEL_BINS, or carrying a non-finite bin. A short frame
 * would leave the matcher's cosine reading `undefined` past its length (→ NaN, poisoning the
 * broadcast match confidence at 30Hz); a NaN/Infinity bin would do the same. Dropping such a
 * frame — never fed to the matcher, never marking the audio channel live — is the state-side
 * half of the WS never-crash rail. A longer frame keeps its first MEL_BINS bins (the contract
 * shape), mirroring the old `.slice(0, MEL_BINS)`.
 */
function toMelFrame(frame: unknown): Float32Array | null {
  if (!Array.isArray(frame) || frame.length < MEL_BINS) {
    return null;
  }
  const out = new Float32Array(MEL_BINS);
  for (let i = 0; i < MEL_BINS; i++) {
    const v: unknown = frame[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return null;
    }
    out[i] = v;
  }
  return out;
}

export type ShowStateMachine = ReturnType<typeof createShowState>;

export function createShowState(
  plan: PlanEntry[],
  fingerprints: Fingerprint[],
  config: Partial<MatcherConfig> = {},
) {
  const matcher = new PlanMatcher(fingerprints, config);
  const matcherReady = fingerprints.some((f) => f.frames !== null);

  let seq = 0;
  let lastMelMs = -1;
  let lastMatch: { logId: string; confidence: number } | undefined;
  let prearmed = false;
  let intensity = 1;
  let blackout = false;
  let lastHeartbeatMs = -1;
  let lastHeartbeatFrame = -1;

  /** Ingest one command. `tMs` is the bridge wall clock. */
  function ingest(cmd: ShowCommand, tMs: number): void {
    switch (cmd.cmd) {
      case "mel": {
        // Coerce + validate the frame FIRST: a malformed frame (missing, short, or carrying a
        // non-finite bin) is dropped without marking the audio channel live — it is not audio,
        // and it would otherwise feed NaN into the cosine match. The WS boundary already
        // shape-checks the command; this is the state-side belt on the matcher feed.
        const raw = toMelFrame(cmd.frame);
        if (raw === null) {
          break;
        }
        lastMelMs = tMs;
        // Read magnitude BEFORE normalizing (the pre-arm energy proxy), then
        // SHAPE-normalize (mean-subtract + L2) for the cosine match — the same
        // normalization the server-side fingerprints get, so the wire's raw
        // log-mel and the previews compare content, not analyzer tilt.
        let energy = 0;
        for (let i = 0; i < raw.length; i++) {
          energy += raw[i];
        }
        const normalized = shapeNormalize(Float32Array.from(raw));
        const tick = matcher.pushFrame(normalized, energy, tMs);
        prearmed = tick.prearmed;
        const pendEntry = plan[tick.pending];
        if (tick.score > 0 && pendEntry) {
          lastMatch = { confidence: Number(tick.score.toFixed(3)), logId: pendEntry.logId };
        }
        break;
      }
      case "advance":
        matcher.advance(tMs);
        break;
      case "rewind":
        matcher.rewind(tMs);
        break;
      case "goto":
        // A non-finite index would break the matcher's Math.min/max clamp (→ NaN pointer);
        // drop it. A finite index is clamped to the plan inside matcher.goto.
        if (Number.isFinite(cmd.index)) {
          matcher.goto(cmd.index, tMs);
        }
        break;
      case "blackout":
        blackout = cmd.on;
        break;
      case "intensity":
        // Clamp a finite dial to the legal range; reject a non-finite one (keep the last good
        // value) so a garbage number never rebroadcasts at 30Hz and drives the glass.
        if (Number.isFinite(cmd.value)) {
          intensity = clamp(cmd.value, INTENSITY_MIN, INTENSITY_MAX);
        }
        break;
      case "heartbeat":
        // Guard the watchdog feed: a non-finite frame counter is ignored so the supervisor's
        // heartbeat age stays trustworthy.
        if (Number.isFinite(cmd.renderFrame)) {
          lastHeartbeatMs = tMs;
          lastHeartbeatFrame = cmd.renderFrame;
        }
        break;
    }
  }

  /** Audio channel health from mel-frame recency. */
  function audioChannel(tMs: number): ShowState["channels"]["audio"] {
    if (lastMelMs < 0 || tMs - lastMelMs > AUDIO_SILENT_MS) {
      return "silent";
    }
    return tMs - lastMelMs > AUDIO_STALE_MS ? "stale" : "live";
  }

  /** The fused ShowState snapshot at wall-clock `tMs`. */
  function snapshot(tMs: number): ShowState {
    const pointer = matcher.pointerIndex;
    const pending = nextFingerprintable(fingerprints, pointer);
    const currentEntry = plan[pointer];
    const pendingEntry = pending < plan.length ? plan[pending] : undefined;
    return {
      blackout,
      channels: {
        audio: audioChannel(tMs),
        matcher: matcherReady ? "ready" : "off",
      },
      current: currentEntry
        ? { artists: currentEntry.artists, logId: currentEntry.logId, title: currentEntry.title }
        : undefined,
      intensity,
      match: lastMatch,
      pending: pendingEntry
        ? { artists: pendingEntry.artists, logId: pendingEntry.logId, title: pendingEntry.title }
        : undefined,
      plan: { pointer, source: matcher.pointerSource, total: plan.length },
      prearmed,
      seq: seq++,
      t: tMs,
    };
  }

  /** For the supervisor: ms since the last render heartbeat (or -1 if never). */
  function heartbeatAgeMs(tMs: number): number {
    return lastHeartbeatMs < 0 ? -1 : tMs - lastHeartbeatMs;
  }

  return {
    heartbeatAgeMs,
    ingest,
    lastHeartbeatFrame: () => lastHeartbeatFrame,
    matcherReady,
    snapshot,
  };
}

/** The next fingerprintable index after `from` (mirrors the matcher's skip logic). */
function nextFingerprintable(fingerprints: Fingerprint[], from: number): number {
  let p = from + 1;
  while (p < fingerprints.length && fingerprints[p].frames === null) {
    p++;
  }
  return p;
}
