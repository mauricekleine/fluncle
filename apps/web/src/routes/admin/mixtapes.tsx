import { CassetteTapeIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ComponentType } from "react";
import { siSoundcloud } from "simple-icons";
import { AdminShell } from "@/components/admin/admin-shell";
import { ObjectLead, ObjectList, ObjectRow } from "@/components/admin/object-row";
import { BrandIcon } from "@/components/brand-icon";
import { MixcloudIcon, YoutubeIcon } from "@/components/platform-icons";
import { Badge } from "@fluncle/ui/components/badge";
import { formatAlbumDuration, formatDate } from "@/lib/format";
import { type MixtapeDTO, mixtapeCoverUrl, mixtapeDisplayTitle } from "@/lib/mixtapes";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { listMixtapes } from "@/lib/server/mixtapes";

// The Mixtapes index — every MINTED mixtape (published + still-distributing), Fluncle's own DJ
// sets. A mixtape is a spine-native object: born only via `promote_recording` (never authored
// here), it carries an `F`-marked Log ID, a tracklist frozen from its take, an on-the-fly cover,
// and outbound links to wherever it was distributed (YouTube video, Mixcloud audio). This page is
// that object's admin HOME — before ADM-02 it was a redirect-only stub to /admin/plans, so a
// published mixtape (including Mixtape #1) had nowhere to live in the UI.
//
// Read SERVER-SIDE in-process (a createServerFn calling the `listMixtapes` helper — the same read
// the `list_mixtapes_admin` op wraps), with `includeUnpublished` so a distributing mixtape shows
// while its assets upload, and `hydrateMembers` so each row's tracklist count is honest. Reads
// only — the distribution control plane (YouTube/Mixcloud finalize, cues, announce) lives on the
// operator-tier oRPC ops the fluncle-mixtapes skill drives.

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

// Every minted mixtape, newest first (the helper orders by added/created desc). Server-side:
// in-process, no HTTP, no CORS.
const fetchMixtapes = createServerFn({ method: "GET" }).handler(async (): Promise<MixtapeDTO[]> => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  return listMixtapes({ hydrateMembers: true, includeUnpublished: true });
});

export const Route = createFileRoute("/admin/mixtapes")({
  beforeLoad: () => ensureAdmin(),
  component: MixtapesPage,
  loader: () => fetchMixtapes(),
});

function MixtapesPage() {
  const initial = Route.useLoaderData();
  const { data: mixtapes } = useQuery<MixtapeDTO[]>({
    initialData: initial,
    queryFn: () => fetchMixtapes(),
    queryKey: ["admin", "mixtapes"],
    refetchOnWindowFocus: true,
  });

  return (
    <AdminShell
      subtitle={`${mixtapes.length} ${mixtapes.length === 1 ? "mixtape" : "mixtapes"}`}
      title="Mixtapes"
    >
      <div className="p-4 sm:p-5">
        <MixtapesIndex mixtapes={mixtapes} />
      </div>
    </AdminShell>
  );
}

function MixtapesIndex({ mixtapes }: { mixtapes: MixtapeDTO[] }) {
  if (mixtapes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <CassetteTapeIcon aria-hidden="true" className="size-7 text-muted-foreground/70" />
        <p className="font-medium">No mixtapes yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          A mixtape is minted when you promote a captured take. Record a set, promote it in the
          Studio, and it lands here.
        </p>
      </div>
    );
  }

  return (
    <ObjectList>
      {mixtapes.map((mixtape) => (
        <MixtapeRow key={mixtape.id ?? mixtape.logId} mixtape={mixtape} />
      ))}
    </ObjectList>
  );
}

// One minted mixtape as an Object Row: cover-led (its on-the-fly cover links to the public
// /log page), the `#N — title`, its `F`-marked coordinate in the Log-ID face, the
// status/date/duration line, and the outbound distribution links to wherever it went
// (YouTube, Mixcloud, SoundCloud).
function MixtapeRow({ mixtape }: { mixtape: MixtapeDTO }) {
  const { logId } = mixtape;
  const logHref = logId ? `/log/${encodeURIComponent(logId)}` : undefined;
  const dated = mixtape.publishedAt ?? mixtape.recordedAt;
  const displayTitle = mixtapeDisplayTitle(mixtape.title);
  const showSequence =
    Boolean(mixtape.sequenceNumber) && !displayTitle.includes(`#${mixtape.sequenceNumber}`);

  return (
    <ObjectRow trailing={<DistributionLinks mixtape={mixtape} />}>
      <ObjectLead
        coordinate={logId ? `fluncle://${logId}` : undefined}
        coordinateHref={logHref}
        leading={
          logId && logHref ? (
            <a
              aria-hidden="true"
              className="shrink-0 focus-visible:outline-2 focus-visible:outline-ring"
              href={logHref}
              tabIndex={-1}
            >
              <img
                alt=""
                className="size-11 rounded-md border border-border object-cover"
                height={44}
                loading="lazy"
                src={mixtapeCoverUrl(logId, "thumb")}
                width={44}
              />
            </a>
          ) : (
            <div className="track-artwork-fallback size-11 shrink-0 rounded-md border border-border" />
          )
        }
        subtitle={
          <>
            <Badge variant={mixtape.status === "published" ? "secondary" : "outline"}>
              {mixtape.status === "published" ? "published" : "distributing"}
            </Badge>
            {dated ? <span>{formatDate(dated)}</span> : null}
            {mixtape.durationMs ? <span>· {formatAlbumDuration(mixtape.durationMs)}</span> : null}
            <span>
              · {mixtape.memberCount} banger{mixtape.memberCount === 1 ? "" : "s"}
            </span>
          </>
        }
        title={
          <>
            {showSequence ? (
              <span className="text-muted-foreground tabular-nums">#{mixtape.sequenceNumber} </span>
            ) : null}
            {displayTitle}
          </>
        }
        titleHref={logHref}
      />
    </ObjectRow>
  );
}

// The platforms a mixtape reads its distribution from — the video on YouTube, the audio on
// Mixcloud (and SoundCloud for the legacy tapes). Each present `externalUrls` entry renders as a
// quiet outbound brand-mark link, so the operator can jump straight to where a mixtape lives.
const DIST_PLATFORMS: {
  Icon: ComponentType<{ className?: string }>;
  key: "youtube" | "mixcloud" | "soundcloud";
  label: string;
}[] = [
  { Icon: YoutubeIcon, key: "youtube", label: "YouTube" },
  { Icon: MixcloudIcon, key: "mixcloud", label: "Mixcloud" },
  {
    Icon: (props) => <BrandIcon icon={siSoundcloud} {...props} />,
    key: "soundcloud",
    label: "SoundCloud",
  },
];

function DistributionLinks({ mixtape }: { mixtape: MixtapeDTO }) {
  const links = DIST_PLATFORMS.flatMap((platform) => {
    const url = mixtape.externalUrls[platform.key];

    return url ? [{ ...platform, url }] : [];
  });

  if (links.length === 0) {
    return null;
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      {links.map(({ Icon, key, label, url }) => (
        <a
          aria-label={`${mixtapeDisplayTitle(mixtape.title)} on ${label}`}
          className="inline-flex size-9 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          href={url}
          key={key}
          rel="noreferrer"
          target="_blank"
          title={label}
        >
          <Icon className="size-4" />
        </a>
      ))}
    </div>
  );
}
