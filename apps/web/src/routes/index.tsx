import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import { FrontDoorBrowse } from "@/components/front-door/browse";
import { FrontDoorFindings } from "@/components/front-door/findings";
import { FrontDoorLead } from "@/components/front-door/lead";
import { FrontDoorReleases } from "@/components/front-door/releases";
import { FrontDoorSearch } from "@/components/front-door/search-entry";
import { FrontDoorSection } from "@/components/front-door/section";
import { LiveBanner } from "@/components/home/live-banner";
import { printConsoleGreeting } from "@/lib/console-greeting";
import { fluncleEntityId, fluncleWebsiteId, siteUrl } from "@/lib/fluncle-links";
import { findingsCount } from "@/lib/format";
import { fluncleDescription } from "@/lib/identity";
import { jsonLdScript } from "@/lib/json-ld";
import { logPageUrl } from "@/lib/log-schema";
import { albumCoverAtSize } from "@/lib/media";
import { registerWebMcpTools } from "@/lib/webmcp";

// `/` — THE FRONT DOOR.
//
// A stranger arrives here knowing nothing and typing nothing. The page's whole job is to be legible
// to that person in one deliberate scroll: search with real queries they can click, one finding
// placed and written about, a few more findings, what just came out, and the four familiar routes
// into the wider archive. Nothing on it requires an account, nothing gates behind an interaction,
// and nothing steps the reader through one record at a time. The governing direction, its
// refinement, and the transport model it explicitly rejects are recorded in PRODUCT.md ("The front
// door") and DESIGN.md §5 ("The Long Scroll").
//
// The archive front page this route used to be is whole and unchanged at `/findings` — the cover,
// the nameplate, the stories ring, the infinite feed. `/?story=` still resolves: it 301s to the
// standalone `/log/<id>` page the mask always displayed, so every shared link survives.
//
// ── THE AREA ─────────────────────────────────────────────────────────────────────────────────
// A LORE page (DESIGN.md's Three Areas): Fluncle is speaking, in first person, under the nameplate.
// The catalogue material it opens onto keeps its own register inside his voice — the browse counts
// are supersets and the release band never claims he found those records (VOICE.md's Found Rule).
//
// ── THE TWO REGISTERS ────────────────────────────────────────────────────────────────────────
// The broad archive and the selective findings are unmistakably related and never conflated, and the
// distinction is carried by PLACEMENT and LIGHT alone (DESIGN.md's Unlit Rule): findings sit high and
// lit with their coordinates, the wider archive sits below in the unlit register and in superset
// nouns. No band names a certification tier, and no row wears a badge.
//
// ── DATA ─────────────────────────────────────────────────────────────────────────────────────
// Every section renders from a live production primitive, composed in `./-front-door-data` (a
// testable pure function). A PUBLIC route, so it stops at loader + `useLoaderData` with no
// react-query (AGENTS.md): nothing here is live, and nothing paginates.

const fetchFrontDoorData = createServerFn({ method: "GET" }).handler(async () => {
  const { loadFrontDoorData } = await import("./-front-door-data");

  return loadFrontDoorData();
});

/**
 * The one search param `/` has ever carried: the Stories dialog's open Log ID, from the days when
 * the archive feed lived here. The viewer moved to `/findings` with the feed it steps through, so
 * this is now a REDIRECT ONLY — see `beforeLoad`.
 */
type FrontDoorSearch = { story?: string };

/**
 * The lead cover, at the exact rung the lead renders, for the `head()` preload. Returning the same
 * string the element asks for is what makes the preload a hit rather than a second download.
 */
function leadCoverUrl(albumImageUrl: string | undefined): string | undefined {
  return albumCoverAtSize(albumImageUrl, "large");
}

// Route options follow TanStack's create-route-property-order (each step feeds the
// next's inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): FrontDoorSearch => ({
    story: typeof search.story === "string" && search.story.length > 0 ? search.story : undefined,
  }),
  // `/?story=<logId>` was the masked URL the Stories viewer wrote while it lived on this route; the
  // mask DISPLAYED `/log/<logId>`, which is where a shared link already pointed. Anyone holding the
  // raw form gets a permanent redirect to that same standalone page rather than a front door with a
  // dialog it no longer owns. Bare `/` is untouched and still 200s.
  beforeLoad: ({ search }) => {
    if (search.story) {
      throw redirect({ params: { logId: search.story }, statusCode: 301, to: "/log/$logId" });
    }
  },
  loader: () => fetchFrontDoorData(),
  head: ({ loaderData }) => ({
    // The self-referencing canonical lives on each leaf: TanStack merges the root's and the leaf's
    // `links` without deduping by rel, so a canonical in __root.tsx would emit a duplicate on every
    // other page.
    links: [
      { href: `${siteUrl}/`, rel: "canonical" },
      // Preload the LEAD's cover — the front door's largest contentful element. Without this the
      // browser discovers it at Medium priority mid-parse; preloading at high priority lets the
      // fetch start immediately. The URL is the exact rung the element renders, so the two share
      // one entry in the cache rather than racing for two.
      ...(loaderData?.lead?.albumImageUrl
        ? [
            {
              as: "image",
              fetchPriority: "high" as const,
              href: leadCoverUrl(loaderData.lead.albumImageUrl),
              rel: "preload",
            },
          ]
        : []),
    ],
    // JSON-LD goes through `jsonLdScript`, which HTML-escapes the serialized payload before it
    // reaches the inline <script>'s `children` (rendered raw via dangerouslySetInnerHTML), so
    // untrusted Spotify titles/artists can't break out of the <script> (stored-XSS sink, security
    // review).
    scripts: [
      // The site-level entity block (no SearchAction: search is a dialog over the archive, not a
      // results page with a URL, and schema must mirror what the page actually does). It carries
      // the WebSite's own `@id` and is `publisher`ed BY the ONE canonical Fluncle node (`@id`,
      // declared on /about) — the front door (highest authority, hit first) points at the same
      // entity everything else does.
      jsonLdScript({
        "@context": "https://schema.org",
        "@id": fluncleWebsiteId,
        "@type": "WebSite",
        description: fluncleDescription,
        name: "Fluncle",
        publisher: { "@id": fluncleEntityId },
        url: `${siteUrl}/`,
      }),
      // What this page ACTUALLY shows: the findings it renders, as an ItemList riding a
      // CollectionPage (the `/fresh` hub shape). It describes the lead plus the band under it and
      // nothing else — never the whole archive, which would claim more than the page carries. The
      // full playlist of every finding is `MusicPlaylist` on `/findings`, where the feed lives.
      jsonLdScript({
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        description: fluncleDescription,
        mainEntity: {
          "@type": "ItemList",
          itemListElement: frontDoorFindings(loaderData).map((finding, index) => ({
            "@type": "ListItem",
            item: {
              "@type": "MusicRecording",
              byArtist: finding.artists.map((name) => ({ "@type": "MusicGroup", name })),
              genre: "Drum and Bass",
              name: finding.title,
              // Only a finding is ever given a fluncle.com URL, so the structured data can never
              // claim a certification that does not exist.
              ...(finding.logId ? { url: logPageUrl(finding.logId) } : {}),
            },
            position: index + 1,
          })),
          numberOfItems: frontDoorFindings(loaderData).length,
        },
        name: "Fluncle",
        url: `${siteUrl}/`,
      }),
    ],
  }),
  component: FrontDoorPage,
});

/** The findings the page renders, lead first — the exact set the ItemList above describes. */
function frontDoorFindings(
  loaderData:
    | {
        findings: { artists: string[]; logId?: string; title: string }[];
        lead?: { artists: string[]; logId?: string; title: string };
      }
    | undefined,
): { artists: string[]; logId?: string; title: string }[] {
  if (!loaderData) {
    return [];
  }

  return [...(loaderData.lead ? [loaderData.lead] : []), ...loaderData.findings];
}

function FrontDoorPage() {
  const { counts, findings, findingsTotal, lead, live, releaseWindowDays, releases } =
    Route.useLoaderData();

  useEffect(() => {
    // The wordmark + Telegram invite Fluncle prints for anyone who opens devtools.
    printConsoleGreeting();
    // WebMCP: hand agent-driving browsers the same controls humans get.
    registerWebMcpTools();
  }, []);

  return (
    <main className="fd-page">
      {/* The live-set callout — the one loud, ephemeral beat. Renders nothing unless Fluncle is on
          the decks (DESIGN.md's "The Live Exception"); it clears itself the moment the set ends. */}
      <LiveBanner live={live} />

      {/* ONE plate, long: the masthead and every band are printed FLAT on a single
          recovered logbook document. Glass does not stack on glass (The One Pane Rule),
          so no band carries a pane of its own. */}
      <article className="fd-plate">
        <header className="fd-masthead">
          <h1 className="fd-nameplate">Fluncle</h1>
          <p className="fd-tagline">Drum &amp; bass bangers from another dimension.</p>
          <p className="fd-standfirst">
            I go out, I find bangers, I log every find. Start wherever you like.
          </p>
        </header>

        <FrontDoorSection id="fd-search" title="Search the archive">
          <FrontDoorSearch />
        </FrontDoorSection>

        {lead ? (
          <FrontDoorSection id="fd-lead" title="What I'm on right now">
            <FrontDoorLead lead={lead} />
          </FrontDoorSection>
        ) : undefined}

        <FrontDoorSection
          id="fd-findings"
          intro="Tracks I heard, rewound, and logged. Newest first."
          link={
            findingsTotal > 0
              ? { label: `All ${findingsCount(findingsTotal)}`, to: "/findings" }
              : { label: "The whole log", to: "/findings" }
          }
          title="Fluncle's Findings"
        >
          <FrontDoorFindings findings={findings} />
        </FrontDoorSection>

        <FrontDoorSection
          id="fd-fresh"
          intro={`The newest drum & bass releases from the last ${releaseWindowDays} days.`}
          link={{ label: "All new releases", to: "/fresh" }}
          title="Fresh"
        >
          <FrontDoorReleases releases={releases} windowDays={releaseWindowDays} />
        </FrontDoorSection>

        <FrontDoorSection
          id="fd-browse"
          intro="Everything printed on the sleeve: who made it, what it came off, who pressed it. This is what I dig through."
          title="Browse"
        >
          <FrontDoorBrowse counts={counts} />
        </FrontDoorSection>
      </article>
    </main>
  );
}
