import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { cronSurfaces } from "@fluncle/registry";
import { siteUrl } from "@/lib/fluncle-links";
import { Badge } from "@/components/ui/badge";
import {
  getRecentStatusEvents,
  getServiceCheckSamples,
  getServiceStatuses,
  type ServiceCheckSampleRow,
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

// The on-box Hermes crons, in @fluncle/registry catalog order — the single source of
// truth for which crons exist + how they're ordered. The healthcheck cron POSTs one
// `service_status` row per cron (service id = the registry surface name, e.g.
// `cron.enrich`); this page reads that list back to render every humming system on its
// own row, grouped under an "Automation" heading. A cron added to the registry surfaces
// here automatically — no edit to this file.
const CRON_SURFACES = cronSurfaces();
const CRON_ORDER = CRON_SURFACES.map((surface) => surface.name);
const CRON_SERVICE_IDS = new Set(CRON_ORDER);

// The deliberate, fixed display order for the CORE (non-cron) services. They lead the
// page; the crons render after them under their own heading. Any service the snapshot
// reports that isn't named here (and isn't a cron) is appended alphabetically, so a
// newly-probed service surfaces without a code change.
const SERVICE_ORDER = ["web", "db", "r2", "dns", "ssh", "onion", "hermes", "render-box"];

// A human label per known service id (falls back to the raw id for an unknown one). The
// cron labels are keyed by their registry surface name; the fallback strips the `cron.`
// prefix, so an as-yet-unlabeled cron still reads cleanly.
const SERVICE_LABELS: Record<string, string> = {
  "cron.backfill": "Catalogue backfill",
  "cron.context-note": "Context notes",
  "cron.enrich": "Audio enrichment",
  "cron.healthcheck": "Healthcheck prober",
  "cron.newsletter": "Weekly newsletter",
  "cron.note": "Editorial notes",
  "cron.observation": "Audio observations",
  // Two DIFFERENT render signals (not the agent twice): `cron.render` is the
  // conductor cron's last-run freshness; `render-box` is the scale-to-zero box's
  // reachability. The labels make the distinction obvious.
  "cron.render": "Render cron",
  db: "Database",
  dns: "DNS",
  hermes: "Hermes agent",
  onion: "Tor onion",
  r2: "Media storage",
  "render-box": "Render box",
  ssh: "SSH terminal",
  web: "Web",
};

// A quiet one-line subtitle per service — the public domain it lives at, or a plain
// description of what it does. Public-safe (every domain here is already public; the
// descriptions name no internal host). Absent for an unknown service.
const SERVICE_SUBTITLES: Record<string, string> = {
  "cron.backfill": "repairs Discogs ids and Last.fm loves",
  "cron.context-note": "distills the facts behind each finding",
  "cron.enrich": "BPM, key, and the spectral fingerprint",
  "cron.healthcheck": "the prober behind this very page",
  "cron.newsletter": "drafts the Friday edition",
  "cron.note": "writes each finding's editorial note",
  "cron.observation": "Fluncle's spoken field observations",
  "cron.render": "the conductor's last run",
  db: "the archive's persistence",
  dns: "dig.fluncle.com",
  hermes: "the Discord chat agent",
  onion: "the archive over Tor",
  r2: "found.fluncle.com",
  "render-box": "the scale-to-zero box's reachability",
  ssh: "rave.fluncle.com",
  web: "www.fluncle.com",
};

// A label for a service id, with the cron fallback (strip `cron.`) baked in.
function serviceLabel(service: string): string {
  if (SERVICE_LABELS[service]) {
    return SERVICE_LABELS[service];
  }

  return service.startsWith("cron.") ? service.slice("cron.".length) : service;
}

function serviceSubtitle(service: string): string | undefined {
  return SERVICE_SUBTITLES[service];
}

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

  // The reference instant for every relative-time render, fixed in the loader so
  // the server-rendered "up 3d" matches hydration exactly (no client clock drift).
  return { events, now: new Date().toISOString(), samples, services };
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

// The canon mapping (DESIGN.md — the Nostalgic Cosmos has no green, and The One Sun
// Rule caps Eclipse Gold at ~10% of a view) — escalating by LOUDNESS so the eye lands
// on trouble, not on the calm (a grid of filled gold "ok" badges blew that budget):
//   ok       → a small Eclipse-Gold dot that gently pings (motion-safe), with a
//              quiet muted label. Healthy is the baseline, so it stays calm and
//              gold reads as a living signal, not wallpaper.
//   degraded → Eclipse Glow (#ffd057) filled chip — the warm amber caution.
//   down     → Re-entry Red filled chip — the `destructive` variant, errors only.
function StatusIndicator({ status }: { status: ServiceHealthStatus }) {
  if (status === "down") {
    return <Badge variant="destructive">{STATUS_LABEL.down}</Badge>;
  }

  if (status === "degraded") {
    // Eclipse Glow as a caution chip (the design system carries no amber badge
    // variant, so the token is applied inline, dark-only by construction).
    return (
      <Badge className="border-transparent bg-[#ffd057]/15 text-[#ffd057]">
        {STATUS_LABEL.degraded}
      </Badge>
    );
  }

  // ok — the alive baseline: a steady gold dot under an expanding gold "ping" ring
  // (the heartbeat). motion-safe so reduced-motion users get a calm static dot.
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

// The recent-uptime bar holds this many fixed ticks; real samples are right-aligned
// (newest = "now" at the far right) and the unfilled left is padded with faint
// placeholders, so the strip is always full-width and visibly FILLS IN as the ledger
// grows (≈ BAR_SLOTS × the 10m cadence of history).
const BAR_SLOTS = 90;

// Tick tone per status — a calm dim neutral for ok (Eclipse Gold is reserved for the
// live edge + the status dot, per The One Sun Rule), amber for degraded, red for down,
// a faint placeholder for a slot the ledger hasn't reached yet.
function tickClass(status: ServiceHealthStatus | null): string {
  if (status === "down") {
    return "bg-destructive";
  }
  if (status === "degraded") {
    return "bg-[#ffd057]";
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
        // The live edge (the "now" tick) pulses in its status colour — gold when ok
        // (the heartbeat), amber/red when not; motion-safe so reduce-motion is calm.
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

// Uptime % over the recorded window (ok ÷ total samples), one decimal. Null until the
// ledger has its first sample.
function uptimePercent(samples: ServiceCheckSampleRow[]): number | null {
  if (samples.length === 0) {
    return null;
  }

  const ok = samples.filter((sample) => sample.status === "ok").length;

  return Math.round((ok / samples.length) * 1000) / 10;
}

// "3h" / "12m" / "2d" elapsed since `fromIso` (whole units, terse), or "moments" under
// a minute — for the bar's left-edge "<window> ago" label.
function elapsedShort(fromIso: string, nowIso: string): string {
  const ms = new Date(nowIso).getTime() - new Date(fromIso).getTime();

  if (!Number.isFinite(ms) || ms < 60_000) {
    return "moments";
  }

  const minutes = Math.floor(ms / 60_000);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

// Sort by a fixed order array; an unranked (unknown) service sorts after every ranked
// one, then alphabetically among themselves. Shared by the core list (SERVICE_ORDER)
// and the cron group (CRON_ORDER, the registry's catalog order).
function sortByOrder(services: ServiceStatusRow[], order: string[]): ServiceStatusRow[] {
  return [...services].sort((a, b) => {
    const ai = order.indexOf(a.service);
    const bi = order.indexOf(b.service);
    const ar = ai === -1 ? order.length : ai;
    const br = bi === -1 ? order.length : bi;

    return ar === br ? a.service.localeCompare(b.service) : ar - br;
  });
}

// Split the reported services into the core list and the cron group, each in its own
// fixed order. A cron is identified by its registry service id (`cron.*`), so the two
// groups never overlap and a brand-new cron lands in the Automation group automatically.
// Retired/orphaned ids (e.g. the pre-split `automation` aggregate) are already filtered
// out upstream at `getServiceStatuses`, so they never reach here.
function groupServices(services: ServiceStatusRow[]): {
  core: ServiceStatusRow[];
  crons: ServiceStatusRow[];
} {
  const core: ServiceStatusRow[] = [];
  const crons: ServiceStatusRow[] = [];

  for (const service of services) {
    (CRON_SERVICE_IDS.has(service.service) ? crons : core).push(service);
  }

  return { core: sortByOrder(core, SERVICE_ORDER), crons: sortByOrder(crons, CRON_ORDER) };
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

  return "All systems nominal";
}

// One service row — the masthead (label + indicator), the subtitle/message line, the
// uptime bar, and the footer (history span · uptime% · now). Shared by the core list
// and the Automation (per-cron) group so both render identically.
function ServiceRow({
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

      <div className="mt-4">
        <UptimeBar samples={samples} status={service.status} />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{oldest ? `${elapsedShort(oldest.at, now)} ago` : "no history yet"}</span>
        <span className="text-foreground/80">
          {pct === null ? humanizeSince(service.since, now, service.status) : `${pct}% uptime`}
        </span>
        <span>now</span>
      </div>
    </article>
  );
}

// One labeled group of service rows (the core services, or the per-cron Automation
// group). The label is a quiet uppercase header matching "Recent events".
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
      <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
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
  const { core, crons } = groupServices(services);
  const reporting = [...core, ...crons];

  return (
    <main className="log-plate-stage">
      <article className="log-plate text-foreground">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
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
            <ServiceGroup label="Automation" now={now} rows={crons} samples={samples} />
          </div>
        )}

        {events.length > 0 ? (
          <section aria-label="Recent events">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recent events
            </h2>
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
