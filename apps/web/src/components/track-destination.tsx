// THE ARCHIVE TRACK DESTINATION's bands — the page `/track/<trackId>` is made of.
//
// A CATALOGUE page in VOICE.md's Three Areas: the reference register, stating what the recording
// is, plainly. No nameplate, no first person, no narration — the same ground `/album/<slug>` and
// `/artist/<slug>` stand on. Fluncle appears here as DATA (the facts he holds) and never as a
// narrator, and nothing on the page introduces, names, counts, or otherwise gives a noun to the
// tier the recording belongs to, because that tier has no public name (docs/album-entity.md).
//
// ── EVERY BAND IS CONDITIONAL ─────────────────────────────────────────────────────────────────
// The load-bearing rule this file inherits from `graph-sections.tsx`: a band with nothing in it
// renders NOTHING — no heading, no empty state, no apology. A recording with no preview offers no
// play control, one with no outbound link offers no listen band, one with no embedding yet offers
// no neighbours. The page is then simply about what it actually has, which is the only way one
// component set serves both a fully-enriched record and a bare crawl row without either
// apologising for the half it does not carry.
//
// ── THE REGISTER OF THE NEIGHBOURS ────────────────────────────────────────────────────────────
// The "Close in sound" band mixes both registers, so it follows DESIGN.md's mixed-list rule
// exactly as `/tracks` does: a neighbour that carries a coordinate is LIT — its cover, its Log ID,
// a link to its `/log` page; one that does not is UNLIT — coverless, dust-inked, no gold at rest
// or on hover, linking to its own destination. The row's appearance is the whole distinction, and
// no word anywhere says which is which.

import { CaretRightIcon, PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { siApplemusic, siBeatport, siDeezer, siSpotify, siYoutube } from "simple-icons";
import { type SimpleIcon } from "simple-icons";
import { Button, buttonVariants } from "@fluncle/ui/components/button";
import { BrandIcon } from "@/components/brand-icon";
import { GraphLink } from "@/components/graph-link";
import { TrackArtwork } from "@/components/track-artwork";
import { formatDuration, formatReleaseDate } from "@/lib/format";
import { formatKey, useKeyNotation } from "@/lib/key-notation";
import { artistTitleLine } from "@/lib/log-prose";
import { albumCoverAtSize } from "@/lib/media";
import { usePreviewPlayer } from "@/lib/preview-player";
import { cn } from "@/lib/utils";
import {
  type ListenDestination,
  type SonicNeighbour,
  type TrackDestination,
} from "@/lib/server/track-page";

/**
 * The outbound controls, one per service the archive actually stores a link for. The labels are
 * the RATIFIED ones `/log` already uses ("Listen on Spotify", "Listen on Apple Music", "Watch on
 * YouTube") — one action, one label, across every surface (VOICE.md's Chrome Rule). Nothing here
 * is composed from a search term: a link is stored and exact, or it is absent.
 */
const LISTEN_META: Record<ListenDestination["kind"], { icon: SimpleIcon; label: string }> = {
  apple: { icon: siApplemusic, label: "Listen on Apple Music" },
  beatport: { icon: siBeatport, label: "Listen on Beatport" },
  deezer: { icon: siDeezer, label: "Listen on Deezer" },
  spotify: { icon: siSpotify, label: "Listen on Spotify" },
  youtube: { icon: siYoutube, label: "Watch on YouTube" },
};

/**
 * The BOUNDED PREVIEW. Fluncle serves no full song from this page, and cannot: the control plays
 * the `/api/preview` relay, which serves only the official short clip a rights-holding service
 * publishes (a stored Deezer URL, a fresh one by ISRC, then Apple's exact-by-ISRC clip, then the
 * keyless iTunes fallback) and never the captured full song, which is a private analysis artifact.
 *
 * The control is rendered only when the archive holds a short-source anchor at all. When the relay
 * still comes back empty — an expired token, a clip that has since gone — the shared player's own
 * `play()` rejection returns it to idle, so a dead preview stops rather than erroring, and the page
 * is otherwise untouched.
 */
export function TrackPreviewButton({ trackId }: { trackId: string }) {
  const preview = usePreviewPlayer(trackId);

  return (
    <Button aria-pressed={preview.isActive} onClick={preview.toggle} size="lg" variant="outline">
      {preview.isActive ? (
        <PauseIcon aria-hidden="true" weight="fill" />
      ) : (
        <PlayIcon aria-hidden="true" weight="fill" />
      )}
      {preview.isActive ? "Stop the preview" : "Play the preview"}
    </Button>
  );
}

/**
 * The listen band: the bounded preview first (it plays here), then every outbound destination the
 * archive holds. Renders nothing at all when there is neither — a page with nowhere to send you
 * says so by having no band, never by an empty control (criterion: a missing source degrades, it
 * does not error).
 */
export function TrackListenBand({ track }: { track: TrackDestination }) {
  if (!track.previewable && track.listen.length === 0) {
    return undefined;
  }

  return (
    <div className="log-actions">
      {track.previewable ? <TrackPreviewButton trackId={track.trackId} /> : undefined}
      {track.listen.map((destination, index) => {
        const meta = LISTEN_META[destination.kind];

        return (
          // A REAL ANCHOR wearing the button's look, via the shadcn button's own `buttonVariants`
          // export — the canonical way to give a link a button's appearance, and here it is a
          // correctness fix rather than a style choice. These controls NAVIGATE, to another site;
          // Base UI's `Button` with `nativeButton={false}` stamps `role="button"` on whatever it
          // renders, so an outbound listening destination would announce itself to a screen reader
          // as a button and answer to Space rather than Enter. The whole errand of this band is
          // "leave here and go hear it", and that is a link.
          <a
            className={cn(
              buttonVariants({
                size: "lg",
                variant: index === 0 && !track.previewable ? "default" : "outline",
              }),
            )}
            href={destination.href}
            key={destination.kind}
            rel="noreferrer"
            target="_blank"
          >
            <BrandIcon icon={meta.icon} />
            {meta.label}
          </a>
        );
      })}
    </div>
  );
}

/**
 * The facts the archive actually holds, as a definition list — the `/log` field block's shape and
 * its ratified labels, minus the two that belong to a certification (there is no Found date and no
 * coordinate to print). Each field is conditional, so an unenriched row prints a short list rather
 * than a row of blanks.
 */
export function TrackFacts({ track }: { track: TrackDestination }) {
  const { notation } = useKeyNotation();
  const releaseLabel = track.releaseDate ? formatReleaseDate(track.releaseDate) : undefined;

  return (
    <dl className="log-fields">
      {releaseLabel ? (
        <div className="log-field">
          <dt>Released</dt>
          <dd>
            <time dateTime={track.releaseDate}>{releaseLabel}</time>
          </dd>
        </div>
      ) : undefined}
      <div className="log-field">
        <dt>Length</dt>
        <dd>{formatDuration(track.durationMs)}</dd>
      </div>
      {track.bpm ? (
        <div className="log-field">
          <dt>BPM</dt>
          <dd>{Math.round(track.bpm)}</dd>
        </div>
      ) : undefined}
      {track.key ? (
        <div className="log-field">
          <dt>Key</dt>
          <dd>{formatKey(track.key, notation)}</dd>
        </div>
      ) : undefined}
      {track.album ? (
        <div className="log-field">
          <dt>Album</dt>
          <dd>
            {track.album.slug ? (
              <GraphLink kind="album" slug={track.album.slug}>
                {track.album.name}
              </GraphLink>
            ) : (
              track.album.name
            )}
          </dd>
        </div>
      ) : undefined}
      {track.label ? (
        <div className="log-field">
          <dt>Label</dt>
          <dd>
            {track.label.slug ? (
              <GraphLink kind="label" slug={track.label.slug}>
                {track.label.name}
              </GraphLink>
            ) : (
              track.label.name
            )}
          </dd>
        </div>
      ) : undefined}
      {track.isrc ? (
        <div className="log-field">
          <dt>ISRC</dt>
          <dd>{track.isrc}</dd>
        </div>
      ) : undefined}
    </dl>
  );
}

/**
 * The artist credits, as `GraphLink`s wherever the name resolves to an `/artist/<slug>` entity —
 * DESIGN.md §5: wherever a surface names a graph node, the name is a GraphLink, never a bespoke
 * link, and the dotted underline is what tells a resolved name from an unresolved one. Commas
 * between, the tracklist convention.
 */
export function TrackArtistCredits({ track }: { track: TrackDestination }) {
  return (
    <p className="graph-uplink">
      {track.artists.map((artist, index) => (
        <span key={`${artist.name}-${index}`}>
          {index > 0 ? ", " : undefined}
          {artist.slug ? (
            <GraphLink kind="artist" slug={artist.slug}>
              {artist.name}
            </GraphLink>
          ) : (
            artist.name
          )}
        </span>
      ))}
    </p>
  );
}

/**
 * "Close in sound" — the neighbours, and the half of this page that makes the archive traversable.
 * The heading is the ratified string `/log` and `/galaxies/<slug>` already use for exactly this
 * band, verbatim (one action, one label).
 *
 * Empty renders nothing: a track with no embedding, an archive with nothing else embedded, and a
 * dark sonar all arrive here as an empty list, and all three degrade to the same honest absence.
 */
export function SonicNeighbours({ neighbours }: { neighbours: SonicNeighbour[] }) {
  if (neighbours.length === 0) {
    return undefined;
  }

  return (
    <ul className="track-neighbours">
      {neighbours.map((neighbour) => {
        const line = artistTitleLine(neighbour);

        return neighbour.logId ? (
          <li className="track-neighbour track-neighbour-lit" key={neighbour.trackId}>
            <Link
              className="track-neighbour-link"
              params={{ logId: neighbour.logId }}
              to="/log/$logId"
            >
              {/* The lit row leads with its cover — cover-led canon, and half of what tells it
                  from the unlit row beneath it. The `small` rung matches the 2.5rem slot. */}
              <TrackArtwork
                alt=""
                className="track-neighbour-cover"
                src={albumCoverAtSize(neighbour.albumImageUrl, "small")}
              />
              <span className="track-neighbour-body">
                <span className="track-neighbour-coordinate">{neighbour.logId}</span>
                <span className="track-neighbour-line">{line}</span>
              </span>
              <CaretRightIcon aria-hidden="true" className="track-neighbour-caret" size={16} />
            </Link>
          </li>
        ) : (
          <li className="track-neighbour track-neighbour-unlit" key={neighbour.trackId}>
            {/* No cover and no coordinate: it has neither, and the absence IS the register
                (DESIGN.md's Unlit Rule). It still goes somewhere — its own destination — which is
                the one thing that changed. */}
            <Link
              className="track-neighbour-link"
              params={{ trackId: neighbour.trackId }}
              to="/track/$trackId"
            >
              <span className="track-neighbour-body">
                <span className="track-neighbour-line">{line}</span>
              </span>
              <CaretRightIcon aria-hidden="true" className="track-neighbour-caret" size={16} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
