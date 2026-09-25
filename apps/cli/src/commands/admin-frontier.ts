import { adminApiGet, adminApiPost, adminApiPut } from "../api";

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

export async function frontierRefreshCommand(options: {
  limit?: string;
}): Promise<FrontierRefreshSummary> {
  const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined;

  return adminApiPost<FrontierRefreshSummary>(
    "/api/v1/admin/frontier-playlists/refresh",
    limit ? { limit } : {},
  );
}

export type FrontierMintingState = { ok: true; open: boolean };

export async function frontierStatusCommand(): Promise<FrontierMintingState> {
  return adminApiGet<FrontierMintingState>("/api/v1/admin/frontier/minting");
}

export async function frontierSetMintingCommand(open: boolean): Promise<FrontierMintingState> {
  return adminApiPut<FrontierMintingState>("/api/v1/admin/frontier/minting", { open });
}
