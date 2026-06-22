import { formatError } from "@fluncle/contracts/util";
import { ApiError } from "./spotify";

// `formatError` is the byte-shared error-stringifier — one definition in
// `@fluncle/contracts/util` (the CLI reads the same). Re-exported so existing
// `./retry` importers keep their entrypoint.
export { formatError };

export async function withRetries<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // ApiError is a deterministic app-level failure (bad input, expired auth) —
      // retrying can't change the outcome, so surface it at once and keep its type
      // and code intact for the caller to branch on.
      if (error instanceof ApiError) {
        throw error;
      }

      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  throw new Error(`${label} failed after ${attempts} attempts: ${formatError(lastError)}`);
}
