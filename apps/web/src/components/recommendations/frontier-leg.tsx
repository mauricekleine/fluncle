// THE PLAYLIST LEG — "Mint my playlist." Fluncle mints the recommendations into a durable,
// shareable artifact: a playlist on his own Spotify, refreshed weekly. This leg is coded
// against the PARALLEL agent's exact interface and folds a 404 gracefully, so it ships whether
// or not that endpoint has merged:
//
//   GET  /me/frontier-playlist → { ok, playlistUrl?, lastSyncedAt?, mintingOpen }
//   POST /me/frontier-playlist → { ok, status: minted|refreshed|unchanged|switch_off, playlistUrl? }
//
// Closed (404 or switch_off): the button goes disabled-quiet under "Playlists open soon. Your
// picks are saved." Open: "Mint my playlist" posts. With a URL: the lead banner reads
// "Fluncle's Frontier · refreshed <date> · Open in Spotify" and the button re-mints (refresh).

import { ArrowSquareOutIcon, SparkleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { formatDateLong } from "@/lib/format";
import {
  foldFrontierMint,
  foldFrontierStatus,
  FRONTIER_CLOSED,
  type FrontierState,
} from "./shared";

const FRONTIER_PATH = "/api/me/frontier-playlist";

async function readFrontier(): Promise<FrontierState> {
  const response = await fetch(FRONTIER_PATH);
  const body = await response.json().catch(() => undefined);

  return foldFrontierStatus({ body, ok: response.ok, status: response.status });
}

export function FrontierLeg({ csrfToken }: { csrfToken: string }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");

  // A secondary, on-demand panel the loader does not carry, so it rides its own UNSEEDED
  // query (the account convention allows this for data the loader never returned). Never
  // refetches on focus — the playlist doesn't change under the reader's feet mid-session.
  const statusQuery = useQuery({
    queryFn: readFrontier,
    queryKey: ["frontier"],
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  const state = statusQuery.data ?? FRONTIER_CLOSED;

  const mint = useMutation({
    mutationFn: async () => {
      const response = await fetch(FRONTIER_PATH, {
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
        setMessage("");
        queryClient.setQueryData<FrontierState>(["frontier"], FRONTIER_CLOSED);

        return;
      }

      if (result.kind === "error") {
        setMessage(result.message);

        return;
      }

      setMessage(MINT_MESSAGE[result.status]);
      void queryClient.invalidateQueries({ queryKey: ["frontier"] });
    },
  });

  const busy = mint.isPending;

  return (
    <section className="account-section rec-frontier">
      {state.playlistUrl ? (
        <a
          aria-label="Open Fluncle's Frontier playlist on Spotify"
          className="rec-frontier-lead"
          href={state.playlistUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          <span className="rec-frontier-name">Fluncle&rsquo;s Frontier</span>
          {state.lastSyncedAt ? (
            <span className="rec-frontier-synced">
              refreshed {formatDateLong(state.lastSyncedAt)}
            </span>
          ) : null}
          <span className="rec-frontier-open">
            Open in Spotify
            <ArrowSquareOutIcon aria-hidden="true" className="size-4" />
          </span>
        </a>
      ) : null}

      {state.mintingOpen ? (
        <div className="rec-frontier-action">
          <Button
            disabled={busy}
            onClick={() => mint.mutate()}
            size="lg"
            type="button"
            variant="outline"
          >
            <SparkleIcon aria-hidden="true" weight="bold" />
            {state.playlistUrl ? "Refresh my playlist" : "Mint my playlist"}
          </Button>
          {!state.playlistUrl ? (
            <p className="account-muted">
              Fluncle mints your picks into a playlist on Spotify and freshens it every week.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="rec-frontier-action">
          <Button disabled size="lg" type="button" variant="outline">
            <SparkleIcon aria-hidden="true" weight="bold" />
            Mint my playlist
          </Button>
          <p className="account-muted">Playlists open soon. Your picks are saved.</p>
        </div>
      )}

      {message ? (
        <p aria-live="polite" className="rec-message">
          {message}
        </p>
      ) : null}
    </section>
  );
}

const MINT_MESSAGE: Record<"minted" | "refreshed" | "unchanged", string> = {
  minted: "Minted. It's on your Spotify.",
  refreshed: "Refreshed with your latest picks.",
  unchanged: "Already up to date.",
};
