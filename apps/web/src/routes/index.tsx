import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useMemo } from "react";
import { DiscoveryPlayableList } from "@/components/discovery-row";
import { FrontDoorBrowse } from "@/components/front-door/browse";
import { FrontDoorFindings } from "@/components/front-door/findings";
import { FrontDoorLead } from "@/components/front-door/lead";
import { FrontDoorReleases } from "@/components/front-door/releases";
import { FrontDoorSearch } from "@/components/front-door/search-entry";
import { FrontDoorSection } from "@/components/front-door/section";
import { LiveBanner } from "@/components/home/live-banner";
import { printConsoleGreeting } from "@/lib/console-greeting";
import { findingToDiscoveryTrack } from "@/lib/discovery-tracks";
import { fluncleEntityId, fluncleWebsiteId, siteUrl } from "@/lib/fluncle-links";
import { frontDoorCount } from "@/lib/front-door";
import { fluncleDescription } from "@/lib/identity";
import { jsonLdScript } from "@/lib/json-ld";
import { logPageUrl } from "@/lib/log-schema";
import { albumCoverAtSize } from "@/lib/media";
import { registerWebMcpTools } from "@/lib/webmcp";

const fetchFrontDoorData = createServerFn({ method: "GET" }).handler(async () => {
  const { loadFrontDoorData } = await import("./-front-door-data");

  return loadFrontDoorData();
});

type FrontDoorSearch = { story?: string };

function leadCoverUrl(albumImageUrl: string | undefined): string | undefined {
  return albumCoverAtSize(albumImageUrl, "large");
}

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): FrontDoorSearch => ({
    story: typeof search.story === "string" && search.story.length > 0 ? search.story : undefined,
  }),

  beforeLoad: ({ search }) => {
    if (search.story) {
      throw redirect({ params: { logId: search.story }, statusCode: 301, to: "/log/$logId" });
    }
  },
  loader: () => fetchFrontDoorData(),
  head: ({ loaderData }) => ({
    links: [
      { href: `${siteUrl}/`, rel: "canonical" },

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

    scripts: [
      jsonLdScript({
        "@context": "https://schema.org",
        "@id": fluncleWebsiteId,
        "@type": "WebSite",
        creator: {
          "@id": "https://www.mauricekleine.com/#maurice",
          "@type": "Person",
          name: "Maurice Kleine",
          url: "https://www.mauricekleine.com/",
        },
        description: fluncleDescription,
        name: "Fluncle",
        publisher: { "@id": fluncleEntityId },
        url: `${siteUrl}/`,
      }),

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

type SchemaFinding = { artists: string[]; logId?: string; title: string };

function frontDoorFindings(
  loaderData: { findings: SchemaFinding[]; lead?: SchemaFinding } | undefined,
): SchemaFinding[] {
  if (!loaderData) {
    return [];
  }

  return [...(loaderData.lead ? [loaderData.lead] : []), ...loaderData.findings];
}

function FrontDoorPage() {
  const { counts, findings, findingsTotal, lead, live, releaseWindowDays, releases } =
    Route.useLoaderData();

  const leadAndFindings = useMemo(
    () =>
      [...(lead ? [lead] : []), ...findings.filter((finding) => finding.logId)]
        .filter(
          (finding, index, all) =>
            all.findIndex((other) => other.trackId === finding.trackId) === index,
        )
        .map((finding) => findingToDiscoveryTrack(finding)),
    [findings, lead],
  );

  useEffect(() => {
    printConsoleGreeting();

    registerWebMcpTools();
  }, []);

  return (
    <main className="fd-page">
      <LiveBanner live={live} />

      <article className="fd-plate">
        <header className="fd-masthead">
          <h1 className="fd-nameplate">Fluncle&apos;s Findings</h1>
          <p className="fd-standfirst">
            Now and then a tune lands and my knees go before I do. That one gets logged, and it is
            in here with everything else I brought back. Start wherever you like, fam.
          </p>
        </header>

        <FrontDoorSection id="fd-search" quietTitle title="Search the archive">
          <FrontDoorSearch />
        </FrontDoorSection>

        <DiscoveryPlayableList tracks={leadAndFindings}>
          {lead ? (
            <FrontDoorSection id="fd-lead" title="What I'm on right now">
              <FrontDoorLead lead={lead} />
            </FrontDoorSection>
          ) : undefined}

          <FrontDoorSection
            id="fd-findings"
            intro="I rewound every banger here before I logged it. Freshest at the front, so take your pick, fam."
            link={
              findingsTotal > 0
                ? {
                    label: `All ${frontDoorCount(findingsTotal, "finding", "findings")}`,
                    to: "/findings",
                  }
                : { label: "The whole log", to: "/findings" }
            }
            title="Latest findings"
          >
            <FrontDoorFindings findings={findings} />
          </FrontDoorSection>
        </DiscoveryPlayableList>

        <FrontDoorSection
          id="fd-fresh"
          intro={`Still warm off the press: the last ${releaseWindowDays} days of drum & bass. Get your ears on it early.`}
          link={{ label: "All new releases", to: "/fresh" }}
          title="Fresh"
        >
          <FrontDoorReleases releases={releases} windowDays={releaseWindowDays} />
        </FrontDoorSection>

        <FrontDoorSection
          id="fd-browse"
          intro="I dig through these crates most nights, hunting whatever makes my nose scrunch. They are open, have a rummage."
          title="Dig through the crates"
        >
          <FrontDoorBrowse counts={counts} />
        </FrontDoorSection>
      </article>
    </main>
  );
}
