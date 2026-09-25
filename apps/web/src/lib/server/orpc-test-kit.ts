import { beforeAll } from "vitest";

export { readJson } from "./orpc-test-helpers";

export const BASE = "https://www.fluncle.com/api/v1";

export const OPERATOR_TOKEN = "test-token-admin-operator";
export const AGENT_TOKEN = "test-token-admin-agent";

export function setAdminTokenEnv(): void {
  process.env.FLUNCLE_API_TOKEN = OPERATOR_TOKEN;
  process.env.FLUNCLE_AGENT_TOKEN = AGENT_TOKEN;
}

export function warmOrpcRouter(): void {
  beforeAll(async () => {
    await import("./orpc");
  }, 120_000);
}

export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

export function req(
  path: string,
  method: string,
  token: string | undefined,
  body?: unknown,
): Request {
  const headers: Record<string, string> = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  return new Request(apiUrl(path), {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    method,
  });
}

export function get(url: string): Request {
  return new Request(url, { method: "GET" });
}

export function post(url: string, body: string): Request {
  return new Request(url, {
    body,
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

export function postJson(url: string, payload: unknown): Request {
  return post(url, JSON.stringify(payload));
}

export function jsonRequest(url: string, method: string, payload: unknown): Request {
  return new Request(url, {
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
    method,
  });
}

export const TRACK = {
  addedAt: "2026-01-01T00:00:00.000Z",
  addedToSpotify: true,
  artists: ["Some Artist"],
  durationMs: 300000,
  enrichmentStatus: "done",
  postedToTelegram: true,
  spotifyUrl: "https://open.spotify.com/track/abc",
  title: "Some Banger",
  trackId: "abc",
};

export const MIXTAPE = {
  artists: ["Fluncle"] as ["Fluncle"],
  externalUrls: {},
  memberCount: 0,
  members: [],
  status: "published" as const,
  title: "A Set",
  type: "mixtape" as const,
};
