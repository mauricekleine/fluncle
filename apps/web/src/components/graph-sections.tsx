// The shared sections of a GRAPH page — the label page and the album page render the
// same three bands, in the same order, and the order is the doctrine:
//
//   1. THE FINDINGS LEAD. Always, on every graph page, as findings: the cover grid, each
//      cover its preview's play button and each caption a link to its `/log/<coordinate>` page. A finding is the only named object in
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
//     TRACKS, never the tier. The BAND around it (the artist/label page's
//     `.catalogue-section`) may likewise carry a visually-hidden H2 holding that same
//     superset name, so the heading outline runs H1 → H2 → H3 rather than jumping a
//     level; it names the records or the artists the band belongs to, never the tier,
//     and it is never visible.
//   - IT CANNOT BE MISTAKEN FOR A FINDING. It renders through the shared discovery row, in
//     the unlit register: its real cover desaturated and dimmed, no coordinate (it has none),
//     and NO Eclipse Gold at rest or on hover, so it can never read as a focused or certified
//     row; `:focus-visible` still gets the canonical gold ring, because focus must stay legible
//     and consistent (WCAG). The cover plays its preview, and the row leads INTO the archive —
//     `/track/<trackId>`, the recording's own destination. A destination is not a name, and the
//     tier is still never introduced (see UnlitTracks).
//   - AN EMPTY SET RENDERS NOTHING AT ALL. Not an empty state, not a heading with no rows:
//     the component returns undefined, so a page with no uncertified tracks reads as if
//     the band had never existed.

import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { ArtistAvatar } from "@/components/artist-avatar";
import { DiscoveryList, DiscoveryPlayableList } from "@/components/discovery-row";
import { GraphLink } from "@/components/graph-link";
import { PlayCover } from "@/components/player/playable-list";
import { TrackArtwork } from "@/components/track-artwork";
import {
  catalogueTrackToDiscoveryTrack,
  discoveryQueueTrack,
  findingToDiscoveryTrack,
} from "@/lib/discovery-tracks";
import { artistTitleLine } from "@/lib/log-prose";
import { hasTrackPageIdentity } from "@/lib/track-page";
import { albumCoverAtSize } from "@/lib/media";
import { type GraphPageTrack } from "@/lib/log-schema";
import { type ArtistChip } from "@/lib/server/artists";
import { type CatalogueTrackItem, type TrackListItem } from "@/lib/server/tracks";

/**
 * Both halves of a graph page, in render order, as the JSON-LD's track list: the findings
 * first (each resolving to its `/log` coordinate), then the quieter rows (each resolving to its
 * own `/track/<trackId>` destination, or to its off-site URL when the destination would refuse
 * it, or to nothing). Shared by the label and album heads so the structured data describes
 * exactly what the page renders — schema that contradicts the page gets discounted.
 *
 * A FINDING'S URL IS STILL ONLY EVER ITS COORDINATE. What changed is that an uncertified row now
 * has a Fluncle URL too; it is a different one, and neither can be mistaken for the other.
 */
export function graphPageTracks(
  findings: TrackListItem[],
  catalogue: CatalogueTrackItem[],
): GraphPageTrack[] {
  return [
    ...findings.flatMap((finding) =>
      finding.logId
        ? [
            {
              artists: finding.artists,
              // The finding's per-track facts (G1) — its length, ISRC, and release date — so the
              // graph page's JSON-LD MusicRecordings carry duration/isrcCode/datePublished. All
              // live on the finding's TrackListItem already; the quieter catalogue rows below
              // carry none of them (they stay as spare as they render).
              durationMs: finding.durationMs,
              isrc: finding.isrc,
              logId: finding.logId,
              releaseDate: finding.releaseDate,
              title: finding.title,
            },
          ]
        : [],
    ),
    ...catalogue.map((track) => ({
      artists: track.artists,
      spotifyUrl: track.spotifyUrl,
      title: track.title,
      // The row's own destination — the quieter rows are no longer dead ends, so the schema
      // resolves them home the same way the rendered row does. A row the destination would refuse
      // (no title, no credit) carries no id here and falls back to its off-site URL.
      trackId: hasTrackPageIdentity(track) ? track.trackId : undefined,
    })),
  ];
}

/**
 * A cover grid of findings that plays as one list: each tile's cover is its play button (when the
 * finding has a live preview) and its caption opens the log page. Shared by every graph page's
 * findings band and the galaxy lens.
 *
 * The rung matches the SLOT, not the master: a `medium` tile renders around 104–120 CSS px and
 * wants ~240 device px on a 2× screen. The FIRST tile is the band's lead cover, above the fold on
 * every graph page and so the page's LCP candidate — it fetches eagerly at high priority, and the
 * route preloads this exact URL from its head(). Tiles 2..n stay lazy: the whole point of the
 * signal is that one image carries it.
 */
export function FindingsGridList({
  className,
  coverClassName = "artist-grid-cover",
  findings,
  label,
  labelledBy,
  lineClassName = "artist-grid-line",
  priorityFirst = true,
  size,
}: {
  className: string;
  coverClassName?: string;
  findings: TrackListItem[];
  label?: string;
  labelledBy?: string;
  lineClassName?: string;
  priorityFirst?: boolean;
  size: TileSize;
}) {
  const tiles = useMemo(
    () =>
      findings
        .filter((finding) => finding.logId)
        .map((finding) => findingToDiscoveryTrack(finding)),
    [findings],
  );

  return (
    <DiscoveryPlayableList tracks={tiles}>
      <ul aria-label={label} aria-labelledby={labelledBy} className={className}>
        {findings.map((finding, index) =>
          finding.logId ? (
            <FindingGridTile
              coverClassName={coverClassName}
              finding={finding}
              key={finding.trackId}
              lineClassName={lineClassName}
              logId={finding.logId}
              priority={priorityFirst && index === 0}
              size={size}
            />
          ) : null,
        )}
      </ul>
    </DiscoveryPlayableList>
  );
}

type TileSize = "large" | "medium" | "small";

function FindingGridTile({
  coverClassName,
  finding,
  lineClassName,
  logId,
  priority,
  size,
}: {
  coverClassName: string;
  finding: TrackListItem;
  lineClassName: string;
  logId: string;
  priority: boolean;
  size: TileSize;
}) {
  const track = findingToDiscoveryTrack(finding);
  const cover = (
    <TrackArtwork
      alt=""
      className={coverClassName}
      priority={priority}
      src={albumCoverAtSize(finding.albumImageUrl, size)}
    />
  );

  return (
    <li className="finding-grid-tile">
      {track.previewable ? (
        <PlayCover className="finding-grid-play" lit track={discoveryQueueTrack(track)}>
          {cover}
        </PlayCover>
      ) : (
        cover
      )}
      <Link params={{ logId }} to="/log/$logId">
        <span className={lineClassName}>{artistTitleLine(finding)}</span>
      </Link>
    </li>
  );
}

/**
 * The catalogue-register curator heading over the findings block — fixed, and folded into the
 * component (not a prop) so no call site can reintroduce an entity-named title ("Findings on X").
 * The lore-area surfaces carry the archive's own cosmos name; a catalogue/entity page reads plainly
 * (VOICE.md Three Areas; DESIGN.md Unlit Rule mixed-list carve-out).
 */
const FINDINGS_HEADING = "Recommended by Fluncle";

/**
 * The findings band: the cover grid that LEADS every graph page, under a VISIBLE section heading
 * ("Recommended by Fluncle"). Only coordinate-bearing findings render (the grid is a grid of log
 * links). The heading is permitted here by DESIGN.md's mixed-list carve-out: a findings block MAY
 * be introduced, because a finding is a named object. That carve-out stops at this band — the
 * uncertified quieter rows below stay unheaded and unnamed (UnlitTracks, the unnamed tier).
 *
 * An entity with none renders NOTHING here — no heading, no grid, no empty state. It used
 * to print "Quiet sector." and that line is exactly what made a crawler-discovered label
 * read as a doorway page: an apology for the absent half, sitting above the half that is
 * actually there. A page with no findings is not a broken findings page; it is a page about
 * something else.
 */
export function FindingsGrid({ findings, label }: { findings: TrackListItem[]; label?: string }) {
  const grid = findings.filter((finding) => finding.logId);

  if (grid.length === 0) {
    return undefined;
  }

  return (
    <section className="artist-findings">
      {/* A real H2 (styled by .artist-similar-label) so the visible section heading joins the page
          outline — H1 (entity) → H2 (this) → the sibling H2s. Its `aria-labelledby` names the grid. */}
      {label === undefined ? (
        <h2 className="artist-similar-label" id="findings-grid-heading">
          {FINDINGS_HEADING}
        </h2>
      ) : undefined}
      {/* Only the lead band's first cover is the page's LCP candidate; an Upcoming grid sits below
          the fold and stays lazy. */}
      <FindingsGridList
        className="artist-grid"
        findings={grid}
        label={label}
        labelledBy={label === undefined ? "findings-grid-heading" : undefined}
        priorityFirst={label === undefined}
        size="medium"
      />
    </section>
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
      <h2 className="artist-similar-label">{title}</h2>
      <ul className="artist-similar-list">
        {artists.map((artist) => (
          <li key={artist.slug}>
            <GraphLink
              className="artist-similar-link"
              kind="artist"
              slug={artist.slug}
              variant="chip"
            >
              {/* A chip avatar is 1.5rem — 24 CSS px, 48 on a 2× screen — so it takes the 64 rung,
                  not the 640 the DTO hands out (a 26× over-fetch on a tile this size). An avatar
                  with no owned master takes Spotify's own portrait floor (160) instead — the
                  smallest rendition that family publishes. */}
              <ArtistAvatar
                className="artist-similar-avatar"
                name={artist.name}
                src={albumCoverAtSize(artist.imageUrl, "small")}
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
 * Each row is the shared discovery row (`components/discovery-row.tsx`) in the unlit register:
 * the cover plays the list from that row, the row opens the recording's own `/track/<trackId>`
 * destination, and the Spotify way out lives in the row's ⋮ menu. A row the destination would
 * refuse (no title, or no artist credit — `hasTrackPageIdentity`) opens Spotify instead, or
 * nothing when it has no streaming presence either, because there is nowhere honest to send you.
 * The list plays as one: a record's tracklist is a queue in its own order.
 */
export function UnlitTracks({
  label,
  tracks,
}: {
  /** The list's accessible name — names the TRACKS, never the tier. */
  label: string;
  tracks: CatalogueTrackItem[];
}) {
  const rows = useMemo(() => tracks.map(catalogueTrackToDiscoveryTrack), [tracks]);

  if (tracks.length === 0) {
    return undefined;
  }

  return <DiscoveryList className="unlit-tracks" label={label} tracks={rows} />;
}
