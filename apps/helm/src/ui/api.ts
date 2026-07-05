// The glass's thin client over the daemon's /api. Same-origin fetch (the daemon
// serves the SPA) plus the EventSource wrapper for run streams.

import {
  RUN_SSE_LINE_EVENT,
  RUN_SSE_STATUS_EVENT,
  type RunLine,
  type RunSummary,
} from "../contract";

export class ApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const failure = data as { code?: string; message?: string } | undefined;
    throw new ApiError(
      failure?.code ?? `http_${response.status}`,
      failure?.message ?? `${response.status} ${response.statusText}`,
    );
  }

  return data as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    method: "POST",
  });
}

export type RunStreamHandlers = {
  onLine(line: RunLine): void;
  onStatus(run: RunSummary): void;
};

/**
 * Stream one run over SSE. The daemon replays the buffered lines, then goes
 * live, and closes the stream itself after the final status — an `error` after
 * a status landed is the normal end of the wire, not a failure.
 */
export function streamRun(feature: string, runId: string, handlers: RunStreamHandlers): () => void {
  const source = new EventSource(
    `/api/${encodeURIComponent(feature)}/runs/${encodeURIComponent(runId)}/stream`,
  );
  let done = false;

  source.addEventListener(RUN_SSE_LINE_EVENT, (event) => {
    handlers.onLine(JSON.parse((event as MessageEvent<string>).data) as RunLine);
  });

  source.addEventListener(RUN_SSE_STATUS_EVENT, (event) => {
    const run = JSON.parse((event as MessageEvent<string>).data) as RunSummary;

    if (run.status !== "running") {
      done = true;
      source.close();
    }

    handlers.onStatus(run);
  });

  source.addEventListener("error", () => {
    if (done) {
      source.close();
    }
  });

  return () => {
    source.close();
  };
}
