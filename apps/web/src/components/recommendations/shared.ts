// The shared vocabulary of the /recommendations door — the honest types the route and
// its pieces agree on, plus the four PURE folds the surface leans on (gate selection, the
// two frontier folds, and the seed-mutation message). The folds are pure so they pin as
// plain units (shared.test.ts): no React, no fetch, no DOM.
//
// The rec DTOs come straight from E1's server core (lib/server/recommendations) — the wire
// this door consumes — imported type-only so nothing server-side reaches the client bundle.

import {
  type RecommendationCatalogueItem,
  type RecommendationFindingItem,
  type RecommendationsResult,
  type RecSeedItem,
} from "@/lib/server/recommendations";

export type {
  RecommendationCatalogueItem,
  RecommendationFindingItem,
  RecommendationsResult,
  RecSeedItem,
};

/**
 * The door's gate, resolved from the requester's own session (the /chat crew-door
 * precedent). The verified state carries everything the SSR loader computed: the mutation
 * token, the seed set, and the first computed recommendations — react-query seeds off them.
 */
export type RecsGate =
  | { state: "anonymous" }
  | { state: "unverified" }
  | {
      csrfToken: string;
      recommendations: RecommendationsResult;
      seeds: RecSeedItem[];
      state: "verified";
    };

/**
 * The seed cap, mirrored client-side for the picked-state UI (the server's `MAX_REC_SEEDS`
 * stays the authority — it 409s a breach; this only decides when an un-picked row disables).
 */
export const SEED_CAP = 12;

/** The empty recommendation payload — the zero-seed reply, and the read-failure fallback. */
export const EMPTY_RECS: RecommendationsResult = {
  catalogue: [],
  findings: [],
  ok: true,
  seedsSkipped: [],
  seedsUsed: 0,
};

/**
 * The frontier playlist's state, folded from `GET /me/frontier-playlist`. `mintingOpen`
 * is the switch the parallel agent owns; until its endpoint lands, every read 404-folds to
 * closed (never an error — the door still works without a playlist leg).
 */
export type FrontierState = {
  lastSyncedAt?: string;
  mintingOpen: boolean;
  playlistUrl?: string;
};

/** Minting is closed: no endpoint yet, or the operator's switch is off. */
export const FRONTIER_CLOSED: FrontierState = { mintingOpen: false };

/** The outcome of `POST /me/frontier-playlist`, folded to what the button renders next. */
export type FrontierMintStatus = "minted" | "refreshed" | "switch_off" | "unchanged";

export type FrontierMintResult =
  | { kind: "closed" }
  | { kind: "error"; message: string }
  | { kind: "ok"; playlistUrl?: string; status: Exclude<FrontierMintStatus, "switch_off"> };

/** The three gate states, resolved from the session user (absent = anonymous). */
export function resolveGateState(
  user: { emailVerified: boolean } | null | undefined,
): "anonymous" | "unverified" | "verified" {
  if (!user) {
    return "anonymous";
  }

  return user.emailVerified ? "verified" : "unverified";
}

/**
 * Fold `GET /me/frontier-playlist` into a `FrontierState`. A 404 (the parallel agent's
 * endpoint hasn't merged), any non-ok status, or a shapeless body all fold to CLOSED — the
 * playlist leg simply reads "opening soon" rather than erroring.
 */
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

/**
 * Fold `POST /me/frontier-playlist` into what the mint button does next. A 404 or a
 * `switch_off` status both fold to CLOSED (the button goes disabled-quiet); a real status
 * carries its playlist URL through; anything else is a plain, non-blaming error line.
 */
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
      message: readMessage(input.body) ?? "Could not mint your playlist. Try again in a moment.",
    };
  }

  const status = input.body.status;

  if (status === "switch_off") {
    return { kind: "closed" };
  }

  if (status === "minted" || status === "refreshed" || status === "unchanged") {
    return {
      kind: "ok",
      playlistUrl: typeof input.body.playlistUrl === "string" ? input.body.playlistUrl : undefined,
      status,
    };
  }

  return { kind: "error", message: "Could not mint your playlist. Try again in a moment." };
}

/**
 * The message a seed mutation surfaces. Success and the 401 (handled by a redirect) are
 * silent; the 12-seed cap's 409 surfaces the SERVER's own honest instruction verbatim
 * (never a paraphrase of the cap number), and everything else is a quiet, non-blaming line.
 */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a `jsonError`-shaped `{ message }` off a mutation body (the oRPC error envelope). */
function readMessage(body: unknown): string | undefined {
  if (isRecord(body) && typeof body.message === "string" && body.message.trim() !== "") {
    return body.message;
  }

  return undefined;
}
