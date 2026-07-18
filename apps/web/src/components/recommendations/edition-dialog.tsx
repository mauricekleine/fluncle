// THE EDITION DIALOG — one past edition of Fluncle's Frontier, opened from the dropdown.
// The date carries the identity (a frozen edition must never read as the LIVE playlist, so
// "Fluncle's Frontier" quiets to a context eyebrow and the edition's date leads the header).
// Under it, the frozen tracklist: the SAME register split the live Recommended shelf wears
// (the Unlit Rule) — a finding wears its gold seal (the coordinate pill → /log/<id>) and
// catches the gold veil, a catalogue cut stays unlit, unnamed, no Log ID. Every row carries
// two gestures: open the track in Spotify, and save it into your own Fluncle list (the
// generalized save — a catalogue row with no coordinate saves just the same).
//
// The tracklist lazy-loads on open (a frozen edition never changes, so staleTime is
// Infinity); the header renders instantly off the summary the dropdown already carried, so
// the dialog names its date before the rows arrive.

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

/**
 * The dialog, controlled by the parent's `openNumber` state through the resolved `summary`
 * (`null` = nothing selected). It returns `null` when closed so the inner component sees a
 * non-null summary and its number narrows to a value — no non-null assertion, the query key
 * and the header both read a real edition.
 */
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

  // A frozen edition never changes, so once pulled it never goes stale (staleTime Infinity).
  // The query only exists while the dialog is open — the inner component unmounts on close.
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

/** The loading shelf — the Recommended panel's ghost-row grammar, one quiet line under it. */
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

/**
 * One frozen row. The register rides the LIGHT, never the layout (the Unlit Rule): a finding
 * carries its `log_id`, so it wears the gold seal and catches the gold veil; a catalogue cut
 * has no coordinate, so it stays unlit and unnamed. Two gestures on the tail — open in
 * Spotify, and save into your own list (the generalized save works for either register).
 */
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
            aria-label={`Open ${trackLine} in Spotify`}
            nativeButton={false}
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

/**
 * The Save gesture — files the row's track into the reader's own Fluncle list through the
 * generalized save (Unit E: any track saves, a finding stores its `log_id`, a catalogue cut
 * stores nothing). Reuses the door's CSRF-guarded mutation grammar and its 401 redirect. It
 * flips to a filled mark once saved and lies still; a failure leaves it clickable to retry.
 */
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
      const response = await fetch("/api/me/saved-findings", {
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
