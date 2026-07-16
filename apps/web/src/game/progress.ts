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

    // Logged IS collected (the ruling): a star reached in any run stays reached.
    // Re-collecting is not the game — the universe GROWS as new findings land,
    // and the reward of returning is the new stars, not the old ones. The HUD
    // counter reads lifetime + run against the whole growing field ("60/75").
    if (star.lifetimeLogged) {
      star.collected = true;
    }
  }
}

export function collectLifetimeLogIds(state: SimState): string[] {
  return state.stars.flatMap((star) => (star.collected || star.lifetimeLogged ? [star.logId] : []));
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

/**
 * The signed-in crew number, for the ship stamp (account brief, ruling #1). Reads the
 * same `/me` identity the account surfaces do, on the same fetch-and-tolerate seam as
 * the lifetime sync: an absent session, an unshipped field, or any failure all resolve
 * to `undefined`, and the HUD renders nothing. The field is optional server-side (a
 * parallel wave adds `crewNumber` to the PublicUser), so this reads it defensively.
 */
export async function fetchCrewNumber(): Promise<number | undefined> {
  try {
    const response = await fetch("/api/me");

    if (!response.ok) {
      return undefined;
    }

    const body = (await response.json()) as { user?: { crewNumber?: number } | null };
    const crewNumber = body.user?.crewNumber;

    return typeof crewNumber === "number" ? crewNumber : undefined;
  } catch {
    return undefined;
  }
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
