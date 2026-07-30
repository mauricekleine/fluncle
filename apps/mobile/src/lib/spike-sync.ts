// The pure half of the slice-2 de-risking spike (see app/dev/sync-spike.tsx for the
// screen and the run recipe). Everything here is framework-free and native-free so the
// step ORDERING and the FAILURE SEMANTICS — the parts that decide whether a verdict can
// be trusted — are pinned by tests instead of read off a simulator screen.
//
// The screen supplies the steps (each one a native libSQL call); this module owns the
// sequencing contract:
//   - steps run in order, one at a time, each timed on its own wall clock
//   - a step that throws is RECORDED and the run continues, so one dead leg does not
//     hide the legs after it
//   - a step marked `fatal` is different: nothing after it can mean anything (no
//     database handle, no connection), so the rest are emitted as `skipped`
//   - the verdict names the FIRST failure, because that is the one to debug

/** Env var carrying the spike's libSQL sync URL. Never hard-code the value. */
export const SPIKE_SYNC_URL_ENV = "EXPO_PUBLIC_SPIKE_SYNC_URL";

/** Env var carrying the spike's libSQL auth token. Never hard-code the value. */
export const SPIKE_TOKEN_ENV = "EXPO_PUBLIC_SPIKE_TOKEN";

export const SPIKE_PASS = "SPIKE PASS";

export type SpikeLineKind = "error" | "hint" | "info" | "skipped" | "step" | "verdict";

export type SpikeLine = {
  /** Milliseconds since the run started. */
  readonly elapsedMs: number;
  readonly kind: SpikeLineKind;
  readonly text: string;
};

export type SpikeStep = {
  /**
   * True when a failure here makes every later step meaningless (e.g. the database
   * never opened). The remaining steps are reported as `skipped` rather than run.
   */
  readonly fatal?: boolean;
  readonly id: string;
  /** Resolves with an optional detail string appended to the step's log line. */
  readonly run: () => Promise<string | undefined>;
};

export type SpikeResult = {
  /** The first step that threw, if any. */
  readonly failedStepId?: string;
  readonly lines: readonly SpikeLine[];
  readonly verdict: string;
};

export type RunSpikeOptions = {
  /** Injectable clock, so the tests can assert exact timings. */
  readonly clock?: () => number;
  /** Called as each line is produced, so the screen can render the run live. */
  readonly onLine?: (line: SpikeLine) => void;
};

export function spikeFailVerdict(stepId: string): string {
  return `SPIKE FAIL ${stepId}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const { message } = error as { message?: unknown };
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}

function errorStackTop(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== "string") {
    return undefined;
  }
  return error.stack
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("at "));
}

/** The message plus the top stack frame — enough to place a failure without a debugger. */
export function describeError(error: unknown): string {
  const message = errorMessage(error);
  const top = errorStackTop(error);
  return top === undefined ? message : `${message} [${top}]`;
}

// The three failures worth naming, because each one has a specific fix that is NOT
// obvious from the raw native message.
const NO_LIBSQL_BUILD_HINT = `HINT: this build has no libSQL native variant. expo-sqlite compiles libSQL only when its config plugin gets useLibSQL: true (plugins: [["expo-sqlite", { useLibSQL: true }]]), followed by a fresh prebuild + native build. Expo Go can never carry it.`;

const MISSING_OPTIONS_HINT = `HINT: the native side got no url/authToken. Check ${SPIKE_SYNC_URL_ENV} and ${SPIKE_TOKEN_ENV} were exported BEFORE the bundler started. Expo inlines EXPO_PUBLIC_* at bundle time, so a mid-session export needs a bundler restart.`;

const MISSING_TABLE_HINT =
  "HINT: the table is not in the local replica. Either the remote is unseeded or the pull did not land. Seed it server-side and run again.";

/**
 * An actionable hint for the failures whose raw native message does not point at the fix.
 * Returns undefined for anything else rather than guessing.
 */
export function diagnoseSpikeError(error: unknown): string | undefined {
  const message = errorMessage(error).toLowerCase();
  if (
    message.includes("not supported in the current environment") ||
    message.includes("not supported in libsql mode")
  ) {
    return NO_LIBSQL_BUILD_HINT;
  }
  if (
    message.includes("libsqlurl must be provided") ||
    message.includes("libsqlauthtoken must be provided")
  ) {
    return MISSING_OPTIONS_HINT;
  }
  if (message.includes("no such table")) {
    return MISSING_TABLE_HINT;
  }
  return undefined;
}

export function formatSpikeLine(line: SpikeLine): string {
  return `[+${(line.elapsedMs / 1000).toFixed(3)}s] ${line.text}`;
}

export function formatSpikeLog(lines: readonly SpikeLine[]): string {
  return lines.map(formatSpikeLine).join("\n");
}

export async function runSpike(
  steps: readonly SpikeStep[],
  options: RunSpikeOptions = {},
): Promise<SpikeResult> {
  const clock = options.clock ?? (() => Date.now());
  const startedAt = clock();
  const lines: SpikeLine[] = [];

  const emit = (kind: SpikeLineKind, text: string): void => {
    const line: SpikeLine = { elapsedMs: clock() - startedAt, kind, text };
    lines.push(line);
    options.onLine?.(line);
  };

  let failedStepId: string | undefined;
  let aborted = false;

  for (const step of steps) {
    if (aborted) {
      emit("skipped", `${step.id}: skipped`);
      continue;
    }

    const stepStartedAt = clock();
    try {
      const detail = await step.run();
      const took = clock() - stepStartedAt;
      emit("step", `${step.id}: ok (${took} ms)${detail === undefined ? "" : ` ${detail}`}`);
    } catch (error) {
      const took = clock() - stepStartedAt;
      emit("error", `${step.id}: FAILED (${took} ms) ${describeError(error)}`);
      const hint = diagnoseSpikeError(error);
      if (hint !== undefined) {
        emit("hint", hint);
      }
      failedStepId ??= step.id;
      if (step.fatal === true) {
        aborted = true;
      }
    }
  }

  const verdict = failedStepId === undefined ? SPIKE_PASS : spikeFailVerdict(failedStepId);
  emit("verdict", verdict);
  return { failedStepId, lines, verdict };
}

export type SpikeConfig = {
  readonly syncUrl: string;
  readonly token: string;
};

export type SpikeConfigResult =
  | { readonly kind: "missing"; readonly missing: readonly string[] }
  | { readonly kind: "ready"; readonly config: SpikeConfig };

/**
 * Reads the spike's two env values, treating absent-or-blank as missing. The screen
 * passes `process.env.EXPO_PUBLIC_*` in literally (Expo's inlining only fires on a
 * literal member access), which keeps this half testable.
 */
export function readSpikeConfig(raw: {
  readonly syncUrl: string | undefined;
  readonly token: string | undefined;
}): SpikeConfigResult {
  const syncUrl = raw.syncUrl?.trim() ?? "";
  const token = raw.token?.trim() ?? "";
  const missing: string[] = [];
  if (syncUrl === "") {
    missing.push(SPIKE_SYNC_URL_ENV);
  }
  if (token === "") {
    missing.push(SPIKE_TOKEN_ENV);
  }
  if (missing.length > 0) {
    return { kind: "missing", missing };
  }
  return { config: { syncUrl, token }, kind: "ready" };
}

/**
 * A log-safe description of the sync target: enough to prove the right env arrived,
 * never enough to hand out the host. The log gets shared out of the device, and this
 * repo is public.
 */
export function describeSyncTarget(syncUrl: string): string {
  const separator = syncUrl.indexOf("://");
  if (separator === -1) {
    return "set (no scheme)";
  }
  const scheme = syncUrl.slice(0, separator);
  const lead = syncUrl.slice(separator + 3, separator + 6);
  // A fixed elision, not one star per character: the host's LENGTH is a hint too.
  return `${scheme}://${lead}...`;
}

/** Proves the token arrived and survived the shell without ever printing it. */
export function describeToken(token: string): string {
  return `set (${token.length} chars)`;
}
