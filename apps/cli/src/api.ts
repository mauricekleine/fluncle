import { getApiBaseUrl, loadEnv } from "./env";
import { CliError } from "./output";

type ApiFailure = {
  ok?: false;
  code?: string;
  message?: string;
};

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
      "Content-Type": "application/json",
    },
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
    const failure = data as ApiFailure | undefined;
    throw new CliError(
      failure?.code ?? `http_${response.status}`,
      failure?.message ?? `${response.status} ${response.statusText}`,
    );
  }

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
