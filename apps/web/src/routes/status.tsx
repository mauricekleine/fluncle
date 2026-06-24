import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { siteUrl } from "@/lib/fluncle-links";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getRecentStatusEvents,
  getServiceStatuses,
  type ServiceHealthStatus,
  type ServiceStatusRow,
  type StatusEventRow,
} from "@/lib/server/status";

// The PUBLIC service-health status dashboard. No admin guard — anyone can read
// the current state of Fluncle's services. A Hermes cron probes each service and
// POSTs a snapshot to the agent-tier `record_health` op (POST /admin/health);
// this page renders ONLY what that snapshot persisted: service name, status, a
// short message, latency, and the since/checked timestamps. Never an internal IP,
// hostname, op-path, or raw error body — that public-safety constraint is enforced
// at the write (the probe + the `record_health` handler), and this surface simply
// never reaches for anything else.

// The deliberate, fixed display order. Known services lead in this sequence; any
// service the snapshot reports that isn't named here is appended (alphabetically),
// so a newly-probed service surfaces without a code change.
const SERVICE_ORDER = ["web", "db", "r2", "dns", "ssh", "onion", "hermes", "render-box"];

// A human label per known service id (falls back to the raw id for an unknown one).
const SERVICE_LABELS: Record<string, string> = {
  db: "Database",
  dns: "DNS",
  hermes: "Hermes agent",
  onion: "Tor onion",
  r2: "R2 storage",
  "render-box": "Render box",
  ssh: "SSH terminal",
  web: "Web",
};

type StatusPageData = {
  events: StatusEventRow[];
  now: string;
  services: ServiceStatusRow[];
};

const fetchStatus = createServerFn({ method: "GET" }).handler(async (): Promise<StatusPageData> => {
  const [services, events] = await Promise.all([getServiceStatuses(), getRecentStatusEvents(15)]);

  // The reference instant for every relative-time render, fixed in the loader so
  // the server-rendered "up 3d" matches hydration exactly (no client clock drift).
  return { events, now: new Date().toISOString(), services };
});

const title = "System Status · Fluncle";
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

// Route options follow TanStack's create-route-property-order (each step feeds the
// next's inferred types), which isn't alphabetical — so sort-keys is off here.
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

// The canon mapping (DESIGN.md, the Nostalgic Cosmos has no green):
//   ok       → Eclipse Gold (primary) — the calm "all good" accent
//   degraded → Eclipse Glow (#ffd057)  — the warm amber/caution
//   down     → Re-entry Red            — errors only, the `destructive` variant
function StatusBadge({ status }: { status: ServiceHealthStatus }) {
  if (status === "down") {
    return <Badge variant="destructive">{STATUS_LABEL.down}</Badge>;
  }

  if (status === "degraded") {
    // Eclipse Glow as a quiet caution chip (the design system carries no amber
    // badge variant, so the token is applied inline, dark-only by construction).
    return (
      <Badge className="border-transparent bg-[#ffd057]/15 text-[#ffd057]">
        {STATUS_LABEL.degraded}
      </Badge>
    );
  }

  return <Badge>{STATUS_LABEL.ok}</Badge>;
}

// "up 3d" / "down 12m" / "ok 5h" — the elapsed time since the CURRENT status
// began, with the verb tuned to the status. Whole-unit and quiet (VOICE.md keeps
// the tabular register terse); a fresh transition reads "just now".
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

// A fixed, locale-stable "Jun 4, 14:32 UTC" for the last-checked / event times, so
// the server render matches hydration (the @/lib/format precedent).
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

function serviceLabel(service: string): string {
  return SERVICE_LABELS[service] ?? service;
}

// Sort by the fixed SERVICE_ORDER; an unranked (unknown) service sorts after every
// ranked one, then alphabetically among themselves.
function sortServices(services: ServiceStatusRow[]): ServiceStatusRow[] {
  return [...services].sort((a, b) => {
    const ai = SERVICE_ORDER.indexOf(a.service);
    const bi = SERVICE_ORDER.indexOf(b.service);
    const ar = ai === -1 ? SERVICE_ORDER.length : ai;
    const br = bi === -1 ? SERVICE_ORDER.length : bi;

    return ar === br ? a.service.localeCompare(b.service) : ar - br;
  });
}

// The overall headline: down beats degraded beats all-operational.
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

  return "All systems operational";
}

function StatusPage() {
  const { events, now, services } = Route.useLoaderData();
  const ordered = sortServices(services);

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12 text-foreground">
      <header className="mb-8">
        <h1 className="text-2xl font-medium">System status</h1>
        <p className="mt-1 text-sm text-muted-foreground">{overallHeadline(ordered)}</p>
      </header>

      {ordered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No service has reported in yet. Check back in a moment.
        </p>
      ) : (
        <section aria-label="Service health" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {ordered.map((service) => (
            <Card key={service.service} size="sm">
              <CardHeader className="flex-row items-start justify-between gap-2">
                <CardTitle>{serviceLabel(service.service)}</CardTitle>
                <StatusBadge status={service.status} />
              </CardHeader>
              <CardContent className="grid gap-1 text-sm">
                {service.message ? (
                  <p className="text-muted-foreground">{service.message}</p>
                ) : undefined}
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <dt className="sr-only">Uptime</dt>
                  <dd className="col-span-2 text-foreground">
                    {humanizeSince(service.since, now, service.status)}
                  </dd>
                  {service.latency_ms !== null ? (
                    <>
                      <dt>Latency</dt>
                      <dd>{service.latency_ms} ms</dd>
                    </>
                  ) : undefined}
                  <dt>Checked</dt>
                  <dd>
                    <time dateTime={service.checked_at}>{formatCheckedAt(service.checked_at)}</time>
                  </dd>
                </dl>
              </CardContent>
            </Card>
          ))}
        </section>
      )}

      {events.length > 0 ? (
        <section aria-label="Recent events" className="mt-10">
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">Recent events</h2>
          <ul className="divide-y divide-border rounded-lg ring-1 ring-border">
            {events.map((event) => (
              <li
                className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                key={event.id}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <StatusBadge status={event.status} />
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
    </main>
  );
}
