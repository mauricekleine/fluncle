// `/search`'s answer, rendered as a PAGE — the persistent counterpart to the ⌘K palette's list.
//
// Same answer, same ranking, same registers, different affordance. The palette renders `CommandItem`
// rows a keyboard drives and a click dismisses; this renders real anchors, which is the whole point
// of the persistent surface: a crawler walks them with no JS, a reader middle-clicks one into a new
// tab, and every destination is a URL rather than an imperative `navigate`.
//
// The GROUPING is not restated here — `partitionHits` and `ENTITY_GROUPS` are the palette's, imported
// from `lib/search-results.ts` — so the two surfaces cannot drift on what leads, what is named, and
// what is never named.
//
// ── THE UNLIT RULE (DESIGN.md) ───────────────────────────────────────────────────────────────
// A finding is lit: it carries its coordinate in Oxanium and heats to Eclipse Gold on hover. A track
// Fluncle never certified catches the Dust Veil instead, carries no coordinate, and links to its
// own `/track/<trackId>` destination — there is still no `/log` page for somewhere he has not
// been, and that destination is not one: it carries no coordinate. The uncertified tier is
// never named: no heading, no badge, no noun. In a mixed list a heading may name the SUPERSET
// ("Tracks" — true of every row under it); when the unlit rows are ALL there is, they stand bare,
// because a heading over the only content would exist just to name the tier. The focus ring stays
// Eclipse Gold either way: focus is an accessibility affordance, not a claim about the music.

import { ArrowRightIcon, WaveformIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import { DiscoveryPlayableList, DiscoveryRow } from "@/components/discovery-row";
import { SearchFilterChips } from "@/components/search/search-filter-chips";
import { searchHitToDiscoveryTrack } from "@/lib/discovery-tracks";
import { albumCoverAtSize } from "@/lib/media";
import {
  ENTITY_GROUPS,
  entityHref,
  partitionHits,
  type SearchEntity,
  type SearchHit,
  type SearchResponse,
} from "@/lib/search-results";

/** The cover, or the Dust-Veil square that stands in for one. Never a gold placeholder. */
function Cover({ src }: { src?: string }): ReactNode {
  if (!src) {
    return <span aria-hidden="true" className="search-cover search-cover--empty" />;
  }

  return (
    <img
      alt=""
      className="search-cover"
      decoding="async"
      loading="lazy"
      src={albumCoverAtSize(src, "small")}
    />
  );
}

/**
 * One entity row — the FIRST-CLASS destination: the thing the reader searched for, offered as
 * somewhere to go, above the tracks it also brought back. All five kinds are one row because they
 * are one affordance; the only thing `kind` decides is which page the arrow goes to.
 */
function EntityRow({ entity }: { entity: SearchEntity }): ReactNode {
  return (
    <li>
      <Link className="search-row search-page-row" to={entityHref(entity) as never}>
        <Cover src={entity.imageUrl} />
        <span className="search-row-text">
          <span className="search-row-title">{entity.name}</span>
        </span>
        <span className="search-row-tail">
          <ArrowRightIcon aria-hidden="true" className="search-jump-icon" />
        </span>
      </Link>
    </li>
  );
}

/** A titled block of rows. The heading is a real `<h2>`, so the page has an outline to jump by. */
function ResultGroup({
  children,
  className = "search-page-rows",
  heading,
}: {
  children: ReactNode;
  className?: string;
  heading?: string;
}): ReactNode {
  return (
    <section className="search-page-group">
      {heading === undefined ? undefined : <h2 className="search-page-group-heading">{heading}</h2>}
      <ul aria-label={heading} className={className}>
        {children}
      </ul>
    </section>
  );
}

/**
 * The track rows: the shared discovery row (`components/discovery-row.tsx`), the same row `/tracks`
 * and `/fresh` render. The cover plays, the rest of the row opens the finding's coordinate or the
 * archive track's own destination, the readout sits under the title, and the register rides the
 * light alone (The Unlit Rule): a finding carries its coordinate and heats to gold, an uncertified
 * track shows its cover dimmed and never names its tier.
 */
function TrackGroup({ heading, hits }: { heading?: string; hits: SearchHit[] }): ReactNode {
  return (
    <ResultGroup className="discovery-list search-page-tracks" heading={heading}>
      {hits.map((hit) => (
        <DiscoveryRow key={hit.trackId} track={searchHitToDiscoveryTrack(hit)} />
      ))}
    </ResultGroup>
  );
}

/** The sonic anchor as a tracklist credit — `Artist — Title`, or the bare title where the row
    carries no credit. Shared with the palette's own note so the two rooms read the same. */
export function anchorCredit(anchor: SearchHit): string {
  const artists = anchor.artists.join(", ");

  return artists.length > 0 ? `${artists} — ${anchor.title}` : anchor.title;
}

/** The whole answer, in the order the resolver meant it: what you named, then what it holds. */
export function SearchResultsList({ response }: { response: SearchResponse }): ReactNode {
  const { findings, unlit } = partitionHits(response.results);
  // The answer is one list to the player, in the order it reads: the findings, then the tracks.
  const tracks = useMemo(
    () => [...findings, ...unlit].map(searchHitToDiscoveryTrack),
    [findings, unlit],
  );
  // "Tracks" earns its place only when something NAMED renders above it — then it is doing
  // contrastive work and names the superset. Alone, it would exist just to name the tier.
  const headUnlit = findings.length > 0 || response.entities.length > 0;

  return (
    <>
      {response.anchor ? (
        <p className="search-note">
          <WaveformIcon aria-hidden="true" className="search-note-icon" />
          {/* `Artist — Title` is the ONE sanctioned em dash (VOICE.md §6, tracklist convention).
              Inverted it is an em dash in prose, which the same rule bans. */}
          Near <strong>{anchorCredit(response.anchor)}</strong>
        </p>
      ) : undefined}

      {/* The honesty line. The language tier was wanted and could not run, so these are text hits,
          not the filters you asked for, and search says so rather than passing one off as the
          other. Identical wording to the palette: one admission, one phrasing. */}
      {response.degraded ? (
        <p className="search-note search-note--degraded">
          Reading by name only right now. These are the closest words I&apos;ve got.
        </p>
      ) : undefined}

      {response.filters ? <SearchFilterChips filters={response.filters} /> : undefined}

      {ENTITY_GROUPS.map((group) => {
        const entities = response.entities.filter((entity) => entity.kind === group.kind);

        if (entities.length === 0) {
          return undefined;
        }

        return (
          <ResultGroup heading={group.heading} key={group.kind}>
            {entities.map((entity) => (
              <EntityRow entity={entity} key={`${entity.kind}-${entity.slug}`} />
            ))}
          </ResultGroup>
        );
      })}

      {/* The findings lead, headed by the NAMED OBJECT and not by the collection's nameplate.
          DESIGN.md's Unlit Rule reserves "Fluncle's Findings" for lore-area surfaces, and this is
          not one; "Recommended by Fluncle", the catalogue-side heading, would be a different lie
          here (these are matches, not recommendations). "Findings" is the noun itself — parallel to
          the kind headings above it, and still the contrastive pair for "Tracks" below. */}
      <DiscoveryPlayableList tracks={tracks}>
        {findings.length > 0 ? <TrackGroup heading="Findings" hits={findings} /> : undefined}

        {unlit.length > 0 ? (
          <TrackGroup heading={headUnlit ? "Tracks" : undefined} hits={unlit} />
        ) : undefined}
      </DiscoveryPlayableList>
    </>
  );
}
