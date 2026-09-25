import { setLiveState } from "../live";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

export function adminTwitchHandlers(os: Implementer) {
  const recordLiveStateHandler = os.record_live_state.use(adminAuth).handler(async ({ input }) => {
    try {
      await setLiveState({
        at: input.at,
        live: input.live,
        startedAt: input.startedAt,
        title: input.title,
      });

      return { ok: true as const };
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    record_live_state: recordLiveStateHandler,
  };
}
