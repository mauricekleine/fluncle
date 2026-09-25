import { CassetteTapeIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ComponentType } from "react";
import { siSoundcloud } from "simple-icons";
import { ensureAdmin } from "@/lib/admin-guard";
import { AdminShell } from "@/components/admin/admin-shell";
import { ObjectLead, ObjectList, ObjectRow } from "@/components/admin/object-row";
import { BrandIcon } from "@/components/brand-icon";
import { MixcloudIcon, YoutubeIcon } from "@/components/platform-icons";
import { Badge } from "@fluncle/ui/components/badge";
import { formatAlbumDuration, formatDate } from "@/lib/format";
import { type MixtapeDTO, mixtapeCoverUrl, mixtapeDisplayTitle } from "@/lib/mixtapes";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { listMixtapes } from "@/lib/server/mixtapes";

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
