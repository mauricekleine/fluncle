import { Data, Effect } from "effect";
import { deadlineSignal, noteProgress } from "./deadline";
import { getApiBaseUrl, loadEnv } from "./env";
import { CliError, isJsonFailure } from "./output";
import { readUserToken } from "./user-token";

export async function userApiGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path, {
    headers: userHeaders(),
  });
}

function userHeaders(): Record<string, string> {
  const stored = readUserToken();

  if (!stored) {
    throw new CliError(
      "not_logged_in",
      "You're not signed in. Run `fluncle login` to link this device to your account.",
    );
  }

  return {
    Authorization: `Bearer ${stored.token}`,
  };
}

export async function publicApiGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path);
}

export async function publicApiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
}

export async function adminApiGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path, {
    headers: adminHeaders(),
  });
}

export async function adminApiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...adminHeaders(),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    method: "POST",
  });
}

export async function adminApiPostForm<T>(path: string, form: FormData): Promise<T> {
  return apiRequest<T>(path, {
    body: form,
    headers: adminHeaders(),
    method: "POST",
  });
}

export async function adminApiPatch<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
    },
    method: "PATCH",
  });
}

export async function adminApiPut<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...adminHeaders(),
      "Content-Type": "application/json",
    },
    method: "PUT",
  });
}

export async function adminApiDelete<T>(path: string): Promise<T> {
  return apiRequest<T>(path, {
    headers: adminHeaders(),
    method: "DELETE",
  });
}

function adminHeaders(): Record<string, string> {
  const env = loadEnv(["FLUNCLE_API_TOKEN"]);

  return {
    Authorization: `Bearer ${env.FLUNCLE_API_TOKEN}`,
  };
}

class ApiTransportError extends Data.TaggedError("ApiTransportError")<{
  cause: unknown;
}> {}

class ApiResponseError extends Data.TaggedError("ApiResponseError")<{
  code: string;
  message: string;
}> {}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${getApiBaseUrl()}${path}`;
  noteProgress(`waiting for the Fluncle API: ${init.method ?? "GET"} ${path}`);

  return Effect.runPromise(
    Effect.gen(function* () {
      const { response, text } = yield* Effect.tryPromise({
        catch: (cause) => new ApiTransportError({ cause }),
        try: async (signal) => {
          const response = await fetch(url, {
            ...init,
            signal: AbortSignal.any([signal, deadlineSignal()]),
          });

          return { response, text: await response.text() };
        },
      });
      const data = yield* parseJson(text);

      if (!response.ok) {
        const failure = isJsonFailure(data) ? data : undefined;

        return yield* new ApiResponseError({
          code: failure?.code ?? `http_${response.status}`,
          message: failure?.message ?? `${response.status} ${response.statusText}`,
        });
      }

      return data as T;
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "ApiTransportError" ? error.cause : new CliError(error.code, error.message),
      ),
    ),
  );
}

function parseJson(text: string): Effect.Effect<unknown, ApiResponseError> {
  if (!text) {
    return Effect.void;
  }

  return Effect.try({
    catch: () => new ApiResponseError({ code: "invalid_api_response", message: text }),
    try: () => JSON.parse(text) as unknown,
  });
}
