// The Galaxy door: the default signed-in view — the game scoreboard + the Fly CTA,
// then the collection browser. Lifted from the account monolith unchanged; the full
// voyage-sentence redesign is a later phase. The metric-line skeleton renders only on
// a client-side door switch before the data lands (first paint is always SSR'd).

import { Link } from "@tanstack/react-router";
import { Button } from "@fluncle/ui/components/button";
import { Skeleton } from "@fluncle/ui/components/skeleton";
import { GraphLink } from "@/components/graph-link";
import { formatDateLong } from "@/lib/format";
import { albumCoverAtSize } from "@/lib/media";
import { type Collection, type CollectionItem, type GalaxyDoorData, Metric } from "./shared";

export function GalaxyDoor({ data }: { data: GalaxyDoorData }) {
  const { collection, progress } = data;

  return (
    <div className="account-tab-panel">
      <section className="account-section">
        {(progress?.collectedLogIds.length ?? 0) > 0 ||
        (progress?.wins ?? 0) > 0 ||
        (progress?.deaths ?? 0) > 0 ? (
          <>
            <div className="account-row account-identity">
              <div className="account-grid">
                <Metric label="Lifetime logs" value={progress?.collectedLogIds.length ?? 0} />
                <Metric label="Runs home" value={progress?.wins ?? 0} />
                <Metric label="Tows" value={progress?.deaths ?? 0} />
              </div>
              <Button nativeButton={false} render={<Link to="/galaxy" />}>
                Fly the Galaxy
              </Button>
            </div>
            <p className="account-muted">
              Your Galaxy game record: stars logged, runs flown home, and tows back to Earth after a
              dry tank.
            </p>
          </>
        ) : (
          // A 0/0/0 scoreboard is not a welcome. Before the first flight, the page
          // leads with the door into the game and lets the collection's teaching
          // empty-state carry the rest.
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

/** The metric-line pending state, shown only on a client-side switch into the Galaxy. */
export function GalaxyDoorSkeleton() {
  return (
    <div className="account-tab-panel" aria-hidden>
      <section className="account-section">
        <div className="account-grid">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
        <Skeleton className="h-4 w-2/3" />
      </section>
      <section className="account-section">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </section>
    </div>
  );
}

/**
 * The collection browser: the named galaxies as a map of the archive with the user's
 * progress written into it. Every NAMED galaxy renders a completion line ("4 of 17
 * logged"); a finished galaxy earns the page's one gold note. Collected findings
 * whose galaxy is not yet named group under "Uncharted" — present, never introduced
 * (they get a coordinate and a date, no galaxy name until the operator names one).
 * Dates are the user's own first-collected moments, not the archive's.
 */
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
          complete={galaxy.total > 0 && galaxy.collected >= galaxy.total}
          count={`${galaxy.collected} of ${galaxy.total} logged`}
          items={bySlug.get(galaxy.slug) ?? []}
          key={galaxy.slug}
          name={galaxy.name}
          slug={galaxy.slug}
        />
      ))}
      {ungrouped.length > 0 ? (
        // Findings whose galaxy is not yet named (or whose galaxy retired) render
        // UNHEADED — coordinate, cover, and date, no galaxy clause, no heading, no
        // count. An unnamed tier is never introduced and never given a noun; until
        // the map is fully named this block IS the whole collection.
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
  complete,
  count,
  items,
  name,
  slug,
}: {
  complete: boolean;
  count: string;
  items: CollectionItem[];
  name: string;
  slug: string;
}) {
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
