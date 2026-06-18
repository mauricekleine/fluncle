import { type SimState } from "./sim";
import { type Star } from "./types";

export type LifetimeProgress = {
  collectedLogIds: string[];
  deaths?: number;
  wins?: number;
};

let csrfTokenPromise: Promise<string | undefined> | undefined;

async function csrfHeaders(): Promise<HeadersInit | undefined> {
  csrfTokenPromise ??= fetch("/api/me/csrf")
    .then(async (response) => {
      if (response.status === 401) {
        return undefined;
      }

      if (!response.ok) {
        throw new Error(`Failed to load account token: ${response.status}`);
      }

      return ((await response.json()) as { csrfToken?: string }).csrfToken;
    })
    .catch(() => undefined);

  const token = await csrfTokenPromise;

  return token ? { "Content-Type": "application/json", "x-fluncle-csrf": token } : undefined;
}

export function applyLifetimeMarkers(stars: Star[], logIds: Iterable<string>): void {
  const lifetime = new Set(Array.from(logIds, (logId) => logId.toLowerCase()));

  for (const star of stars) {
    star.lifetimeLogged = lifetime.has(star.logId.toLowerCase());
  }
}

export function collectLifetimeLogIds(state: SimState): string[] {
  return state.stars
    .filter((star) => star.collected || star.lifetimeLogged)
    .map((star) => star.logId);
}

export function mergeProgress(
  current: LifetimeProgress,
  incoming: LifetimeProgress,
): LifetimeProgress {
  return {
    collectedLogIds: Array.from(
      new Set([...current.collectedLogIds, ...incoming.collectedLogIds].map((logId) => logId)),
    ),
    deaths: Math.max(current.deaths ?? 0, incoming.deaths ?? 0),
    wins: Math.max(current.wins ?? 0, incoming.wins ?? 0),
  };
}

export async function fetchLifetimeProgress(): Promise<LifetimeProgress | undefined> {
  const response = await fetch("/api/me/galaxy-progress");

  if (response.status === 401) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(`Failed to load Galaxy progress: ${response.status}`);
  }

  return (await response.json()) as LifetimeProgress;
}

export function persistLoggedLogId(logId: string): void {
  void csrfHeaders().then((headers) => {
    if (!headers) {
      return;
    }

    void fetch("/api/me/galaxy-progress/logs", {
      body: JSON.stringify({ logId }),
      headers,
      method: "POST",
    }).catch(() => undefined);
  });
}

export function persistProgressCounters(counters: { deaths?: number; wins?: number }): void {
  void csrfHeaders().then((headers) => {
    if (!headers) {
      return;
    }

    void fetch("/api/me/galaxy-progress", {
      body: JSON.stringify(counters),
      headers,
      method: "PUT",
    }).catch(() => undefined);
  });
}
