import { type ApiFailure } from "@fluncle/contracts";

export type { ApiFailure as JsonFailure };

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
  console.log(JSON.stringify(value, null, 2));
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
