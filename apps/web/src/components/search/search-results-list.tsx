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

function TrackGroup({ heading, hits }: { heading?: string; hits: SearchHit[] }): ReactNode {
  return (
    <ResultGroup className="discovery-list search-page-tracks" heading={heading}>
      {hits.map((hit) => (
        <DiscoveryRow key={hit.trackId} track={searchHitToDiscoveryTrack(hit)} />
      ))}
    </ResultGroup>
  );
}

export function anchorCredit(anchor: SearchHit): string {
  const artists = anchor.artists.join(", ");

  return artists.length > 0 ? `${artists} — ${anchor.title}` : anchor.title;
}

export function SearchResultsList({ response }: { response: SearchResponse }): ReactNode {
  const { findings, unlit } = partitionHits(response.results);

  const tracks = useMemo(
    () => [...findings, ...unlit].map(searchHitToDiscoveryTrack),
    [findings, unlit],
  );

  const headUnlit = findings.length > 0 || response.entities.length > 0;

  return (
    <>
      {response.anchor ? (
        <p className="search-note">
          <WaveformIcon aria-hidden="true" className="search-note-icon" />
          Near <strong>{anchorCredit(response.anchor)}</strong>
        </p>
      ) : undefined}

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

      <DiscoveryPlayableList tracks={tracks}>
        {findings.length > 0 ? <TrackGroup heading="Findings" hits={findings} /> : undefined}

        {unlit.length > 0 ? (
          <TrackGroup heading={headUnlit ? "Tracks" : undefined} hits={unlit} />
        ) : undefined}
      </DiscoveryPlayableList>
    </>
  );
}
