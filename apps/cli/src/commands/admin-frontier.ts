// The `fluncle admin frontier` commands — the Frontier's thin HTTP client (E2, the
// public recommendation machine). ONE verb, admin tier (agent-allowed), a thin wrapper
// over the `refresh_frontier_playlists` oRPC op — the CLI holds no sync logic; the
// mirror + the Spotify writes happen inside the Worker. It is a pacer, not an engine.
//
//   - `refresh` — one tick of the paced refresh DRAIN (`refresh_frontier_playlists`).
//     This is the command the on-box `fluncle-frontier-refresh` cron drives (every ~15
//     min) with the box's agent token: it processes one batch of DUE users and prints one
//     JSON summary line. `--limit` overrides the batch size for an attended burn.
//   - `status` — the kill switch's state (`get_frontier_minting`, agent-allowed read).
//   - `open` / `close` — the kill switch itself (`set_frontier_minting`, OPERATOR only:
//     the Worker 403s an agent token; opening minting is a Spotify-account authority
//     grant, the `set_capture_budget` class).

import { adminApiGet, adminApiPost, adminApiPut } from "../api";

/** The refresh tick's per-run summary — the JSON line the paced-drain cron reads. */
export type FrontierRefreshSummary = {
  budgetPaused: boolean;
  building: number;
  editionOnly: number;
  failed: number;
  minted: number;
  ok: true;
  refreshed: number;
  skipped: number;
  switchOff: boolean;
  total: number;
  unchanged: number;
};

/**
 * One tick of the Frontier refresh sweep. `fluncle admin frontier refresh [--limit <n>]`.
 *
 * Writes the next edition for up to `limit` committed users (edition- or playlist-holders)
 * from their owners' current recommendations. The edition is written regardless of the
 * DEFAULT-DENY kill switch; a closed switch returns `switchOff: true` and skips only the
 * Spotify mirror (the edition writes count as `editionOnly`). Best-effort per user.
 */
export async function frontierRefreshCommand(options: {
  limit?: string;
}): Promise<FrontierRefreshSummary> {
  const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined;

  return adminApiPost<FrontierRefreshSummary>(
    "/api/admin/frontier-playlists/refresh",
    limit ? { limit } : {},
  );
}

/** The kill switch's state as both switch ops return it. */
export type FrontierMintingState = { ok: true; open: boolean };

/** `fluncle admin frontier status` — read the kill switch (agent-allowed). */
export async function frontierStatusCommand(): Promise<FrontierMintingState> {
  return adminApiGet<FrontierMintingState>("/api/admin/frontier/minting");
}

/** `fluncle admin frontier open|close` — flip the kill switch (operator only). */
export async function frontierSetMintingCommand(open: boolean): Promise<FrontierMintingState> {
  return adminApiPut<FrontierMintingState>("/api/admin/frontier/minting", { open });
}
