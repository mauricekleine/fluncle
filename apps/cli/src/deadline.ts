import { CliError, printJson } from "./output";

export const DEFAULT_NON_INTERACTIVE_TIMEOUT_SECONDS = 240;
export const TIMEOUT_EXIT_CODE = 124;
export const TIMEOUT_ENV = "FLUNCLE_TIMEOUT";
export const CLEANUP_GRACE_MS = 10_000;

type DeadlineState = {
  at: null | number;
  cancel: (() => void) | null;
  controller: AbortController;
  fired: boolean;
  note: null | string;
};

const state: DeadlineState = {
  at: null,
  cancel: null,
  controller: new AbortController(),
  fired: false,
  note: null,
};

export function parseTimeoutSeconds(value: string | undefined, source: string): null | number {
  if (value === undefined || value.trim() === "") {
    return null;
  }

  const trimmed = value.trim();

  if (["0", "off", "none"].includes(trimmed.toLowerCase())) {
    return 0;
  }

  const seconds = Number(trimmed);

  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CliError(
      "invalid_timeout",
      `${source} must be a number of seconds (0 disables the deadline), not "${value}"`,
    );
  }

  return seconds;
}

export function resolveTimeoutSeconds(input: {
  env: string | undefined;
  flag: string | undefined;
  interactive: boolean;
}): number {
  const flag = parseTimeoutSeconds(input.flag, "--timeout");

  if (flag !== null) {
    return flag;
  }

  const env = parseTimeoutSeconds(input.env, TIMEOUT_ENV);

  if (env !== null) {
    return env;
  }

  return input.interactive ? 0 : DEFAULT_NON_INTERACTIVE_TIMEOUT_SECONDS;
}

export function timeoutMessage(command: string, seconds: number, note: null | string): string {
  const waiting = note ? `: ${note}` : "";

  return `fluncle ${command} stopped after ${seconds} s${waiting}. Set --timeout or ${TIMEOUT_ENV} in seconds (0 disables the deadline).`;
}

export type DeadlineOptions = {
  command: string;
  exit?: (code: number) => void;
  graceMs?: number;
  json: boolean;
  now?: () => number;
  report?: (message: string) => void;
  schedule?: (fire: () => void, ms: number) => () => void;
};

function defaultSchedule(fire: () => void, ms: number): () => void {
  const timer = setTimeout(fire, ms);
  timer.unref();

  return () => clearTimeout(timer);
}

export function armDeadline(seconds: number, options: DeadlineOptions): void {
  disarmDeadline();

  if (seconds <= 0) {
    state.at = null;
    return;
  }

  const now = options.now ?? Date.now;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const schedule = options.schedule ?? defaultSchedule;
  const report =
    options.report ??
    ((message: string) => {
      if (options.json) {
        printJson({ code: "timeout", message, ok: false });
        return;
      }

      console.error(message);
    });

  state.at = now() + seconds * 1000;
  state.cancel = schedule(() => {
    const message = timeoutMessage(options.command, seconds, state.note);
    state.fired = true;
    state.cancel = null;
    report(message);
    process.exitCode = TIMEOUT_EXIT_CODE;
    state.controller.abort(new CliError("timeout", message));
    schedule(() => exit(TIMEOUT_EXIT_CODE), options.graceMs ?? CLEANUP_GRACE_MS);
  }, seconds * 1000);
}

export function disarmDeadline(): void {
  state.cancel?.();
  state.cancel = null;
}

export function deadlineAt(): null | number {
  return state.at;
}

export function deadlineFired(): boolean {
  return state.fired;
}

export function deadlineSignal(): AbortSignal {
  return state.controller.signal;
}

export function remainingDeadlineMs(now: () => number = Date.now): null | number {
  return state.at === null ? null : state.at - now();
}

export function assertBeforeDeadline(doing: string): void {
  const remaining = remainingDeadlineMs();

  if (remaining !== null && remaining <= 0) {
    throw new CliError("timeout", `the deadline passed while ${doing}`);
  }
}

export function noteProgress(note: string): void {
  state.note = note;
}

export function progressNote(): null | string {
  return state.note;
}

export function resetDeadlineForTests(): void {
  disarmDeadline();
  state.at = null;
  state.fired = false;
  state.note = null;
  state.controller = new AbortController();
}
