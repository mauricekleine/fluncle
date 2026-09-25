import { writeSync } from "node:fs";

import { type ApiFailure } from "@fluncle/contracts";

export type { ApiFailure as JsonFailure };

const EAGAIN_WAIT = new Int32Array(new SharedArrayBuffer(4));

export function writeStdoutSync(text: string): void {
  const buf = Buffer.from(text, "utf8");
  let offset = 0;

  while (offset < buf.length) {
    try {
      offset += writeSync(1, buf, offset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") {
        Atomics.wait(EAGAIN_WAIT, 0, 0, 1);
        continue;
      }

      throw error;
    }
  }
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
