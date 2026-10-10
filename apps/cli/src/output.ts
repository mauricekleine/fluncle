import { writeSync } from "node:fs";
import { format } from "node:util";

import { type ApiFailure } from "@fluncle/contracts";

const EAGAIN_WAIT = new Int32Array(new SharedArrayBuffer(4));

function writeFdSync(fd: 1 | 2, text: string): void {
  const buf = Buffer.from(text, "utf8");
  let offset = 0;

  while (offset < buf.length) {
    try {
      offset += writeSync(fd, buf, offset);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === "EAGAIN") {
        Atomics.wait(EAGAIN_WAIT, 0, 0, 1);
        continue;
      }

      if (code === "EPIPE") {
        return;
      }

      throw error;
    }
  }
}

export function routeConsoleThroughBlockingWrites(): void {
  const toStdout = (...args: unknown[]): void => writeFdSync(1, `${format(...args)}\n`);
  const toStderr = (...args: unknown[]): void => writeFdSync(2, `${format(...args)}\n`);

  console.debug = toStdout;
  console.error = toStderr;
  console.info = toStdout;
  console.log = toStdout;
  console.warn = toStderr;
}

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
  writeFdSync(1, JSON.stringify(value, null, 2) + "\n");
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
