import { ArrowRightIcon, WaveformIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import { DiscoveryPlayableList, DiscoveryRow } from "@/components/discovery-row";
import { SearchFilterChips } from "@/components/search/search-filter-chips";
import { searchHitToDiscoveryTrack } from "@/lib/discovery-tracks";
import { galaxySoundLine } from "@/lib/galaxy-sound";
import { queueTrackFromHit } from "@/lib/player-tracks";
import { albumCoverAtSize } from "@/lib/media";
import {
  ENTITY_GROUPS,
  entityHref,
  partitionHits,
  type SearchEntity,
  type SearchHit,
  type SearchResponse,
  searchSeeAll,
} from "@/lib/search-results";
import { anchorNames, styleBySlug } from "@/lib/search-styles";

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

export function EntitySoundLine({ entity }: { entity: SearchEntity }): ReactNode {
  const line = entity.kind === "galaxy" ? galaxySoundLine(entity.slug) : undefined;

  return line ? <span className="search-row-artists search-row-sound">{line}</span> : undefined;
}

function EntityRow({ entity }: { entity: SearchEntity }): ReactNode {
  return (
    <li>
      <Link className="search-row search-page-row" to={entityHref(entity) as never}>
        <Cover src={entity.imageUrl} />
        <span className="search-row-text">
          <span className="search-row-title">{entity.name}</span>
          <EntitySoundLine entity={entity} />
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

export function SearchResultsList({
  response,
  sonicView = false,
}: {
  response: SearchResponse;
  sonicView?: boolean;
}): ReactNode {
  const byDistance = response.kind === "sonic";
  const { findings, unlit } = byDistance
    ? { findings: [], unlit: response.results }
    : partitionHits(response.results);
  const tracks = useMemo(
    () => [...findings, ...unlit].map(searchHitToDiscoveryTrack),
    [findings, unlit],
  );

  const headUnlit = findings.length > 0 || response.entities.length > 0;
  const style = styleBySlug(response.filters?.sound);
  const leanedOn = response.filters?.soundsLikeArtists ?? [];
  const seeAll = searchSeeAll(response);
  const seed = useMemo(
    () => (response.anchor ? queueTrackFromHit(response.anchor) : undefined),
    [response.anchor],
  );

  return (
    <>
      {response.anchor && sonicView ? (
        leanedOn.length > 0 ? (
          <p className="search-note">
            <WaveformIcon aria-hidden="true" className="search-note-icon" />
            <span>
              I haven’t got a read on <strong>{response.anchor.title}</strong> yet, so I went by{" "}
              <strong>{anchorNames(leanedOn)}</strong>.
            </span>
          </p>
        ) : undefined
      ) : response.anchor ? (
        <p className="search-note">
          <WaveformIcon aria-hidden="true" className="search-note-icon" />
          Near <strong>{anchorCredit(response.anchor)}</strong>
        </p>
      ) : undefined}

      {style ? (
        <p className="search-note">
          <WaveformIcon aria-hidden="true" className="search-note-icon" />
          <span>
            Going by <strong>{anchorNames(leanedOn)}</strong>.
          </span>
        </p>
      ) : undefined}

      {response.degraded ? (
        <p className="search-note search-note--degraded">
          Reading by name only right now. These are the closest words I&apos;ve got.
        </p>
      ) : undefined}

      {response.filters && !style && !sonicView ? (
        <SearchFilterChips filters={response.filters} />
      ) : undefined}

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

      <DiscoveryPlayableList seed={seed} tracks={tracks}>
        {findings.length > 0 ? <TrackGroup heading="Findings" hits={findings} /> : undefined}

        {unlit.length > 0 ? (
          <TrackGroup heading={headUnlit ? "Tracks" : undefined} hits={unlit} />
        ) : undefined}
      </DiscoveryPlayableList>

      {seeAll ? (
        <p className="search-see-all">
          <Link className="search-see-all-link" to={seeAll.href as never}>
            {seeAll.label}
            <ArrowRightIcon aria-hidden="true" className="search-jump-icon" />
          </Link>
        </p>
      ) : undefined}
    </>
  );
}
