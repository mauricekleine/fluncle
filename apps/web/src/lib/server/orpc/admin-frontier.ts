import { adminAuth, operatorGuard } from "../orpc-auth";
import {
  FRONTIER_REFRESH_BATCH,
  isFrontierMintingOpen,
  refreshAllFrontierPlaylists,
  setFrontierMintingOpen,
} from "../frontier-playlist";
import { type Implementer, toFault } from "./_shared";

const DEFAULT_COVER_LIMIT = 50;

export function adminFrontierHandlers(os: Implementer) {
  const refresh = os.refresh_frontier_playlists.use(adminAuth).handler(async ({ input }) => {
    try {
      return await refreshAllFrontierPlaylists(input.limit ?? FRONTIER_REFRESH_BATCH);
    } catch (error) {
      throw toFault(error);
    }
  });

  const getMinting = os.get_frontier_minting.use(adminAuth).handler(async () => {
    try {
      return { ok: true as const, open: await isFrontierMintingOpen() };
    } catch (error) {
      throw toFault(error);
    }
  });

  const setMinting = os.set_frontier_minting
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        await setFrontierMintingOpen(input.open);

        return { ok: true as const, open: await isFrontierMintingOpen() };
      } catch (error) {
        throw toFault(error);
      }
    });

  const uploadCovers = os.upload_frontier_covers.use(adminAuth).handler(async ({ input }) => {
    try {
      const { uploadFrontierCovers } = await import("../frontier-cover");

      return await uploadFrontierCovers(input.limit ?? DEFAULT_COVER_LIMIT);
    } catch (error) {
      throw toFault(error);
    }
  });

  return {
    get_frontier_minting: getMinting,
    refresh_frontier_playlists: refresh,
    set_frontier_minting: setMinting,
    upload_frontier_covers: uploadCovers,
  };
}
