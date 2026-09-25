import { BookmarkSimpleIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@fluncle/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@fluncle/ui/components/dialog";
import { SpotifyIcon } from "@/components/platform-icons";
import { formatDateLong } from "@/lib/format";
import { type KeyNotation, useKeyNotation } from "@/lib/key-notation";
import { cn } from "@/lib/utils";
import { RecCover, RecSeal, TrackReadout } from "./rec-rows";
import {
  type FrontierEditionDetail,
  type FrontierEditionSummary,
  type FrontierEditionTrack,
  savedFindingBody,
} from "./shared";

export function EditionDialog({
  csrfToken,
  loadEdition,
  onClose,
  summary,
}: {
  csrfToken: string;
  loadEdition: (number: number) => Promise<FrontierEditionDetail | null>;
  onClose: () => void;
  summary: FrontierEditionSummary | null;
}) {
  if (summary === null) {
    return null;
  }

  return (
    <EditionDialogInner
      csrfToken={csrfToken}
      loadEdition={loadEdition}
      onClose={onClose}
      summary={summary}
    />
  );
}

function EditionDialogInner({
  csrfToken,
  loadEdition,
  onClose,
  summary,
}: {
  csrfToken: string;
  loadEdition: (number: number) => Promise<FrontierEditionDetail | null>;
  onClose: () => void;
  summary: FrontierEditionSummary;
}) {
  const { notation } = useKeyNotation();
  const dateLabel = formatDateLong(summary.refreshedAt);

  const editionQuery = useQuery({
    queryFn: () => loadEdition(summary.number),
    queryKey: ["rec-edition", summary.number],
    staleTime: Number.POSITIVE_INFINITY,
  });

  const detail = editionQuery.data;

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <p className="rec-edition-eyebrow">Fluncle&rsquo;s Frontier</p>
          <DialogTitle>{dateLabel}</DialogTitle>
          <DialogDescription>
            {summary.trackCount} {summary.trackCount === 1 ? "track" : "tracks"}
          </DialogDescription>
        </DialogHeader>

        {editionQuery.isPending ? (
          <EditionLoading />
        ) : editionQuery.isError || !detail ? (
          <p className="rec-muted">Could not pull that edition. Try again in a moment.</p>
        ) : detail.tracks.length === 0 ? (
          <p className="rec-muted">Nothing in this one.</p>
        ) : (
          <ol className="rec-shelf">
            {detail.tracks.map((track) => (
              <EditionRow
                csrfToken={csrfToken}
                key={track.trackId}
                notation={notation}
                track={track}
              />
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditionLoading() {
  return (
    <div className="rec-recommended-ghost">
      <ol aria-hidden className="rec-shelf">
        {[0, 1, 2, 3, 4].map((row) => (
          <li className="rec-ghost-row" key={row}>
            <span className="rec-ghost-cover" />
            <span className="rec-ghost-lines">
              <span className="rec-ghost-line" />
              <span className="rec-ghost-line rec-ghost-line--short" />
            </span>
          </li>
        ))}
      </ol>
      <p className="rec-muted">Digging…</p>
    </div>
  );
}

function EditionRow({
  csrfToken,
  notation,
  track,
}: {
  csrfToken: string;
  notation: KeyNotation;
  track: FrontierEditionTrack;
}) {
  const trackLine = `${track.artists.join(", ")} — ${track.title}`;

  return (
    <li className={cn("rec-row", track.slot === "catalogue" && "rec-row--unlit")}>
      <RecCover url={track.imageUrl} />

      <span className="rec-row-body min-w-0">
        <span className="rec-row-title">{trackLine}</span>
        <span className="rec-row-chips">
          {track.logId ? <RecSeal logId={track.logId} trackLine={trackLine} /> : null}
          <TrackReadout
            bpm={track.bpm}
            durationMs={track.durationMs}
            musicalKey={track.key}
            notation={notation}
          />
        </span>
      </span>

      <span className="rec-edition-actions">
        {track.spotifyUrl ? (
          <Button
            aria-label={`Listen on Spotify: ${trackLine}`}
            nativeButton={false}
            // oxlint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- Base UI's render prop merges the Button's aria-label onto this anchor.
            render={<a href={track.spotifyUrl} rel="noopener noreferrer" target="_blank" />}
            size="icon"
            variant="ghost"
          >
            <SpotifyIcon />
          </Button>
        ) : null}
        <SaveControl
          csrfToken={csrfToken}
          logId={track.logId}
          trackId={track.trackId}
          trackLine={trackLine}
        />
      </span>
    </li>
  );
}

function SaveControl({
  csrfToken,
  logId,
  trackId,
  trackLine,
}: {
  csrfToken: string;
  logId?: string;
  trackId: string;
  trackLine: string;
}) {
  const save = useMutation({
    mutationFn: async (): Promise<"error" | "saved"> => {
      const response = await fetch("/api/v1/me/saved-findings", {
        body: JSON.stringify(savedFindingBody({ logId, trackId })),
        headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
        method: "POST",
      });

      if (response.status === 401) {
        window.location.href = "/account";

        return "error";
      }

      return response.ok ? "saved" : "error";
    },
  });

  const saved = save.data === "saved";

  return (
    <Button
      aria-label={saved ? `Saved ${trackLine}` : `Save ${trackLine}`}
      disabled={save.isPending || saved}
      onClick={() => save.mutate()}
      size="icon"
      type="button"
      variant="ghost"
    >
      {save.isPending ? (
        <CircleNotchIcon
          aria-hidden="true"
          className="animate-spin motion-reduce:animate-none"
          weight="bold"
        />
      ) : saved ? (
        <BookmarkSimpleIcon aria-hidden="true" weight="fill" />
      ) : (
        <BookmarkSimpleIcon aria-hidden="true" weight="bold" />
      )}
    </Button>
  );
}
