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
// Fluncle never certified catches the Dust Veil instead, carries no coordinate, and links OUT to
// Spotify, because there is no `/log` page for somewhere he has not been. The uncertified tier is
// never named: no heading, no badge, no noun. In a mixed list a heading may name the SUPERSET
// ("Tracks" — true of every row under it); when the unlit rows are ALL there is, they stand bare,
// because a heading over the only content would exist just to name the tier. The focus ring stays
// Eclipse Gold either way: focus is an accessibility affordance, not a claim about the music.

import { ArrowRightIcon, WaveformIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { SpotifyIcon } from "@/components/platform-icons";
import { SearchFilterChips } from "@/components/search/search-filter-chips";
import { albumCoverAtSize } from "@/lib/media";
import {
  ENTITY_GROUPS,
  entityHref,
  hitHref,
  partitionHits,
  type SearchEntity,
  type SearchHit,
  type SearchResponse,
} from "@/lib/search-results";
import { cn } from "@/lib/utils";

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
 * One track row. The `certified` bit decides everything visible about it, and nothing is labelled —
 * the difference is the register, not a badge.
 *
 * A finding is an internal `Link` to its coordinate. An uncertified track is a plain anchor OUT, with
 * `rel="noopener noreferrer"` because it leaves the origin. A row with neither destination (no
 * coordinate, no Spotify anchor yet) renders as text rather than a dead link.
 */
function TrackRow({ hit }: { hit: SearchHit }): ReactNode {
  const destination = hitHref(hit);
  const className = cn("search-row search-page-row", !hit.certified && "search-row--unlit");
  const body = (
    <>
      <Cover src={hit.albumImageUrl} />
      <span className="search-row-text">
        <span className="search-row-title">{hit.title}</span>
        <span className="search-row-artists">{hit.artists.join(", ")}</span>
      </span>
      <span className="search-row-tail">
        {hit.certified && hit.logId ? (
          <span className="search-row-coordinate">{hit.logId}</span>
        ) : (
          <SpotifyIcon className="search-row-out" />
        )}
      </span>
    </>
  );

  if (!destination) {
    return (
      <li>
        <span className={className}>{body}</span>
      </li>
    );
  }

  if (destination.external) {
    return (
      <li>
        <a className={className} href={destination.href} rel="noopener noreferrer" target="_blank">
          {body}
        </a>
      </li>
    );
  }

  return (
    <li>
      {/* The href is DATA (`/log/024.7.2R`), not a compile-time route literal, so the cast happens
          at this one boundary exactly as `NavRouteLink` and the palette do it. TanStack builds the
          real href from the string at runtime regardless of the compile-time union. */}
      <Link className={className} to={destination.href as never}>
        {body}
      </Link>
    </li>
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
function ResultGroup({ children, heading }: { children: ReactNode; heading?: string }): ReactNode {
  return (
    <section className="search-page-group">
      {heading === undefined ? undefined : <h2 className="search-page-group-heading">{heading}</h2>}
      <ul aria-label={heading} className="search-page-rows">
        {children}
      </ul>
    </section>
  );
}

/** The whole answer, in the order the resolver meant it: what you named, then what it holds. */
export function SearchResultsList({ response }: { response: SearchResponse }): ReactNode {
  const { findings, unlit } = partitionHits(response.results);
  // "Tracks" earns its place only when something NAMED renders above it — then it is doing
  // contrastive work and names the superset. Alone, it would exist just to name the tier.
  const headUnlit = findings.length > 0 || response.entities.length > 0;

  return (
    <>
      {response.anchor ? (
        <p className="search-note">
          <WaveformIcon aria-hidden="true" className="search-note-icon" />
          Near <strong>{response.anchor.title}</strong>
          {response.anchor.artists.length > 0 ? ` — ${response.anchor.artists.join(", ")}` : ""}
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

      {/* The findings lead under the archive's own name — a finding is a named object, so its
          heading is allowed. */}
      {findings.length > 0 ? (
        <ResultGroup heading="Fluncle's Findings">
          {findings.map((hit) => (
            <TrackRow hit={hit} key={hit.trackId} />
          ))}
        </ResultGroup>
      ) : undefined}

      {unlit.length > 0 ? (
        <ResultGroup heading={headUnlit ? "Tracks" : undefined}>
          {unlit.map((hit) => (
            <TrackRow hit={hit} key={hit.trackId} />
          ))}
        </ResultGroup>
      ) : undefined}
    </>
  );
}
