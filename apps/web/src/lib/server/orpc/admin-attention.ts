import { deriveAttentionDigest } from "../../attention";
import { readAttentionSnapshot } from "../attention";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

export function adminAttentionHandlers(os: Implementer) {
  const getAttentionHandler = os.get_attention.use(adminAuth).handler(async () => {
    try {
      const now = Date.now();
      const snapshot = await readAttentionSnapshot(now);

      return {
        attention: {
          ...deriveAttentionDigest(snapshot.items, now),
          renderQueueDepth: snapshot.renderQueueDepth,
        },
        ok: true as const,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    get_attention: getAttentionHandler,
  };
}
