// THE VERIFIED WORKING SURFACE — the door behind the gate, laid out as THE PLAYLIST
// BUILDER (Spotify's own playlist-edit grammar, in Fluncle's register): the playlist
// panel on the left (the header — collage, name, the CTA — over the numbered tracklist
// being assembled, with the search between them) and the shelf on the right.
//
// TWO PHASES, off the editions ledger (frontier-shelf-from-editions-rfc.md D2/D3). The
// `["rec-editions"]` query is the phase signal — the SAME key the masthead dropdown reads,
// so a mint that writes the first edition flips the door draft → committed via one
// invalidation:
//
//   - DRAFT (no edition yet): the RecommendedPanel renders the LIVE engine output
//     (`["recommendations"]`, enabled only here). This is the one bounded cohort where a
//     live per-seed recompute is the desired behaviour, and it is rate-limited server-side.
//   - COMMITTED (≥1 edition): the EditionShelf renders the LATEST frozen edition
//     (`["rec-latest-edition"]`, enabled only here) — a stored read, no engine, no vector
//     math. A seed change never rewrites the frozen edition; the shelf just recomputes its
//     quiet staleness nudge.
//
// The mint gesture is lifted into `useFrontierMint` and handed to the panel; the two
// CSRF-guarded seed mutations both panels lean on live here. A seed write invalidates the
// picks always, and the live recommendations ONLY in the draft phase — a frozen edition is
// never rewritten on a seed edit.

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

  // The phase signal — SAME key as the masthead dropdown. Seeded from the loader and never
  // focus-refetched (a public surface); the mint invalidates it to flip draft → committed.
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

  // The live engine — DRAFT only. Enabled off the phase so a committed page view never runs
  // the scan. The staleTime keeps react-query from re-running the engine on mount for the
  // exact result the loader already computed (freshness rides the seed-write invalidation).
  const recsQuery = useQuery({
    enabled: phase === "draft",
    initialData: initialRecommendations,
    queryFn: loadRecommendations,
    queryKey: ["recommendations"],
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });

  // The latest frozen edition — COMMITTED only, seeded from the loader. A stored read; the
  // engine is never touched.
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
        // The picks always refresh. The live recommendations refresh ONLY in the draft phase
        // — a frozen edition is never rewritten on a seed edit; its staleness recomputes
        // reactively from the fresh picks against the frozen edition.
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
