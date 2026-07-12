// The shared sections of a GRAPH page — the label page and the album page render the
// same three bands, in the same order, and the order is the doctrine:
//
//   1. THE FINDINGS LEAD. Always, on every graph page, as findings: the cover grid, each
//      cover a link to its `/log/<coordinate>` page. A finding is the only named object in
//      Fluncle's world, and it is the only thing on these pages that is named.
//   2. The artists, as chips back into the artist half of the graph.
//   3. The quieter rows.
//
// ── EVERY BAND IS CONDITIONAL ───────────────────────────────────────────────────────
// A band with nothing in it renders NOTHING — no heading, no empty state, no apology.
// All three components return `undefined` on an empty set, and that is the load-bearing
// rule of this file, not a nicety.
//
// The page is then ABOUT what it actually has. A label the crawler discovered carries no
// findings and a wall of tracks, so it renders as a wall of tracks and says nothing about
// findings; a label Fluncle has certified ten bangers off leads with ten covers. Neither
// page apologises for the half it does not have, because a heading over an empty band is
// how a real page turns into a doorway page: "Nothing logged off this one yet." above a
// list of outlinks tells a crawler the page's subject is a thing that is not there. Delete
// the band and the same page is honest.
//
// ── THE QUIETER ROWS (DESIGN.md, the unlit register) ────────────────────────────────
// A track Fluncle knows of but has never certified. It renders UNLIT, and three rules
// hold it there:
//
//   - IT IS NEVER INTRODUCED, NAMED, OR GIVEN A NOUN. No heading, no count, no category
//     label, no "see also". The tier it belongs to has no public name and never will. A
//     screen-reader user gets an accessible name on the list ("More tracks on <entity>")
//     because an unlabelled list of links is an accessibility failure — that names the
//     TRACKS, never the tier.
//   - IT CANNOT BE MISTAKEN FOR A FINDING. No coordinate (it has none), no cover-led gold,
//     muted ink, a hairline rule above it, and it links OUT (a track with no Log ID has no
//     page here to link to). The resting and hover states carry NO Eclipse Gold, so a lit
//     unlit row can never read as a focused one; `:focus-visible` still gets the canonical
//     gold ring, because focus must stay legible and consistent (WCAG).
//   - AN EMPTY SET RENDERS NOTHING AT ALL. Not an empty state, not a heading with no rows:
//     the component returns undefined. Today that is every page (the archive is entirely
//     certified), so these bands are dark until the catalogue lands, and the pages read as
//     if they had never existed.

import { Link } from "@tanstack/react-router";
import { siSpotify } from "simple-icons";
import { ArtistAvatar } from "@/components/artist-avatar";
import { BrandIcon } from "@/components/brand-icon";
import { GraphLink } from "@/components/graph-link";
import { TrackArtwork } from "@/components/track-artwork";
import { artistTitleLine } from "@/lib/log-prose";
import { albumCoverAtSize } from "@/lib/media";
import { type GraphPageTrack } from "@/lib/log-schema";
import { type ArtistChip } from "@/lib/server/artists";
import { type CatalogueTrackItem, type TrackListItem } from "@/lib/server/tracks";

/**
 * Both halves of a graph page, in render order, as the JSON-LD's track list: the findings
 * first (each resolving to its `/log` coordinate), then the quieter rows (each resolving to
 * its off-site URL, or to none). Shared by the label and album heads so the structured data
 * describes exactly what the page renders — schema that contradicts the page gets
 * discounted, and only a finding is ever given a Fluncle URL.
 */
export function graphPageTracks(
  findings: TrackListItem[],
  catalogue: CatalogueTrackItem[],
): GraphPageTrack[] {
  return [
    ...findings.flatMap((finding) =>
      finding.logId
        ? [{ artists: finding.artists, logId: finding.logId, title: finding.title }]
        : [],
    ),
    ...catalogue.map((track) => ({
      artists: track.artists,
      spotifyUrl: track.spotifyUrl,
      title: track.title,
    })),
  ];
}

/**
 * The findings band: the cover grid that LEADS every graph page. Only coordinate-bearing
 * findings render (the grid is a grid of log links).
 *
 * An entity with none renders NOTHING here — no grid, no heading, no empty state. It used
 * to print "Quiet sector." and that line is exactly what made a crawler-discovered label
 * read as a doorway page: an apology for the absent half, sitting above the half that is
 * actually there. A page with no findings is not a broken findings page; it is a page about
 * something else.
 */
export function FindingsGrid({
  findings,
  label,
}: {
  findings: TrackListItem[];
  /** The list's accessible name, e.g. "Findings on Hospital Records". */
  label: string;
}) {
  const grid = findings.filter((finding) => finding.logId);

  if (grid.length === 0) {
    return undefined;
  }

  return (
    <ul aria-label={label} className="artist-grid">
      {grid.map((finding) =>
        finding.logId ? (
          <li key={finding.trackId}>
            <Link params={{ logId: finding.logId }} to="/log/$logId">
              <TrackArtwork
                alt=""
                className="artist-grid-cover"
                src={albumCoverAtSize(finding.albumImageUrl, "large")}
              />
              <span className="artist-grid-line">{artistTitleLine(finding)}</span>
            </Link>
          </li>
        ) : null,
      )}
    </ul>
  );
}

/**
 * The artist band: chips back into `/artist/<slug>` — the graph's cross-link.
 *
 * The chip is a `GraphLink` in its `chip` skin: the same component, the same route, and the
 * same hover card as an artist named in a sentence, but without the dotted underline (a chip is
 * not a word in a sentence — the tile already draws the affordance, and its own hover state
 * does the heating). One system, two skins.
 */
export function ArtistChips({ artists, title }: { artists: ArtistChip[]; title: string }) {
  if (artists.length === 0) {
    return undefined;
  }

  return (
    <nav aria-label={title} className="artist-similar">
      <p className="artist-similar-label">{title}</p>
      <ul className="artist-similar-list">
        {artists.map((artist) => (
          <li key={artist.slug}>
            <GraphLink
              className="artist-similar-link"
              kind="artist"
              slug={artist.slug}
              variant="chip"
            >
              <ArtistAvatar
                className="artist-similar-avatar"
                name={artist.name}
                src={artist.imageUrl}
              />
              <span>{artist.name}</span>
            </GraphLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The quieter rows. Read the file header before changing anything here: no heading, no
 * noun, nothing rendered at all when the set is empty.
 *
 * A row links out to Spotify when the track has a Spotify presence; a catalogue-only track
 * that has none renders as plain, unlinked text (there is nowhere honest to send you).
 */
export function UnlitTracks({
  label,
  tracks,
}: {
  /** The list's accessible name — names the TRACKS, never the tier. */
  label: string;
  tracks: CatalogueTrackItem[];
}) {
  if (tracks.length === 0) {
    return undefined;
  }

  return (
    <ul aria-label={label} className="unlit-list">
      {tracks.map((track) => {
        const line = artistTitleLine(track);

        return (
          <li className="unlit-row" key={track.trackId}>
            {track.spotifyUrl ? (
              <a
                aria-label={`${line} on Spotify`}
                className="unlit-link"
                href={track.spotifyUrl}
                rel="noreferrer"
                target="_blank"
              >
                <span className="unlit-line">{line}</span>
                <BrandIcon className="unlit-mark" icon={siSpotify} />
              </a>
            ) : (
              <span className="unlit-line">{line}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
