import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { authClient } from "@/lib/auth-client";
import { forgetSyncedTracks } from "@/lib/saved-tracks";
import { mergeOnSignIn, setSavedTracksUser } from "@/lib/saved-tracks-sync";

export function SavedTracksSync(): null {
  const { data, error, isPending } = authClient.useSession();
  const queryClient = useQueryClient();
  const userId = data?.user.id;
  const signedOut = !isPending && !error && !data;

  useEffect(() => {
    if (userId) {
      setSavedTracksUser(userId);

      let current = true;
      const refreshAccount = () => {
        if (current) {
          void queryClient.invalidateQueries({ queryKey: ["account"] });
        }
      };

      void mergeOnSignIn(userId, fetch, { onBatch: refreshAccount }).then((result) => {
        if (result.outcome === "merged") {
          refreshAccount();
        }
      });

      return () => {
        current = false;
      };
    }

    if (signedOut) {
      setSavedTracksUser(undefined);
      forgetSyncedTracks();
    }

    return undefined;
  }, [queryClient, signedOut, userId]);

  return null;
}
