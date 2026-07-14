import { Link } from "@tanstack/react-router";
import { TrackArtwork } from "@/components/track-artwork";
import { bangersCount, formatAlbumDuration } from "@/lib/format";
import { mixtapeCoverUrl } from "@/lib/mixtapes";

// THE MIXTAPE CARD — Fluncle dreaming, a checkpoint, rendered (ChatDnB Phase 4).
//
// When get_track resolves an F-coordinate to a mixtape, the workbench shows a real card instead
// of a raw JSON marker. A mixtape is a SPINE object, not a finding — a checkpoint in the Findings,
// reached by its F-Log-ID — so this card is deliberately quieter than the Finding Card: the cover
// (rendered on the fly from the coordinate, degrading to the eclipse-gradient fallback), the title
// in the loud register, the count of bangers and the runtime as one quiet line, the note if it
// carries one, and the coordinate linking to its /log page — the SAME coordinate-link idiom the
// Finding Card wears, because a mixtape is a log entry too. There is NO play control: a mixtape has
// no 30s preview here. It shares the sibling cards' container rhythm so a mixed transcript reads as
// one system.

/** The mixtape shape get_track emits — every field optional (the tool output rides `dropEmpty`). */
export type ChatMixtape = {
  bangerCount?: number;
  /** The mixtape's F-Log-ID (019.F.1A); the cover + the /log link both derive from it. */
  coordinate?: string;
  note?: string;
  runtimeMs?: number;
  title?: string;
};

export function MixtapeCard({ mixtape }: { mixtape: ChatMixtape }) {
  const logId = mixtape.coordinate;
  // A mixtape always carries a title, but fall back to the coordinate so the alt text and the
  // link's aria-label never degrade to a bare " cover art" / "Open the log page for " if it is empty.
  const title = mixtape.title ?? "";
  const label = title || logId || "this mixtape";
  // The cover is derived from the coordinate, never carried on the output — `thumb` is the
  // right-sized rendition every small mixtape row uses (the feed, /mixtapes, /admin), not the
  // 1500² `square` master. No coordinate → the eclipse-gradient TrackArtwork fallback.
  const coverSrc = logId ? mixtapeCoverUrl(logId, "thumb") : undefined;

  const meta = [
    mixtape.bangerCount === undefined ? undefined : bangersCount(mixtape.bangerCount),
    mixtape.runtimeMs === undefined ? undefined : formatAlbumDuration(mixtape.runtimeMs),
  ].filter((part): part is string => Boolean(part));

  return (
    <div className="flex items-start gap-3 rounded-md border border-border bg-card px-3 py-2.5">
      <span className="shrink-0">
        <TrackArtwork alt={`${label} cover art`} src={coverSrc} />
      </span>

      <div className="min-w-0 flex-1">
        {/* The ratified loud register (.track-title, DESIGN.md §3), same as the sibling cards —
            the mixtape's title is the loudest text on the card, never a quiet caption. */}
        <p className="track-title">{title}</p>
        {logId ? (
          <Link
            aria-label={`Open the log page for ${label}`}
            className="track-log-id track-log-id-link mt-0.5 inline-block"
            params={{ logId }}
            to="/log/$logId"
          >
            {logId}
          </Link>
        ) : null}
        {meta.length > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">{meta.join(" · ")}</p>
        ) : null}
        {mixtape.note ? (
          <p className="mt-1 truncate text-xs text-muted-foreground">{mixtape.note}</p>
        ) : null}
      </div>
    </div>
  );
}
