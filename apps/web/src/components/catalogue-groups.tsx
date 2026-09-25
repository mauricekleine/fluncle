import { Link } from "@tanstack/react-router";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@fluncle/ui/components/accordion";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
} from "@fluncle/ui/components/pagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@fluncle/ui/components/select";
import { UnlitTracks } from "@/components/graph-sections";
import {
  type CatalogueArtistGroup,
  type CatalogueRecord,
  type CatalogueSort,
  pageNumbers,
} from "@/lib/catalogue";

function ReleaseYear({ date }: { date: string | undefined }) {
  return date ? <span className="catalogue-year">{date.slice(0, 4)}</span> : undefined;
}

function RecordSection({ record, tracksLabel }: { record: CatalogueRecord; tracksLabel: string }) {
  if (record.tracks.length === 0) {
    return undefined;
  }

  if (!record.name) {
    return <UnlitTracks label={tracksLabel} tracks={record.tracks} />;
  }

  return (
    <section className="catalogue-record">
      <h3 className="catalogue-record-name">
        {record.slug ? (
          <Link params={{ slug: record.slug }} to="/album/$slug">
            {record.name}
          </Link>
        ) : (
          record.name
        )}
        <ReleaseYear date={record.releaseDate} />
      </h3>
      <UnlitTracks label={`${tracksLabel}: ${record.name}`} tracks={record.tracks} />
    </section>
  );
}

export function CatalogueRecords({
  artistName,
  records,
}: {
  artistName: string;
  records: CatalogueRecord[];
}) {
  if (records.length === 0) {
    return undefined;
  }

  return (
    <Accordion className="catalogue-groups">
      {records.map((record) =>
        record.name ? (
          <AccordionItem className="catalogue-group" key={record.name} value={record.name}>
            <AccordionTrigger className="catalogue-group-trigger">
              <span className="catalogue-group-name">{record.name}</span>
              <ReleaseYear date={record.releaseDate} />
            </AccordionTrigger>

            <AccordionContent className="catalogue-group-panel" hiddenUntilFound>
              {record.slug ? (
                <p className="catalogue-more">
                  <Link params={{ slug: record.slug }} to="/album/$slug">
                    More on {record.name}
                  </Link>
                </p>
              ) : undefined}
              <UnlitTracks label={`Tracks on ${record.name}`} tracks={record.tracks} />
            </AccordionContent>
          </AccordionItem>
        ) : (
          <UnlitTracks
            key="unnamed"
            label={`More tracks by ${artistName}`}
            tracks={record.tracks}
          />
        ),
      )}
    </Accordion>
  );
}

export function CatalogueArtistGroups({
  groups,
  labelName,
}: {
  groups: CatalogueArtistGroup[];
  labelName: string;
}) {
  if (groups.length === 0) {
    return undefined;
  }

  return (
    <Accordion className="catalogue-groups">
      {groups.map((group) => (
        <AccordionItem className="catalogue-group" key={group.name} value={group.name}>
          <AccordionTrigger className="catalogue-group-trigger">
            <span className="catalogue-group-name">{group.name}</span>

            <span className="catalogue-group-meta">
              {group.recordCount === 1 ? "1 record" : `${group.recordCount} records`}
            </span>
          </AccordionTrigger>
          <AccordionContent className="catalogue-group-panel" hiddenUntilFound>
            {group.truncated && group.slug ? (
              <p className="catalogue-more">
                <Link params={{ slug: group.slug }} to="/artist/$slug">
                  More from {group.name}
                </Link>
              </p>
            ) : undefined}
            {group.records.map((record) => (
              <RecordSection
                key={record.name ?? "unnamed"}
                record={record}
                tracksLabel={`${group.name} on ${labelName}`}
              />
            ))}
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

export function CatalogueSortControl({
  label,
  onChange,
  sort,
}: {
  label: string;
  onChange: (sort: CatalogueSort) => void;
  sort: CatalogueSort;
}) {
  return (
    <div className="catalogue-sort">
      <Select
        items={[
          { label: "A–Z", value: "name" },
          { label: "Latest release", value: "recent" },
        ]}
        onValueChange={(value) => onChange(value as CatalogueSort)}
        value={sort}
      >
        <SelectTrigger aria-label={label} className="catalogue-sort-trigger" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="name">A–Z</SelectItem>

          <SelectItem value="recent">Latest release</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export function CataloguePager({
  buildHref,
  label,
  page,
  pageCount,
}: {
  buildHref: (page: number) => string;

  label: string;
  page: number;
  pageCount: number;
}) {
  if (pageCount <= 1) {
    return undefined;
  }

  const pages = pageNumbers(page, pageCount);

  return (
    <Pagination aria-label={label} className="catalogue-pager">
      <PaginationContent>
        {page > 1 ? (
          <PaginationItem>
            <PaginationLink href={buildHref(page - 1)} size="sm">
              Previous
            </PaginationLink>
          </PaginationItem>
        ) : undefined}

        {pages.map((n) => (
          <PaginationItem key={n}>
            <PaginationLink href={buildHref(n)} isActive={n === page}>
              {n}
            </PaginationLink>
          </PaginationItem>
        ))}

        {page < pageCount ? (
          <PaginationItem>
            <PaginationLink href={buildHref(page + 1)} size="sm">
              Next
            </PaginationLink>
          </PaginationItem>
        ) : undefined}
      </PaginationContent>
      <p className="catalogue-pager-status">
        Page {page} of {pageCount}
      </p>
    </Pagination>
  );
}
