// THE ONE MINT GESTURE — "Get playlist", the draft → first-edition commitment (the ONLY
// user-triggered engine run; the other trigger is the Friday sweep). Lifted out of the
// playlist panel so the door owns it once and hands the result down: a single fetch, folded
// through `foldFrontierMint`, its toast set from `mintToastMessage`, and — on success — the
// three keys the flip depends on invalidated (the editions list + the latest edition flip the
// door draft → committed; the frontier status picks up a fresh playlist URL).

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { foldFrontierMint, mintToastMessage } from "./shared";

const FRONTIER_PATH = "/api/me/frontier-playlist";

/** What the door hands the panel: the one gesture, its pending flag, and its toast line. */
export type FrontierMint = {
  isPending: boolean;
  message: string;
  run: () => void;
};

export function useFrontierMint({ csrfToken }: { csrfToken: string }): FrontierMint {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(FRONTIER_PATH, {
        // The mint takes no parameters, but the op's input schema still expects an OBJECT —
        // a bodyless POST parses to undefined and 400s (invalid_request).
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
        method: "POST",
      });

      if (response.status === 401) {
        window.location.href = "/account";

        return { kind: "closed" as const };
      }

      const body = await response.json().catch(() => undefined);

      return foldFrontierMint({ body, ok: response.ok, status: response.status });
    },
    onSuccess: (result) => {
      // A `closed` fold means the mint endpoint 404'd (an unexpected state now that the op has
      // shipped). It is kept as a defensive kind, but a click must never land in silence — give
      // it the same plain, non-blaming line the error fold uses.
      if (result.kind === "closed") {
        setMessage("Could not get your playlist. Try again in a moment.");

        return;
      }

      if (result.kind === "error") {
        setMessage(result.message);

        return;
      }

      setMessage(mintToastMessage(result.status));

      // The commitment writes the first edition (or refreshes a synced one). Flip the door
      // draft → committed and pick up any fresh playlist URL: the editions list + the latest
      // edition are the phase signal (SAME keys the masthead dropdown and the shelf read), the
      // frontier status carries the Spotify side.
      void queryClient.invalidateQueries({ queryKey: ["rec-editions"] });
      void queryClient.invalidateQueries({ queryKey: ["rec-latest-edition"] });
      void queryClient.invalidateQueries({ queryKey: ["frontier"] });
    },
  });

  return {
    isPending: mutation.isPending,
    message,
    run: () => mutation.mutate(),
  };
}
