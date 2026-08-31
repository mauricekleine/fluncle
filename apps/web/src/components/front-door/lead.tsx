// THE EDITED LEAD — one finding, placed.
//
// It is the newest finding Fluncle actually WROTE about (`hasNote`, resolved in
// `-front-door-data.ts`), which is what makes this an edited placement rather than a "latest" slot.
// The note is the whole reason it earns the size: a lead with nothing to say is just a bigger row.
//
// ── LIGHT AND PLACEMENT ──────────────────────────────────────────────────────────────────────
// A finding is the only thing that can lead here, so this placement is lit throughout: the cover at
// full size, the Log ID coordinate in Eclipse Gold, the whole card a link to `/log/<id>`. An
// uncertified track can never reach this slot, and the surface never says so — the register IS the
// claim (DESIGN.md's Unlit Rule).
//
// The placement carries the full instrument readout (The Readout Rule): the chip row — duration,
// then BPM, then key — and the release year on its metadata line beside the imprint, wherever the
// data exists. A missing chip is a data gap upstream, never a layout choice.
//
// ── LCP ──────────────────────────────────────────────────────────────────────────────────────
// This cover is the front door's largest contentful element. It fetches EAGERLY at high priority
// (`priority`, which `TrackArtwork` turns into `loading="eager" fetchpriority="high"`), and the route
// preloads this exact URL from its `head()` so the fetch starts before the parser reaches the tag.
// Every other cover on the page stays lazy: the signal only helps while it is scarce.
//
// `TrackArtwork` also carries the failed-cover contract — a third-party host that 404s or goes down
// degrades to the eclipse-gradient fallback rather than a broken-image glyph, including when the
// error fires before hydration.

import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { type TrackListItem } from "@fluncle/contracts";
import { GraphLink } from "@/components/graph-link";
import { TrackArtwork } from "@/components/track-artwork";
import { TrackChips } from "@/components/track-row";
import { formatDateLong } from "@/lib/format";
import { artistTitleLine } from "@/lib/log-prose";
import { albumCoverAtSize } from "@/lib/media";

/** The cover rung for the lead's slot: it renders around 15rem, so a 2× screen wants ~480 device px. */
const LEAD_COVER_SIZE = "large" as const;

export function FrontDoorLead({ lead }: { lead: TrackListItem }): ReactNode {
  const line = artistTitleLine(lead);
  const releaseYear = lead.releaseDate?.slice(0, 4);

  return (
    <article className="fd-lead">
      <TrackArtwork
        alt=""
        className="fd-lead-cover"
        priority
        src={albumCoverAtSize(lead.albumImageUrl, LEAD_COVER_SIZE)}
      />
      <div className="fd-lead-body">
        {lead.logId ? <p className="fd-lead-coordinate">{lead.logId}</p> : undefined}
        <p className="fd-lead-line">{line}</p>
        {/* The imprint line, the same one the Track Row prints: the label as a graph link when the
            imprint has a page, plain text when it does not, with the release year beside it and
            never inside the link (a year names no entity). A missing piece drops — an honest data
            gap, never a layout choice (The Readout Rule). */}
        {lead.label || releaseYear ? (
          <p className="fd-lead-imprint">
            {lead.label && lead.labelSlug ? (
              <GraphLink kind="label" slug={lead.labelSlug}>
                {lead.label}
              </GraphLink>
            ) : (
              lead.label
            )}
            {releaseYear ? (lead.label ? ` (${releaseYear})` : releaseYear) : ""}
          </p>
        ) : undefined}
        {lead.note ? <p className="fd-lead-note">{lead.note}</p> : undefined}
        <TrackChips
          bpm={lead.bpm}
          className="fd-lead-chips"
          durationMs={lead.durationMs}
          musicalKey={lead.key}
        />
        <p className="fd-lead-found">
          Found <time dateTime={lead.addedAt}>{formatDateLong(lead.addedAt)}</time>
        </p>
        {lead.logId ? (
          <Link
            aria-label={`Read the log entry for ${line}`}
            className="fd-lead-open"
            params={{ logId: lead.logId }}
            to="/log/$logId"
          >
            Read the log entry
          </Link>
        ) : (
          // A finding with no coordinate has no log page to open. It still leads honestly: the
          // listen link is the only destination that exists, so that is the one offered.
          <a
            aria-label={`Listen to ${line} on Spotify`}
            className="fd-lead-open"
            href={lead.spotifyUrl}
            rel="noreferrer"
            target="_blank"
          >
            Listen on Spotify
          </a>
        )}
      </div>
    </article>
  );
}
