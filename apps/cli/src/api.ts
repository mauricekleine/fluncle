import { getApiBaseUrl, loadEnv } from "./env";
import { CliError, isJsonFailure } from "./output";

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
  // A bodyless POST (the query-only admin ops: backfills, enrich-sweep, the token
  // mints, publish) must NOT claim a JSON content-type — an empty body with
  // `Content-Type: application/json` is malformed, and the oRPC handler rejects it
  // as `invalid_request` (it tries to JSON-parse the empty body). Send the header
  // only when there is a body to type.
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
    // No Content-Type header: fetch sets multipart/form-data with the boundary.
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

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, init);
  const text = await response.text();
  const data = parseJson(text);

  if (!response.ok) {
    // Validate the error arm before reading it: a malformed/shapeless error body
    // degrades to the HTTP status line instead of surfacing `undefined`.
    const failure = isJsonFailure(data) ? data : undefined;
    throw new CliError(
      failure?.code ?? `http_${response.status}`,
      failure?.message ?? `${response.status} ${response.statusText}`,
    );
  }

  // The caller supplies `T` from the contract response types (`@fluncle/contracts`);
  // this is the boundary cast over the JSON-parsed body (the one documented escape
  // hatch in the thin HTTP client).
  return data as T;
}

function parseJson(text: string): unknown {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliError("invalid_api_response", text);
  }
}
