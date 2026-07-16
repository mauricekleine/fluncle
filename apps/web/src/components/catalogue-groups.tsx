// THE GROUPED QUIETER ROWS — the map, not the dump.
//
// Read `components/graph-sections.tsx` first: it owns the three bands of a graph page and the
// rule that every band is conditional. This file is what the LAST of those bands becomes once
// the crawl has filled it. An artist page groups the rows into RECORDS; a label page groups
// them by ARTIST and then by record inside each one.
//
// ── WHAT MAY CARRY A HEADING, AND WHAT MAY NOT ────────────────────────────────────────
// DESIGN.md's Unlit Rule, as amended, decides this whole file:
//
//   A heading may name a REAL ENTITY (a record, an artist), or a superset true of every row
//   beneath it. Over a HOMOGENEOUS block of uncertified rows, any heading would be naming the
//   TIER by construction — and the tier has no public name, so there is none. Ever.
//
// So: "Wormhole" over a tracklist is a heading, because a record is a real thing and every row
// under it really is on that record. "Nu:Tone" over his records is a heading for the same
// reason. But nothing is ever written above the ROWS themselves, and the nameless bucket — the
// tracks whose record we do not know — renders as bare rows with no heading at all, because
// there is no honest name for it and inventing one would name the tier through the back door.
//
// The counts obey the same line. "4 records" counts RECORDS; a record is a real entity, so it
// may be counted aloud. The rows are never counted, never introduced, never given a noun.
//
// ── THE COLLAPSED PANEL IS STILL IN THE HTML ──────────────────────────────────────────
// `hiddenUntilFound` on the panel is load-bearing, not a nicety: it renders `hidden="until-found"`,
// which keeps the collapsed content in the DOM — server-rendered, crawlable, and expandable by
// the browser's own find-in-page. These pages exist to BE indexed; a group whose tracks only
// arrive on click would hide the entire point of having crawled them. Collapsing bounds what
// the reader has to look at; only `catalogue-groups.ts`'s limits bound what the page weighs.
//
// ── THE UNLIT REGISTER SURVIVES THE GROUPING ──────────────────────────────────────────
// Every row underneath is still an `UnlitTracks` row: no cover, no coordinate, Stardust ink, no
// gold at rest or on hover, linking OUT to Spotify. The headings are quiet cream, and the only
// gold on the page is the focus ring — which is an accessibility affordance, never a claim
// about the music (the One Sun budget survives a page of 240 rows precisely because of this).

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
} from "@/lib/server/catalogue-groups";

/** The record's year — the one number in this band, so it takes the Tabular Rule's numerals. */
function ReleaseYear({ date }: { date: string | undefined }) {
  // An undated record simply shows no year. It is NOT labelled "unknown": the absence is the
  // honest statement, and a word there would be louder than the fact deserves.
  return date ? <span className="catalogue-year">{date.slice(0, 4)}</span> : undefined;
}

/**
 * One record and its tracklist. The heading names the RECORD — a real entity — and links to
 * `/album/<slug>` whenever that record has an album entity, findings or not: a crawl-minted,
 * findings-free record has a public page now (a tracklist bounded by the thin-content floor), so
 * the server hands this component its `slug` and the heading is a live link. A record with no album
 * entity at all leaves `slug` undefined and the heading is plain text.
 *
 * The NAMELESS record (tracks whose record we do not know) renders with NO heading at all: bare
 * unlit rows, exactly as the flat list always did.
 */
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

/**
 * THE ARTIST PAGE'S BAND: the artist's records, each collapsing to its tracklist.
 *
 * Empty renders nothing at all — the same conditional-band rule the rest of the page lives by.
 */
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
            {/* hiddenUntilFound: the tracklist stays in the DOM while collapsed — see the file
                header. Without it a crawler sees a page of record names and no music. */}
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
          // The nameless bucket: no heading, no accordion, no noun. Just the rows.
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

/**
 * THE LABEL PAGE'S BAND: the label's artists, each collapsing to their records on it.
 *
 * This is the shape that turns a 4,000-row wall into a map — you see that the label has 30
 * artists and 80 records before you have read a single track name, and you open the one you
 * came for. A crate-digger reads a discography this way; nobody reads it as a list.
 */
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
            {/* Counting RECORDS, never the rows: a record is a real entity and may be named and
                counted; the tier the rows belong to may be neither. */}
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

/**
 * The sort control. Chrome, so it is named in the plainest literal words there are (VOICE.md's
 * Chrome Rule) — and it names the thing being sorted, which is a real entity (records, artists),
 * never the tier those rows belong to.
 *
 * It is a Select rather than two links ON PURPOSE: a link would hand a crawler a second URL for
 * the same set of rows, and every group page would exist twice over. The sort is a convenience
 * for a reader who is already here; the canonical view is the one the pager walks.
 */
export function CatalogueSortControl({
  label,
  onChange,
  sort,
}: {
  /** "Sort records" / "Sort artists" — the accessible name. */
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
          {/* "Latest release" and never "Latest found": these rows have no found date, because
              Fluncle never found them. Calling a release date a Found date would be a lie about
              the one thing this archive is careful about (VOICE.md's Found Rule). */}
          <SelectItem value="recent">Latest release</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The pager — REAL ANCHORS, and that is the point of it. `?page=2` is a link a crawler follows,
 * which is what makes "the page renders 12 groups" a page size rather than an arbitrary cap:
 * nothing on the label is unreachable, it is just not all on one screen.
 */
export function CataloguePager({
  buildHref,
  label,
  page,
  pageCount,
}: {
  buildHref: (page: number) => string;
  /** The nav's accessible name — names artists or records, never the tier. */
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
