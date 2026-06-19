import { type ApiFailure } from "@fluncle/contracts";

export type { ApiFailure as JsonFailure };

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
