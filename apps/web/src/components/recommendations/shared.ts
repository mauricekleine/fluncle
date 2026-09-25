import {
  type FrontierEditionSummary,
  type FrontierEditionTrack,
} from "@/lib/server/frontier-editions";
import {
  type RecommendationCatalogueItem,
  type RecommendationFindingItem,
  type RecommendationsResult,
  type RecSeedItem,
} from "@/lib/server/recommendations";

export type {
  FrontierEditionSummary,
  FrontierEditionTrack,
  RecommendationCatalogueItem,
  RecommendationFindingItem,
  RecommendationsResult,
  RecSeedItem,
};

export type FrontierEditionDetail = {
  summary: FrontierEditionSummary;
  tracks: FrontierEditionTrack[];
};

export type RecsGate =
  | { state: "anonymous" }
  | { state: "unverified" }
  | {
      csrfToken: string;
      editions: FrontierEditionSummary[];
      latest: FrontierEditionDetail | null;
      recommendations: RecommendationsResult;
      seeds: RecSeedItem[];
      stale: boolean;
      state: "verified";
    };

export const SEED_CAP = 12;

export const EMPTY_RECS: RecommendationsResult = {
  catalogue: [],
  findings: [],
  ok: true,
  seedsSkipped: [],
  seedsUsed: 0,
};

export type FrontierState = {
  lastSyncedAt?: string;
  mintingOpen: boolean;
  playlistUrl?: string;
};

export const FRONTIER_CLOSED: FrontierState = { mintingOpen: false };

export type FrontierMintStatus = "building" | "edition_only" | "minted" | "refreshed" | "unchanged";

export type FrontierMintResult =
  | { kind: "closed" }
  | { kind: "error"; message: string }
  | { kind: "ok"; playlistUrl?: string; status: FrontierMintStatus };

export function resolveGateState(
  user: { emailVerified: boolean } | null | undefined,
): "anonymous" | "unverified" | "verified" {
  if (!user) {
    return "anonymous";
  }

  return user.emailVerified ? "verified" : "unverified";
}

export function foldFrontierStatus(input: {
  body: unknown;
  ok: boolean;
  status: number;
}): FrontierState {
  if (!input.ok || !isRecord(input.body) || input.body.ok !== true) {
    return FRONTIER_CLOSED;
  }

  const body = input.body;

  return {
    lastSyncedAt: typeof body.lastSyncedAt === "string" ? body.lastSyncedAt : undefined,
    mintingOpen: body.mintingOpen === true,
    playlistUrl: typeof body.playlistUrl === "string" ? body.playlistUrl : undefined,
  };
}

export function foldFrontierMint(input: {
  body: unknown;
  ok: boolean;
  status: number;
}): FrontierMintResult {
  if (input.status === 404) {
    return { kind: "closed" };
  }

  if (!input.ok || !isRecord(input.body) || input.body.ok !== true) {
    return {
      kind: "error",
      message: readMessage(input.body) ?? "Could not get your playlist. Try again in a moment.",
    };
  }

  const status = input.body.status;

  if (
    status === "building" ||
    status === "edition_only" ||
    status === "minted" ||
    status === "refreshed" ||
    status === "unchanged"
  ) {
    return {
      kind: "ok",
      playlistUrl: typeof input.body.playlistUrl === "string" ? input.body.playlistUrl : undefined,
      status,
    };
  }

  return { kind: "error", message: "Could not get your playlist. Try again in a moment." };
}

export function mintToastMessage(status: FrontierMintStatus): string {
  switch (status) {
    case "building":
      return "Saved. Your Spotify playlist is on its way.";
    case "edition_only":
      return "Saved. Your Spotify playlist follows soon.";
    case "minted":
      return "Done. It's on your Spotify.";
    case "refreshed":
      return "Refreshed with your latest picks.";
    case "unchanged":
      return "Already up to date.";
  }
}

export function skippedSeedsLine(count: number): string {
  return count === 1
    ? "One of your picks isn't steering yet. Fluncle hasn't got its audio."
    : `${count} of your picks aren't steering yet. Fluncle hasn't got their audio.`;
}

export function isEditionStale(edition: FrontierEditionDetail, seeds: RecSeedItem[]): boolean {
  const { refreshedAt, seedsSkipped, seedsUsed } = edition.summary;

  if (seeds.some((seed) => seed.addedAt > refreshedAt)) {
    return true;
  }

  if (seedsUsed !== undefined && seedsSkipped !== undefined) {
    return seeds.length !== seedsUsed + seedsSkipped.length;
  }

  return false;
}

export type PlaylistCta =
  | { kind: "get-playlist" }
  | { kind: "open"; url: string }
  | { kind: "waiting" };

export function resolvePlaylistCta(input: {
  phase: "committed" | "draft";
  playlistUrl?: string;
}): PlaylistCta {
  if (input.phase === "draft") {
    return { kind: "get-playlist" };
  }

  if (input.playlistUrl) {
    return { kind: "open", url: input.playlistUrl };
  }

  return { kind: "waiting" };
}

export function seedMutationMessage(input: { body: unknown; ok: boolean; status: number }): string {
  if (input.ok || input.status === 401) {
    return "";
  }

  const message = readMessage(input.body);

  if (input.status === 409) {
    return message ?? "You can pick up to 12 seeds. Remove one to add another.";
  }

  return message ?? "Could not update your seeds. Try again in a moment.";
}

export function resolveOpenSummary(
  editions: FrontierEditionSummary[],
  openNumber: number | null,
): FrontierEditionSummary | null {
  if (openNumber === null) {
    return null;
  }

  return editions.find((edition) => edition.number === openNumber) ?? null;
}

export function savedFindingBody(track: {
  logId?: string;
  trackId: string;
}): { logId: string; trackId: string } | { trackId: string } {
  return track.logId ? { logId: track.logId, trackId: track.trackId } : { trackId: track.trackId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMessage(body: unknown): string | undefined {
  if (isRecord(body) && typeof body.message === "string" && body.message.trim() !== "") {
    return body.message;
  }

  return undefined;
}
