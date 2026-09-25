import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { foldFrontierMint, mintToastMessage } from "./shared";

const FRONTIER_PATH = "/api/v1/me/frontier-playlist";

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
      if (result.kind === "closed") {
        setMessage("Could not get your playlist. Try again in a moment.");

        return;
      }

      if (result.kind === "error") {
        setMessage(result.message);

        return;
      }

      setMessage(mintToastMessage(result.status));

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
