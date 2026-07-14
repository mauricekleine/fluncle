import { ArrowRightIcon, PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ChatFinding, FindingCard } from "@/components/chat/finding-card";
import { TrackArtwork } from "@/components/track-artwork";
import { formatKey, type KeyNotation } from "@/lib/key-notation";
import { albumCoverAtSize } from "@/lib/media";
import { usePreviewPlayer } from "@/lib/preview-player";
import { Badge } from "@fluncle/ui/components/badge";

// THE CHAIN CARD — ChatDnB builds a set that mixes (ChatDnB Phase 3).
//
// When `build_set` chains a mixable set off a seed finding, the workbench renders it as a real
// card instead of a raw JSON marker: the SEED as a full Finding Card under a quiet "start here"
// label, then a NUMBERED mini-chain of what mixes in after it — each step a compact play row
// carrying the REASON it mixes as a quiet chip (the `mixReasonLabel` string, NEVER a number),
// and a footer that hands the whole ordered set to `/mix`. It mirrors the Finding Card's play +
// coordinate idioms so the chain reads like the rest of the archive, one step closer to a set.

/**
 * A chain step: a {@link ChatFinding} plus the human `reason` it mixes (the `mixReasonLabel`
 * string the tool already resolved). NO score — reasons are words. Every finding field stays
 * optional (the tool output rides through `dropEmpty`), and there is no `previewUrl` here, same
 * as the Finding Card: playback goes through the live `/api/preview/<logId>` relay.
 */
export type ChatStep = ChatFinding & { reason?: string };

/**
 * A mixable set as `build_set` emits it: the seed finding, the ordered steps that mix in after
 * it, the `/mix?set=…` handoff URL, and a `thin` flag the tool sets when the archive is too
 * sparse to chain from here (so the card says so in voice rather than showing an empty chain).
 */
export type ChatSet = {
  seed?: ChatFinding;
  setUrl?: string;
  steps?: ChatStep[];
  thin?: boolean;
};

export function ChainCard({ notation, set }: { notation: KeyNotation; set: ChatSet }) {
  const seed = set.seed;

  if (!seed) {
    return null;
  }

  const steps = set.steps ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <p className="px-1 text-xs text-muted-foreground">Start here</p>
        <FindingCard finding={seed} notation={notation} />
      </div>

      {steps.length > 0 ? (
        <ol className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <ChainStep
              key={step.coordinate ?? index}
              notation={notation}
              position={index + 1}
              step={step}
            />
          ))}
        </ol>
      ) : (
        <p className="px-1 text-sm text-muted-foreground">
          Not enough logged near this one yet to chain a set from it.
        </p>
      )}

      {set.setUrl && steps.length > 0 ? (
        <a
          aria-label="Open this set in the mixer"
          className="track-log-id-link inline-flex items-center gap-1 self-start px-1 text-xs text-muted-foreground"
          href={set.setUrl}
        >
          Open in /mix
          <ArrowRightIcon aria-hidden="true" weight="bold" />
        </a>
      ) : null}
    </div>
  );
}

// One step in the chain: a slim play row — the shared `.track-play` artwork idiom (lighter than a
// full Finding Card), the `Artist — Title` line, the coordinate link, and the reason chip. Its own
// component so the preview hook is called once per row, unconditionally.
function ChainStep({
  notation,
  position,
  step,
}: {
  notation: KeyNotation;
  position: number;
  step: ChatStep;
}) {
  const logId = step.coordinate;
  const title = step.title ?? "";
  const artists = step.artists ?? [];
  const trackLine = artists.length > 0 ? `${artists.join(", ")} — ${title}` : title;
  const keyText = formatKey(step.key, notation);
  const coverSrc = albumCoverAtSize(step.albumImageUrl, "small");

  // The play control needs both a preview and a coordinate (the relay is keyed by logId). The
  // hook is called unconditionally with a stable key ("" never matches an active track) so hooks
  // stay unconditional even when this step is not playable.
  const playable = Boolean(step.hasPreview && logId);
  const { isActive, isLoading, toggle } = usePreviewPlayer(logId ?? "");

  const artwork = <TrackArtwork alt={`${trackLine} cover art`} src={coverSrc} />;

  return (
    <li className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
      >
        {position}
      </span>

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
        <p className="track-title truncate">{trackLine}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          {logId ? (
            <Link
              aria-label={`Open the log page for ${trackLine}`}
              className="track-log-id track-log-id-link"
              params={{ logId }}
              to="/log/$logId"
            >
              {logId}
            </Link>
          ) : null}
          {step.reason ? <Badge variant="secondary">{step.reason}</Badge> : null}
          {keyText ? <span className="text-xs text-muted-foreground">{keyText}</span> : null}
        </div>
      </div>
    </li>
  );
}
