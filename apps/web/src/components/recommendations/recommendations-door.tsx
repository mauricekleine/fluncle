import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { EditionShelf } from "./edition-shelf";
import { PlaylistPanel } from "./playlist-panel";
import { RecommendedPanel } from "./recommended-panel";
import {
  type FrontierEditionDetail,
  type FrontierEditionSummary,
  isEditionStale,
  type RecommendationsResult,
  type RecSeedItem,
  seedMutationMessage,
} from "./shared";
import { useFrontierMint } from "./use-frontier-mint";

export function RecommendationsDoor({
  csrfToken,
  initialEditions,
  initialLatest,
  initialRecommendations,
  initialSeeds,
  loadEditions,
  loadLatestEdition,
  loadRecommendations,
  loadSeeds,
}: {
  csrfToken: string;
  initialEditions: FrontierEditionSummary[];
  initialLatest: FrontierEditionDetail | null;
  initialRecommendations: RecommendationsResult;
  initialSeeds: RecSeedItem[];
  loadEditions: () => Promise<FrontierEditionSummary[]>;
  loadLatestEdition: () => Promise<FrontierEditionDetail | null>;
  loadRecommendations: () => Promise<RecommendationsResult>;
  loadSeeds: () => Promise<RecSeedItem[]>;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");

  const editionsQuery = useQuery({
    initialData: initialEditions,
    queryFn: loadEditions,
    queryKey: ["rec-editions"],
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });

  const phase = editionsQuery.data.length > 0 ? "committed" : "draft";

  const seedsQuery = useQuery({
    initialData: initialSeeds,
    queryFn: loadSeeds,
    queryKey: ["rec-seeds"],
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });

  const recsQuery = useQuery({
    enabled: phase === "draft",
    initialData: initialRecommendations,
    queryFn: loadRecommendations,
    queryKey: ["recommendations"],
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });

  const latestQuery = useQuery({
    enabled: phase === "committed",
    initialData: initialLatest ?? undefined,
    queryFn: loadLatestEdition,
    queryKey: ["rec-latest-edition"],
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });

  const seeds = seedsQuery.data;
  const recs = recsQuery.data;
  const latest = latestQuery.data ?? null;

  const mint = useFrontierMint({ csrfToken });

  const seedMutation = useMutation({
    mutationFn: async (op: { kind: "add" | "remove"; trackId: string }) => {
      const response =
        op.kind === "add"
          ? await fetch("/api/v1/me/rec-seeds", {
              body: JSON.stringify({ trackId: op.trackId }),
              headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
              method: "POST",
            })
          : await fetch(`/api/v1/me/rec-seeds/${encodeURIComponent(op.trackId)}`, {
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
        const invalidations = [queryClient.invalidateQueries({ queryKey: ["rec-seeds"] })];

        if (phase === "draft") {
          invalidations.push(queryClient.invalidateQueries({ queryKey: ["recommendations"] }));
        }

        await Promise.all(invalidations);
      }
    },
  });

  const onAdd = (trackId: string) => seedMutation.mutateAsync({ kind: "add", trackId });
  const onRemove = (trackId: string) => seedMutation.mutateAsync({ kind: "remove", trackId });

  return (
    <div className="rec-build">
      <PlaylistPanel
        message={message}
        mint={mint}
        onAdd={onAdd}
        onRemove={onRemove}
        phase={phase}
        seeds={seeds}
      />
      {phase === "committed" ? (
        <EditionShelf
          latest={latest}
          onAdd={onAdd}
          onRemove={onRemove}
          seeds={seeds}
          stale={latest ? isEditionStale(latest, seeds) : false}
        />
      ) : (
        <RecommendedPanel
          catalogue={recs.catalogue}
          findings={recs.findings}
          onAdd={onAdd}
          onRemove={onRemove}
          seeds={seeds}
          seedsSkipped={recs.seedsSkipped}
        />
      )}
    </div>
  );
}
