// The shared vocabulary of the /recommendations door — the honest types the route and
// its pieces agree on, plus the four PURE folds the surface leans on (gate selection, the
// two frontier folds, and the seed-mutation message). The folds are pure so they pin as
// plain units (shared.test.ts): no React, no fetch, no DOM.
//
// The rec DTOs come straight from E1's server core (lib/server/recommendations) — the wire
// this door consumes — imported type-only so nothing server-side reaches the client bundle.

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

/**
 * One past edition, opened: the summary that named it in the dropdown plus its frozen
 * tracklist (Unit A1's `getFrontierEdition` return shape, `null` when the number resolves
 * to no edition for the user). The edition dialog reads this via its lazy per-open query.
 */
export type FrontierEditionDetail = {
  summary: FrontierEditionSummary;
  tracks: FrontierEditionTrack[];
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
      editions: FrontierEditionSummary[];
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

/**
 * Which past edition the dialog opens, from the dropdown's `openNumber` state and the loaded
 * summary list. `null` — nothing selected, or a number no longer in the list — closes the
 * dialog: the EditionDialog returns null on a null summary, so its number narrows inside (no
 * non-null assertion).
 */
export function resolveOpenSummary(
  editions: FrontierEditionSummary[],
  openNumber: number | null,
): FrontierEditionSummary | null {
  if (openNumber === null) {
    return null;
  }

  return editions.find((edition) => edition.number === openNumber) ?? null;
}

/**
 * The save POST body for a frozen row — the register-aware shape (Unit E's generalized save):
 * a finding carries its Log ID so the save stores it; a catalogue cut has no coordinate, so it
 * sends only its track id and the save files it unnamed.
 */
export function savedFindingBody(track: {
  logId?: string;
  trackId: string;
}): { logId: string; trackId: string } | { trackId: string } {
  return track.logId ? { logId: track.logId, trackId: track.trackId } : { trackId: track.trackId };
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
