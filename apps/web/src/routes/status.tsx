import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { cronSurfaces, type CronSchedule } from "@fluncle/registry";
import { siteUrl } from "@/lib/fluncle-links";
import { elapsedShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  estimateNextRun,
  formatCadence,
  formatCountdown,
  formatZonedTime,
  nextScheduledRun,
} from "@/lib/next-run";
import { Badge } from "@fluncle/ui/components/badge";
import {
  getRecentStatusEvents,
  getServiceCheckSamples,
  getServiceStatuses,
  type ServiceCheckSampleRow,
  type ServiceHealthStatus,
  type ServiceStatusRow,
  type StatusEventRow,
} from "@/lib/server/status";
import { SELF_POSTED_AUTOMATION_ORDER } from "@/lib/status-services";

const CRON_SURFACES = cronSurfaces();
export const CRON_ORDER = CRON_SURFACES.map((surface) => surface.name);

const CRON_CADENCE_MS: Record<string, number> = {};

const CRON_SCHEDULE: Record<string, CronSchedule> = {};

for (const surface of CRON_SURFACES) {
  const cadence = surface.probeConfig?.cadenceMs;
  const schedule = surface.probeConfig?.schedule;

  if (cadence !== undefined) {
    CRON_CADENCE_MS[surface.name] = cadence;
  }

  if (schedule !== undefined) {
    CRON_SCHEDULE[surface.name] = schedule;
  }
}

export { SELF_POSTED_AUTOMATION_ORDER } from "@/lib/status-services";
const AUTOMATION_ORDER = [...SELF_POSTED_AUTOMATION_ORDER, ...CRON_ORDER];
const AUTOMATION_SERVICE_IDS = new Set(AUTOMATION_ORDER);

const OPS_AUTOMATION_IDS = new Set([
  "cron.audit",
  "cron.audit-review",
  "cron.backup",
  "cron.healthcheck",
  "cron.pipeline-watch",
  "cron.reach",

  "cron.reconcile-hub-counts",
  "cron.sentry-triage",
  "self-deploy",
  "self-deploy-sonar",
  "self-deploy-ssh",
]);

export const SERVICE_ORDER = [
  "web",
  "db",
  "r2",
  "sonar",
  "dns",
  "ssh",
  "onion",
  "hermes",
  "render-box",
  "disk",

  "sweep-errors",
];

const REGISTRY_STATUS_TITLES = new Map<string, string>(
  CRON_SURFACES.flatMap((surface) =>
    surface.title === undefined ? [] : [[surface.name, surface.title] as const],
  ),
);
const REGISTRY_STATUS_DESCRIPTIONS = new Map<string, string>(
  CRON_SURFACES.flatMap((surface) =>
    surface.statusDescription === undefined
      ? []
      : [[surface.name, surface.statusDescription] as const],
  ),
);

export const INFRA_SERVICE_LABELS: Record<string, string> = {
  db: "Database",
  disk: "Disk headroom",
  dns: "DNS",
  hermes: "Hermes agent",
  onion: "Tor onion",
  r2: "Media storage",
  "render-box": "Render box",
  "self-deploy": "Self-deploy",
  "self-deploy-sonar": "Self-deploy (sonar)",
  "self-deploy-ssh": "Self-deploy (SSH)",
  sonar: "Sonar",
  ssh: "SSH terminal",
  "sweep-errors": "Sweep errors",
  web: "Web",
};

export const INFRA_SERVICE_SUBTITLES: Record<string, string> = {
  db: "the archive's persistence",
  disk: "the agent box's free space",
  dns: "dig.fluncle.com",
  hermes: "the agent box that runs the automation",
  onion: "the archive over Tor",
  r2: "found.fluncle.com",
  "render-box": "the scale-to-zero box's reachability",
  "self-deploy": "the agent box rebuilds itself when its tools update",
  "self-deploy-sonar": "the engine pulls a new build when apps/sonar changes",
  "self-deploy-ssh": "the rave terminal rebuilds itself when apps/ssh changes",
  sonar: "the sonic-similarity engine",
  ssh: "rave.fluncle.com",
  "sweep-errors": "errors the automation logs while still reporting ok",
  web: "www.fluncle.com",
};

export function serviceLabel(service: string): string {
  const registryTitle = REGISTRY_STATUS_TITLES.get(service);
  if (registryTitle) {
    return registryTitle;
  }

  if (INFRA_SERVICE_LABELS[service]) {
    return INFRA_SERVICE_LABELS[service];
  }

  return service.startsWith("cron.") ? service.slice("cron.".length) : service;
}

export function serviceSubtitle(service: string): string | undefined {
  return REGISTRY_STATUS_DESCRIPTIONS.get(service) ?? INFRA_SERVICE_SUBTITLES[service];
}

const SECTION_HEADING_CLASS =
  "mb-4 border-b border-border pb-2 text-sm font-semibold uppercase tracking-wide text-foreground";

type StatusPageData = {
  events: StatusEventRow[];
  now: string;
  samples: Record<string, ServiceCheckSampleRow[]>;
  services: ServiceStatusRow[];
};

const fetchStatus = createServerFn({ method: "GET" }).handler(async (): Promise<StatusPageData> => {
  const [services, events, samples] = await Promise.all([
    getServiceStatuses(),
    getRecentStatusEvents(15),
    getServiceCheckSamples(),
  ]);

  return { events, now: new Date().toISOString(), samples, services };
});

const title = "System status · Fluncle";
const description = "The live health of Fluncle's services: web, database, storage, and the rest.";

function statusHead() {
  return {
    links: [{ href: `${siteUrl}/status`, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/status`, property: "og:url" },
    ],
  };
}

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/status")({
  loader: () => fetchStatus(),
  head: statusHead,
  component: StatusPage,
});

const STATUS_LABEL: Record<ServiceHealthStatus, string> = {
  degraded: "Degraded",
  down: "Down",
  ok: "Operational",
};

function StatusIndicator({ status }: { status: ServiceHealthStatus }) {
  if (status === "down") {
    return <Badge variant="destructive">{STATUS_LABEL.down}</Badge>;
  }

  if (status === "degraded") {
    return (
      <Badge className="border-transparent bg-[var(--eclipse-glow)]/15 text-[var(--eclipse-glow)]">
        {STATUS_LABEL.degraded}
      </Badge>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span className="relative flex size-1.5">
        <span
          aria-hidden
          className="absolute inline-flex size-full rounded-full bg-primary opacity-60 motion-safe:animate-ping"
        />
        <span aria-hidden className="relative inline-flex size-1.5 rounded-full bg-primary" />
      </span>
      {STATUS_LABEL.ok}
    </span>
  );
}

function humanizeSince(sinceIso: string, nowIso: string, status: ServiceHealthStatus): string {
  const verb = status === "down" ? "down" : status === "degraded" ? "degraded" : "up";
  const elapsedMs = new Date(nowIso).getTime() - new Date(sinceIso).getTime();

  if (!Number.isFinite(elapsedMs) || elapsedMs < 60_000) {
    return `${verb} just now`;
  }

  const minutes = Math.floor(elapsedMs / 60_000);

  if (minutes < 60) {
    return `${verb} ${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${verb} ${hours}h`;
  }

  const days = Math.floor(hours / 24);

  return `${verb} ${days}d`;
}

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  month: "short",
  timeZone: "UTC",
});

function formatCheckedAt(value: string): string {
  return `${timeFormatter.format(new Date(value))} UTC`;
}

export function serviceCheckedAtLabel(value: string): string {
  return `as of ${formatCheckedAt(value)}`;
}

const BAR_SLOTS = 90;

function tickClass(status: ServiceHealthStatus | null): string {
  if (status === "down") {
    return "bg-destructive";
  }
  if (status === "degraded") {
    return "bg-[var(--eclipse-glow)]";
  }
  if (status === "ok") {
    return "bg-muted-foreground/35";
  }
  return "bg-muted-foreground/10";
}

function UptimeBar({
  samples,
  status,
}: {
  samples: ServiceCheckSampleRow[];
  status: ServiceHealthStatus;
}) {
  const recent = samples.slice(-BAR_SLOTS);
  const padCount = Math.max(0, BAR_SLOTS - recent.length);
  const slots = [
    ...Array.from({ length: padCount }, (_, index) => ({ key: `pad-${index}`, status: null })),
    ...recent.map((sample, index) => ({ key: `${sample.at}-${index}`, status: sample.status })),
  ];
  const liveKey = slots[slots.length - 1]?.key;

  return (
    <div aria-hidden className="flex h-8 w-full items-stretch gap-px">
      {slots.map((slot) => {
        const isLive = slot.key === liveKey && slot.status !== null;
        const liveClass = isLive
          ? status === "ok"
            ? "bg-primary motion-safe:animate-pulse"
            : "motion-safe:animate-pulse"
          : "";

        return (
          <span
            className={`min-w-px flex-1 rounded-[1px] ${tickClass(slot.status)} ${liveClass}`}
            key={slot.key}
          />
        );
      })}
    </div>
  );
}

function uptimePercent(samples: ServiceCheckSampleRow[]): number | null {
  if (samples.length === 0) {
    return null;
  }

  const ok = samples.filter((sample) => sample.status === "ok").length;

  return Math.round((ok / samples.length) * 1000) / 10;
}

function sortByOrder(services: ServiceStatusRow[], order: string[]): ServiceStatusRow[] {
  return [...services].sort((a, b) => {
    const ai = order.indexOf(a.service);
    const bi = order.indexOf(b.service);
    const ar = ai === -1 ? order.length : ai;
    const br = bi === -1 ? order.length : bi;

    return ar === br ? a.service.localeCompare(b.service) : ar - br;
  });
}

function groupServices(services: ServiceStatusRow[]): {
  core: ServiceStatusRow[];
  opsCrons: ServiceStatusRow[];
  trackCrons: ServiceStatusRow[];
} {
  const core: ServiceStatusRow[] = [];
  const opsCrons: ServiceStatusRow[] = [];
  const trackCrons: ServiceStatusRow[] = [];

  for (const service of services) {
    if (!AUTOMATION_SERVICE_IDS.has(service.service)) {
      core.push(service);
    } else if (OPS_AUTOMATION_IDS.has(service.service)) {
      opsCrons.push(service);
    } else {
      trackCrons.push(service);
    }
  }

  return {
    core: sortByOrder(core, SERVICE_ORDER),
    opsCrons: sortByOrder(opsCrons, AUTOMATION_ORDER),
    trackCrons: sortByOrder(trackCrons, AUTOMATION_ORDER),
  };
}

function overallHeadline(services: ServiceStatusRow[]): string {
  if (services.length === 0) {
    return "No services reporting yet";
  }

  if (services.some((s) => s.status === "down")) {
    return "Some services are down";
  }

  if (services.some((s) => s.status === "degraded")) {
    return "Some services are degraded";
  }

  return "All systems nominal";
}

export function ServiceRow({
  now,
  samples,
  service,
}: {
  now: string;
  samples: ServiceCheckSampleRow[];
  service: ServiceStatusRow;
}) {
  const pct = uptimePercent(samples);
  const subtitle = serviceSubtitle(service.service);
  const oldest = samples[0];
  const statusAge =
    pct !== null
      ? `${pct}% uptime`
      : service.since === null
        ? null
        : humanizeSince(service.since, now, service.status);

  const cadence = CRON_CADENCE_MS[service.service];
  const schedule = CRON_SCHEDULE[service.service];
  const nextRun =
    (schedule ? nextScheduledRun(schedule, now) : null) ??
    (cadence === undefined || service.checked_at === null
      ? null
      : estimateNextRun(service.checked_at, cadence, now));

  return (
    <article className="py-6 first:pt-0">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-base font-medium text-foreground">{serviceLabel(service.service)}</h3>
        <StatusIndicator status={service.status} />
      </div>

      {subtitle || service.message ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {subtitle}
          {subtitle && service.message ? " · " : ""}
          {service.message}
        </p>
      ) : undefined}

      {service.checked_at !== null ? (
        <p className="mt-1 text-xs text-muted-foreground tabular-nums">
          <time dateTime={service.checked_at}>{serviceCheckedAtLabel(service.checked_at)}</time>
        </p>
      ) : undefined}

      {nextRun && cadence !== undefined ? (
        <p className="mt-1 text-xs text-muted-foreground tabular-nums">
          every {formatCadence(cadence)} · next ≈{" "}
          {schedule ? formatZonedTime(nextRun, schedule.tz) : formatCheckedAt(nextRun)}{" "}
          <span className="text-foreground/80">
            ({schedule ? `${formatCheckedAt(nextRun)}, ` : ""}
            {formatCountdown(nextRun, now)})
          </span>
        </p>
      ) : undefined}

      <div className="mt-4">
        <UptimeBar samples={samples} status={service.status} />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{oldest ? `${elapsedShort(oldest.at, now)} ago` : "no history yet"}</span>
        {statusAge !== null ? <span className="text-foreground/80">{statusAge}</span> : undefined}
        <span>now</span>
      </div>
    </article>
  );
}

function ServiceGroup({
  label,
  now,
  rows,
  samples,
}: {
  label: string;
  now: string;
  rows: ServiceStatusRow[];
  samples: Record<string, ServiceCheckSampleRow[]>;
}) {
  if (rows.length === 0) {
    return undefined;
  }

  return (
    <section aria-label={label}>
      <h2 className={cn(SECTION_HEADING_CLASS, "flex items-baseline justify-between")}>
        {label}
        <span className="text-xs font-normal normal-case tracking-normal text-muted-foreground">
          {rows.length}
        </span>
      </h2>
      <div className="divide-y divide-border/50">
        {rows.map((service) => (
          <ServiceRow
            key={service.service}
            now={now}
            samples={samples[service.service] ?? []}
            service={service}
          />
        ))}
      </div>
    </section>
  );
}

function StatusPage() {
  const { events, now, samples, services } = Route.useLoaderData();
  const { core, opsCrons, trackCrons } = groupServices(services);
  const reporting = [...core, ...trackCrons, ...opsCrons];

  return (
    <main className="log-plate-stage">
      <article className="log-plate text-foreground">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">System status</h1>
          <p className="text-sm text-muted-foreground">{overallHeadline(reporting)}</p>
        </header>

        {reporting.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing's reported in from the services yet. Check back in a moment.
          </p>
        ) : (
          <div className="space-y-8">
            <ServiceGroup label="Services" now={now} rows={core} samples={samples} />
            <ServiceGroup label="Track automation" now={now} rows={trackCrons} samples={samples} />
            <ServiceGroup label="Ops automation" now={now} rows={opsCrons} samples={samples} />
          </div>
        )}

        {events.length > 0 ? (
          <section aria-label="Recent events">
            <h2 className={SECTION_HEADING_CLASS}>Recent events</h2>
            <ul className="space-y-2">
              {events.map((event) => (
                <li className="flex items-center justify-between gap-3 text-sm" key={event.id}>
                  <div className="flex min-w-0 items-center gap-2">
                    <StatusIndicator status={event.status} />
                    <span className="truncate">
                      <span className="text-foreground">{serviceLabel(event.service)}</span>
                      {event.message ? (
                        <span className="text-muted-foreground"> — {event.message}</span>
                      ) : undefined}
                    </span>
                  </div>
                  <time className="shrink-0 text-xs text-muted-foreground" dateTime={event.at}>
                    {formatCheckedAt(event.at)}
                  </time>
                </li>
              ))}
            </ul>
          </section>
        ) : undefined}
      </article>
    </main>
  );
}
