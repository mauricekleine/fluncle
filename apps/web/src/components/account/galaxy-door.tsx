import { Link } from "@tanstack/react-router";
import { Button } from "@fluncle/ui/components/button";
import { Skeleton } from "@fluncle/ui/components/skeleton";
import { GraphLink } from "@/components/graph-link";
import { formatDateLong } from "@/lib/format";
import { albumCoverAtSize } from "@/lib/media";
import {
  buildVoyageSentence,
  flyCtaVariant,
  galaxiesReached,
  type VoyagePart,
} from "./galaxy-voyage";
import { type Collection, type CollectionItem, type GalaxyDoorData, type Progress } from "./shared";

export function GalaxyDoor({ data }: { data: GalaxyDoorData }) {
  const { collection, progress } = data;

  const hasProgress =
    (progress?.collectedLogIds.length ?? 0) > 0 ||
    (progress?.wins ?? 0) > 0 ||
    (progress?.deaths ?? 0) > 0;

  return (
    <div className="account-tab-panel">
      <section className="account-section">
        {hasProgress ? (
          <VoyageScoreboard collection={collection} progress={progress} />
        ) : (
          <div className="account-row account-identity">
            <p className="account-muted">
              Every star you reach in the Galaxy gets logged here, along with your runs home.
            </p>
            <Button nativeButton={false} render={<Link to="/galaxy" />}>
              Fly the Galaxy
            </Button>
          </div>
        )}
      </section>
      <CollectionSection collection={collection} />
    </div>
  );
}

function VoyageScoreboard({
  collection,
  progress,
}: {
  collection?: Collection;
  progress?: Progress;
}) {
  const galaxies = collection?.galaxies ?? [];
  const ungroupedCount = collection
    ? collection.collection.filter((item) => !item.galaxySlug).length
    : 0;

  const parts = buildVoyageSentence({
    galaxies: galaxiesReached(galaxies, ungroupedCount),
    homes: progress?.wins ?? 0,
    stars: progress?.collectedLogIds.length ?? 0,
    tows: progress?.deaths ?? 0,
  });

  return (
    <div className="account-row account-voyage-row">
      <p className="account-voyage">
        {parts.map((part: VoyagePart, index) =>
          typeof part === "string" ? (
            <span key={index}>{part}</span>
          ) : (
            <span className="account-voyage-num" key={index}>
              {part.num}
            </span>
          ),
        )}
      </p>
      <Button nativeButton={false} render={<Link to="/galaxy" />} variant={flyCtaVariant(galaxies)}>
        Fly the Galaxy
      </Button>
    </div>
  );
}

export function GalaxyDoorSkeleton() {
  return (
    <div className="account-tab-panel" aria-hidden>
      <section className="account-section">
        <div className="account-row account-voyage-row">
          <div className="account-voyage flex flex-col gap-1.5">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <Skeleton className="h-9 w-32" />
        </div>
      </section>
      <section className="account-section">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </section>
    </div>
  );
}

function CollectionSection({ collection }: { collection?: Collection }) {
  if (!collection) {
    return (
      <section className="account-section">
        <h2>Collection</h2>
        <p className="account-muted">Reading your log…</p>
      </section>
    );
  }

  const bySlug = new Map<string, CollectionItem[]>();
  const ungrouped: CollectionItem[] = [];

  for (const item of collection.collection) {
    if (item.galaxySlug) {
      const group = bySlug.get(item.galaxySlug) ?? [];

      group.push(item);
      bySlug.set(item.galaxySlug, group);
    } else {
      ungrouped.push(item);
    }
  }

  if (collection.collection.length === 0 && collection.galaxies.length === 0) {
    return (
      <section className="account-section">
        <h2>Collection</h2>
        <p className="account-muted">
          No stars logged yet. Every star you reach in the Galaxy lands here, with the date you
          reached it.
        </p>
        <Link className="account-collection-cta" to="/galaxy">
          Fly the Galaxy
        </Link>
      </section>
    );
  }

  return (
    <section className="account-section">
      <h2>Collection</h2>
      <p className="account-muted">
        Every star you reach in the Galaxy is logged here for good, with the date you reached it.
      </p>
      {collection.galaxies.map((galaxy) => (
        <CollectionGroup
          collected={galaxy.collected}
          complete={galaxy.total > 0 && galaxy.collected >= galaxy.total}
          count={`${galaxy.collected} of ${galaxy.total} logged`}
          items={bySlug.get(galaxy.slug) ?? []}
          key={galaxy.slug}
          name={galaxy.name}
          slug={galaxy.slug}
          total={galaxy.total}
        />
      ))}
      {ungrouped.length > 0 ? (
        <ul className="account-list account-collection-unheaded">
          {ungrouped.map((item) => (
            <CollectionRow item={item} key={item.trackId} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function CollectionGroup({
  collected,
  complete,
  count,
  items,
  name,
  slug,
  total,
}: {
  collected: number;
  complete: boolean;
  count: string;
  items: CollectionItem[];
  name: string;
  slug: string;
  total: number;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((collected / total) * 100)) : 0;

  return (
    <div className="account-collection-group">
      <div className="account-collection-heading">
        <h3>
          <GraphLink kind="galaxy" slug={slug}>
            {name}
          </GraphLink>
        </h3>
        <span className={complete ? "account-collection-complete" : undefined}>
          {complete ? `All ${items.length} logged` : count}
        </span>
      </div>
      {total > 0 ? (
        <div
          aria-label={`${name}: ${count}`}
          aria-valuemax={total}
          aria-valuemin={0}
          aria-valuenow={collected}
          className="account-collection-meter"
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a painted meter with its own fill element; a native <progress> can't carry this treatment.
          role="progressbar"
        >
          <span
            className="account-collection-meter-fill"
            data-complete={complete ? "" : undefined}
            style={{ inlineSize: `${pct}%` }}
          />
        </div>
      ) : null}
      {items.length > 0 ? (
        <ul className="account-list">
          {items.map((item) => (
            <CollectionRow item={item} key={item.trackId} />
          ))}
        </ul>
      ) : (
        <p className="account-muted">No stars logged here yet.</p>
      )}
    </div>
  );
}

function CollectionRow({ item }: { item: CollectionItem }) {
  return (
    <li className="account-collection-row">
      {item.imageUrl ? (
        <img
          alt=""
          className="account-collection-thumb"
          height={40}
          loading="lazy"
          src={albumCoverAtSize(item.imageUrl, "small")}
          width={40}
        />
      ) : (
        <span aria-hidden className="account-collection-thumb" />
      )}
      <span className="account-collection-body">
        <Link to="/log/$logId" params={{ logId: item.logId }}>
          {item.artists.join(", ")} — {item.title}
        </Link>
        <span className="account-collection-meta">
          <span className="account-collection-logid">{item.logId}</span> · First logged{" "}
          {formatDateLong(item.firstCollectedAt)}
        </span>
      </span>
    </li>
  );
}
