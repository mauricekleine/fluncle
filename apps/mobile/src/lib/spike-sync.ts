export const SPIKE_SYNC_URL_ENV = "EXPO_PUBLIC_SPIKE_SYNC_URL";

export const SPIKE_TOKEN_ENV = "EXPO_PUBLIC_SPIKE_TOKEN";

export const SPIKE_PASS = "SPIKE PASS";

type SpikeLineKind = "error" | "hint" | "info" | "skipped" | "step" | "verdict";

export type SpikeLine = {
  readonly elapsedMs: number;
  readonly kind: SpikeLineKind;
  readonly text: string;
};

export type SpikeStep = {
  readonly fatal?: boolean;
  readonly id: string;

  readonly run: () => Promise<string | undefined>;
};

export type SpikeResult = {
  readonly failedStepId?: string;
  readonly lines: readonly SpikeLine[];
  readonly verdict: string;
};

export type RunSpikeOptions = {
  readonly clock?: () => number;

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

export function describeError(error: unknown): string {
  const message = errorMessage(error);
  const top = errorStackTop(error);
  return top === undefined ? message : `${message} [${top}]`;
}

const NO_LIBSQL_BUILD_HINT = `HINT: this build has no libSQL native variant. expo-sqlite compiles libSQL only when its config plugin gets useLibSQL: true (plugins: [["expo-sqlite", { useLibSQL: true }]]), followed by a fresh prebuild + native build. Expo Go can never carry it.`;

const MISSING_OPTIONS_HINT = `HINT: the native side got no url/authToken. Check ${SPIKE_SYNC_URL_ENV} and ${SPIKE_TOKEN_ENV} were exported BEFORE the bundler started. Expo inlines EXPO_PUBLIC_* at bundle time, so a mid-session export needs a bundler restart.`;

const MISSING_TABLE_HINT =
  "HINT: the table is not in the local replica. Either the remote is unseeded or the pull did not land. Seed it server-side and run again.";

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

export function describeSyncTarget(syncUrl: string): string {
  const separator = syncUrl.indexOf("://");
  if (separator === -1) {
    return "set (no scheme)";
  }
  const scheme = syncUrl.slice(0, separator);
  const lead = syncUrl.slice(separator + 3, separator + 6);

  return `${scheme}://${lead}...`;
}

export function describeToken(token: string): string {
  return `set (${token.length} chars)`;
}
