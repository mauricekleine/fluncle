import { CliError, printJson } from "./output";

export const DEFAULT_NON_INTERACTIVE_TIMEOUT_SECONDS = 240;
export const TIMEOUT_EXIT_CODE = 124;
export const TIMEOUT_ENV = "FLUNCLE_TIMEOUT";

type DeadlineState = {
  at: null | number;
  note: null | string;
};

const state: DeadlineState = { at: null, note: null };

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

export function armDeadline(
  seconds: number,
  options: {
    command: string;
    exit?: (code: number) => never;
    json: boolean;
    now?: () => number;
    report?: (message: string) => void;
    schedule?: (fire: () => void, ms: number) => void;
  },
): void {
  if (seconds <= 0) {
    state.at = null;
    return;
  }

  const now = options.now ?? Date.now;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const report =
    options.report ??
    ((message: string) => {
      if (options.json) {
        printJson({ code: "timeout", message, ok: false });
        return;
      }

      console.error(message);
    });
  const schedule =
    options.schedule ??
    ((fire: () => void, ms: number) => {
      setTimeout(fire, ms).unref();
    });

  state.at = now() + seconds * 1000;
  schedule(() => {
    report(timeoutMessage(options.command, seconds, state.note));
    exit(TIMEOUT_EXIT_CODE);
  }, seconds * 1000);
}

export function deadlineAt(): null | number {
  return state.at;
}

export function noteProgress(note: string): void {
  state.note = note;
}

export function progressNote(): null | string {
  return state.note;
}

export function resetDeadlineForTests(): void {
  state.at = null;
  state.note = null;
}
