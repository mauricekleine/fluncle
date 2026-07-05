import { writeSync } from "node:fs";

import { type ApiFailure } from "@fluncle/contracts";

export type { ApiFailure as JsonFailure };

// A one-shared-int scratch buffer for a sub-millisecond synchronous yield on the
// rare EAGAIN (see writeStdoutSync). Allocated once; Atomics.wait blocks the thread
// without a hot spin.
const EAGAIN_WAIT = new Int32Array(new SharedArrayBuffer(4));

/**
 * Write `text` to stdout SYNCHRONOUSLY and in full, then return.
 *
 * `console.log` / `process.stdout.write` are asynchronous for a pipe, and the Bun
 * runtime can exit before that async write drains — so a large payload piped into a
 * consumer (`fluncle … --json | jq`, or a script's `subprocess`) is silently
 * truncated at the ~64KB OS pipe buffer. A blocking `writeSync(1, …)` loop finishes
 * the write before control returns, so the process can never exit mid-flush.
 * Partial writes are resumed; a momentarily-full non-blocking pipe (EAGAIN) is waited
 * on and retried rather than dropping bytes.
 */
export function writeStdoutSync(text: string): void {
  const buf = Buffer.from(text, "utf8");
  let offset = 0;

  while (offset < buf.length) {
    try {
      offset += writeSync(1, buf, offset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") {
        // The pipe is full and the fd is non-blocking; the reader will drain it.
        // Block ~1ms instead of hot-spinning, then retry the remaining bytes.
        Atomics.wait(EAGAIN_WAIT, 0, 0, 1);
        continue;
      }

      throw error;
    }
  }
}

/**
 * Narrow an untyped parsed JSON body to the `ApiFailure` shape the API emits on a
 * non-2xx (`{ ok: false, code, message }`). The HTTP client reads `code`/`message`
 * off the error arm; this guard replaces a blind `data as JsonFailure` so a
 * malformed/shapeless error body can't be read as a failure (it falls back to the
 * status line instead).
 */
export function isJsonFailure(value: unknown): value is ApiFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ApiFailure).code === "string" &&
    typeof (value as ApiFailure).message === "string"
  );
}

export class CliError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

export function printJson(value: unknown): void {
  // Synchronous full write — a large JSON payload piped into a consumer must not be
  // truncated at the OS pipe buffer when the process exits (see writeStdoutSync).
  writeStdoutSync(JSON.stringify(value, null, 2) + "\n");
}

export function toJsonFailure(error: unknown): ApiFailure {
  if (error instanceof CliError) {
    return {
      code: error.code,
      message: error.message,
      ok: false,
    };
  }

  if (error instanceof Error) {
    return {
      code: "error",
      message: error.message,
      ok: false,
    };
  }

  return {
    code: "error",
    message: String(error),
    ok: false,
  };
}
