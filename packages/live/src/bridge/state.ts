import { type PlanEntry, type ShowCommand, type ShowState } from "../contract";
import { MEL_BINS } from "../contract";
import { type Fingerprint, type MatcherConfig, PlanMatcher } from "./matcher";
import { shapeNormalize } from "./mel";

const AUDIO_STALE_MS = 1_500;
const AUDIO_SILENT_MS = 5_000;

const INTENSITY_MIN = 0.4;
const INTENSITY_MAX = 1.6;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

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

  function ingest(cmd: ShowCommand, tMs: number): void {
    switch (cmd.cmd) {
      case "mel": {
        const raw = toMelFrame(cmd.frame);
        if (raw === null) {
          break;
        }
        lastMelMs = tMs;

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
        if (Number.isFinite(cmd.index)) {
          matcher.goto(cmd.index, tMs);
        }
        break;
      case "blackout":
        blackout = cmd.on;
        break;
      case "intensity":
        if (Number.isFinite(cmd.value)) {
          intensity = clamp(cmd.value, INTENSITY_MIN, INTENSITY_MAX);
        }
        break;
      case "heartbeat":
        if (Number.isFinite(cmd.renderFrame)) {
          lastHeartbeatMs = tMs;
          lastHeartbeatFrame = cmd.renderFrame;
        }
        break;
    }
  }

  function audioChannel(tMs: number): ShowState["channels"]["audio"] {
    if (lastMelMs < 0 || tMs - lastMelMs > AUDIO_SILENT_MS) {
      return "silent";
    }
    return tMs - lastMelMs > AUDIO_STALE_MS ? "stale" : "live";
  }

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

function nextFingerprintable(fingerprints: Fingerprint[], from: number): number {
  let p = from + 1;
  while (p < fingerprints.length && fingerprints[p].frames === null) {
    p++;
  }
  return p;
}
