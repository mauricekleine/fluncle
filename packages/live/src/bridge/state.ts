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
        lastMelMs = tMs;
        // Read magnitude BEFORE normalizing (the pre-arm energy proxy), then
        // SHAPE-normalize (mean-subtract + L2) for the cosine match — the same
        // normalization the server-side fingerprints get, so the wire's raw
        // log-mel and the previews compare content, not analyzer tilt.
        const raw = Float32Array.from(cmd.frame.slice(0, MEL_BINS));
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
        matcher.goto(cmd.index, tMs);
        break;
      case "blackout":
        blackout = cmd.on;
        break;
      case "intensity":
        intensity = cmd.value;
        break;
      case "heartbeat":
        lastHeartbeatMs = tMs;
        lastHeartbeatFrame = cmd.renderFrame;
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
