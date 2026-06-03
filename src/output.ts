export type JsonSuccess<T> = {
  ok: true;
} & T;

export type JsonFailure = {
  ok: false;
  code: string;
  message: string;
};

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

export function toJsonFailure(error: unknown): JsonFailure {
  if (error instanceof CliError) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      ok: false,
      code: "error",
      message: error.message,
    };
  }

  return {
    ok: false,
    code: "error",
    message: String(error),
  };
}
