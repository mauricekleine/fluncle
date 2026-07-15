import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { TrackArtwork } from "@/components/track-artwork";
import { TrackChips } from "@/components/track-row";
import { formatKey, type KeyNotation } from "@/lib/key-notation";
import { albumCoverAtSize } from "@/lib/media";
import { usePreviewPlayer, usePreviewProgress } from "@/lib/preview-player";

// THE FINDING CARD — what Fluncle FOUND, rendered (ChatDnB Phase 1).
//
// When a chat tool returns a finding, the workbench shows a real card instead of a raw JSON
// marker: the cover, the `Artist — Title` line, the Log ID coordinate linking to its log page,
// the enrichment chips (duration/BPM/key), the galaxy as quiet text, and — when the finding has
// a preview — an inline play control over the artwork wired to the shared preview singleton. It
// is quiet, dark, and restrained: an admin station, not a streaming-app clone (PRODUCT.md). It
// mirrors the TrackRow visual language (the same artwork, chips, and log-id idioms) so ChatDnB
// reads like the rest of the archive, one component closer to the conversation.

/**
 * The finding shape as the chat tools emit it — every field OPTIONAL because the tool outputs
 * ride through `dropEmpty` (a `Partial`) and a search hit the hydrator missed carries only the
 * lean subset. The card treats every field as maybe-absent. There is deliberately NO `previewUrl`
 * here: the expiring Deezer token never leaves the server; `hasPreview` + `coordinate` are all the
 * card needs, because playback goes through the live `/api/preview/<logId>` relay.
 */
export type ChatFinding = {
  album?: string;
  albumImageUrl?: string;
  artists?: string[];
  bpm?: number;
  coordinate?: string;
  durationMs?: number;
  found?: string;
  galaxy?: string;
  hasPreview?: boolean;
  key?: string;
  label?: string;
  note?: string;
  spotifyUrl?: string;
  title?: string;
};

/** The gold progress hairline — only mounted (so only subscribed) while THIS card is playing. */
function ProgressHairline() {
  const { currentTime, duration } = usePreviewProgress();
  const fraction = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  return (
    <div aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-muted">
      <div
        className="h-full origin-left bg-primary transition-transform duration-200 ease-linear motion-reduce:transition-none"
        style={{ transform: `scaleX(${fraction})` }}
      />
    </div>
  );
}

export function FindingCard({
  embedded = false,
  finding,
  notation,
}: {
  /** Drop the card's own pane (border/bg/rounding/padding) so it sits FLAT inside a parent
      container — the chain card's seed, where the outer container is the single pane (One Pane
      Rule, DESIGN.md §4). Standalone (the default) keeps its own card chrome. */
  embedded?: boolean;
  finding: ChatFinding;
  notation: KeyNotation;
}) {
  const logId = finding.coordinate;
  const title = finding.title ?? "";
  const artists = finding.artists ?? [];
  const trackLine = artists.length > 0 ? `${artists.join(", ")} — ${title}` : title;
  const keyText = formatKey(finding.key, notation);
  const coverSrc = albumCoverAtSize(finding.albumImageUrl, "small");

  // The play control needs both a preview and a coordinate (the relay is keyed by logId). The
  // hook is called unconditionally with a stable key ("" never matches an active track) so hooks
  // stay unconditional even when this finding is not playable.
  const playable = Boolean(finding.hasPreview && logId);
  const { isActive, isLoading, toggle } = usePreviewPlayer(logId ?? "");

  const artwork = <TrackArtwork alt={`${trackLine} cover art`} src={coverSrc} />;

  return (
    <div
      className={
        embedded
          ? "relative flex items-start gap-3 overflow-hidden"
          : "relative flex items-start gap-3 overflow-hidden rounded-md border border-border bg-card px-3 py-2.5"
      }
    >
      {playable && isActive ? <ProgressHairline /> : null}

      {playable ? (
        <button
          aria-label={`${isActive ? "Pause" : "Play"} preview: ${trackLine}`}
          aria-pressed={isActive}
          className="track-play shrink-0"
          onClick={toggle}
          type="button"
        >
          {artwork}
          <span aria-hidden="true" className="track-play-glyph">
            {isActive && !isLoading ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
          </span>
        </button>
      ) : (
        <span className="shrink-0">{artwork}</span>
      )}

      <div className="min-w-0 flex-1">
        {/* The ratified title register (.track-title, DESIGN.md §3): the music is the loudest
            text on the card, same as every TrackRow — never a quiet caption. */}
        <p className="track-title">{trackLine}</p>
        {/* The two lore items ride one line: the Log ID coordinate and its galaxy, a quiet
            middot between them. The galaxy is the coordinate's suffix — same waypoint, said
            twice — so they read as one place, not two stray captions. */}
        {logId || finding.galaxy ? (
          <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5">
            {logId ? (
              <Link
                aria-label={`Open the log page for ${trackLine}`}
                className="track-log-id track-log-id-link shrink-0"
                params={{ logId }}
                to="/log/$logId"
              >
                {logId}
              </Link>
            ) : null}
            {logId && finding.galaxy ? (
              <span aria-hidden="true" className="text-xs text-muted-foreground">
                ·
              </span>
            ) : null}
            {finding.galaxy ? (
              <span className="truncate text-xs text-muted-foreground">{finding.galaxy}</span>
            ) : null}
          </div>
        ) : null}
        <TrackChips
          bpm={finding.bpm}
          durationMs={finding.durationMs}
          musicalKey={keyText || undefined}
        />
      </div>
    </div>
  );
}
