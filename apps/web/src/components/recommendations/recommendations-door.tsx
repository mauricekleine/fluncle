// THE VERIFIED WORKING SURFACE — the door behind the gate. It owns the two loader-seeded
// react-query reads (the seed set + the computed recommendations, the account-door hybrid:
// SSR real content on first paint, refetchable after a write) and the two CSRF-guarded seed
// mutations, then lays out the three legs: the picker, the playlist leg, and the register-split
// list. With zero seeds the picker IS the page — the conversion moment — so the leg and the
// list stay hidden until Fluncle has something to steer by.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { FrontierLeg } from "./frontier-leg";
import { RecommendationList } from "./recommendation-list";
import { SeedPicker } from "./seed-picker";
import { type RecommendationsResult, type RecSeedItem, seedMutationMessage } from "./shared";

export function RecommendationsDoor({
  csrfToken,
  initialRecommendations,
  initialSeeds,
  loadRecommendations,
  loadSeeds,
}: {
  csrfToken: string;
  initialRecommendations: RecommendationsResult;
  initialSeeds: RecSeedItem[];
  loadRecommendations: () => Promise<RecommendationsResult>;
  loadSeeds: () => Promise<RecSeedItem[]>;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");

  // The seed set and the computed recommendations, each seeded from the loader (SSR) and never
  // refetched on focus — this is a public surface, not the admin board (focus-refetch would
  // also burn the recommendations' hourly budget). A seed write invalidates BOTH: new seeds
  // mean new recommendations.
  const seedsQuery = useQuery({
    initialData: initialSeeds,
    queryFn: loadSeeds,
    queryKey: ["rec-seeds"],
    refetchOnWindowFocus: false,
  });

  const recsQuery = useQuery({
    initialData: initialRecommendations,
    queryFn: loadRecommendations,
    queryKey: ["recommendations"],
    refetchOnWindowFocus: false,
  });

  const seeds = seedsQuery.data;
  const recs = recsQuery.data;

  const seedMutation = useMutation({
    mutationFn: async (op: { kind: "add" | "remove"; trackId: string }) => {
      const response =
        op.kind === "add"
          ? await fetch("/api/me/rec-seeds", {
              body: JSON.stringify({ trackId: op.trackId }),
              headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
              method: "POST",
            })
          : await fetch(`/api/me/rec-seeds/${encodeURIComponent(op.trackId)}`, {
              headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
              method: "DELETE",
            });

      if (response.status === 401) {
        window.location.href = "/account";

        return;
      }

      const body = await response.json().catch(() => undefined);

      setMessage(seedMutationMessage({ body, ok: response.ok, status: response.status }));

      if (response.ok) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["rec-seeds"] }),
          queryClient.invalidateQueries({ queryKey: ["recommendations"] }),
        ]);
      }
    },
  });

  return (
    <div className="rec-door">
      <SeedPicker
        message={message}
        onAdd={(trackId) => seedMutation.mutateAsync({ kind: "add", trackId })}
        onRemove={(trackId) => seedMutation.mutateAsync({ kind: "remove", trackId })}
        seeds={seeds}
      />

      {seeds.length > 0 ? (
        <>
          <FrontierLeg csrfToken={csrfToken} />
          <RecommendationList
            catalogue={recs.catalogue}
            findings={recs.findings}
            seedsSkipped={recs.seedsSkipped}
          />
        </>
      ) : null}
    </div>
  );
}
