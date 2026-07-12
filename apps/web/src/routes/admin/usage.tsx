import { CoinsIcon, CurrencyDollarIcon, StackIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ReactNode } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { StatTile } from "@/components/admin/stat-tile";
import { albumCoverAtSize } from "@/lib/media";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { type CostInsights, getCostInsights } from "@/lib/server/costs";

// The Usage & cost station (COST-01, RFC §6) — the operator's read on what the
// pipeline SPENDS, per automation step and per finding, from the append-only
// `cost_events` ledger. The one hard rule (RFC §0): CASH (real incremental money —
// OpenRouter distil, Cartesia TTS, Firecrawl, Resend) is the headline; SUBSIDIZED
// (fixed-plan draws — subscription LLM tokens + on-box compute) renders as a
// SEPARATE, clearly-labelled column and is NEVER summed into cash. Unpriced rows
// (a rate we don't know yet) are counted, never laundered to $0.
//
// Read SERVER-SIDE in-process (a createServerFn calling `getCostInsights` — the
// browser-admin pattern, no oRPC client, no CORS), seeded into a focus-refetching
// query so a fresh sweep's rows appear on tab-back without a reload. Sits under the
// "Costs" sidebar group beside COST-02's `/admin/costs` subscriptions ledger — they
// share the operator's mental model, never data or a combined total.

const OXANIUM_STACK = '"Oxanium", ui-sans-serif, system-ui, sans-serif';

const USAGE_KEY = ["admin", "usage"] as const;

// A human label per ledger step (the enum is machine-terse). An unmapped step
// falls back to its raw key, so a new step still renders.
const STEP_LABELS: Record<string, string> = {
  context: "Context notes",
  discogs: "Discogs",
  embed: "Embeddings",
  enrich: "Enrichment",
  lastfm: "Last.fm",
  newsletter: "Newsletter",
  note: "Auto-note",
  observe: "Observation",
  publish: "Publish",
  "studio-clip": "Studio clips",
  video: "Video render",
};

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

// The two aggregations, server-side + in-process (no HTTP, no CORS).
const fetchUsage = createServerFn({ method: "GET" }).handler(async (): Promise<CostInsights> => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  return getCostInsights();
});

export const Route = createFileRoute("/admin/usage")({
  beforeLoad: () => ensureAdmin(),
  component: UsagePage,
  loader: () => fetchUsage(),
});

// USD with enough precision for sub-cent marginal costs (a Firecrawl search is
// ~$0.0016), but tidy at larger magnitudes. Below a cent → 4 dp; else currency.
function formatUsd(amount: number): string {
  if (amount === 0) {
    return "$0";
  }

  if (amount < 0.01) {
    return `$${amount.toFixed(4)}`;
  }

  try {
    return new Intl.NumberFormat("en-US", { currency: "USD", style: "currency" }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function UsagePage() {
  const initial = Route.useLoaderData();
  const { data } = useQuery({
    initialData: initial,
    queryFn: () => fetchUsage(),
    queryKey: USAGE_KEY,
    refetchOnWindowFocus: true,
  });

  const subtitle = `${formatUsd(data.totals.cashUsd)} cash · last ${data.windowDays}d`;

  return (
    <AdminShell subtitle={subtitle} title="Usage & cost">
      <div className="space-y-8 p-4 sm:p-5">
        <TotalsRow totals={data.totals} windowDays={data.windowDays} />
        <StepSection steps={data.steps} />
        <FindingSection findings={data.topFindings} />
      </div>
    </AdminShell>
  );
}

// The headline split, rendered AS the split: cash is the gold stat; subsidized is a
// separate, labelled tile ("fixed-plan draw — already in Subscriptions"), never
// added to cash. A third quiet tile surfaces the unpriced count so a guess never
// hides as a fact.
function TotalsRow({ totals, windowDays }: { totals: CostInsights["totals"]; windowDays: number }) {
  return (
    <section aria-label="Totals">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          accent
          hint={`real money out the door · last ${windowDays}d`}
          icon={<CurrencyDollarIcon aria-hidden="true" className="size-4" weight="fill" />}
          label="Cash"
          value={formatUsd(totals.cashUsd)}
        />
        <StatTile
          hint="fixed-plan draw — already in Subscriptions, never added to cash"
          icon={<StackIcon aria-hidden="true" className="size-4" />}
          label="Subsidized draw"
          value={formatUsd(totals.subsidizedUsd)}
        />
        <StatTile
          hint="rows with no rate yet — counted, never $0"
          icon={<CoinsIcon aria-hidden="true" className="size-4" />}
          label="Unpriced"
          value={`${totals.unpricedCount}`}
        />
      </div>
    </section>
  );
}

// Per-step rollup — cash and subsidized-draw in SEPARATE columns, plus an unpriced
// marker on any step still carrying a row we can't price. Sorted cash-heaviest
// first (the read `getCostInsights` returns).
function StepSection({ steps }: { steps: CostInsights["steps"] }) {
  return (
    <section aria-label="Cost per step">
      <SectionHeading count={steps.length} label="Cost per step" />
      {steps.length === 0 ? (
        <EmptyRow>No cost rows in the window yet. The ledger fills as the pipeline runs.</EmptyRow>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {steps.map((step) => (
            <li className="flex items-center gap-3 px-3 py-3 sm:px-4" key={step.step}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {STEP_LABELS[step.step] ?? step.step}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {step.eventCount} {step.eventCount === 1 ? "event" : "events"}
                  {step.unpricedCount > 0 ? (
                    <span className="text-[var(--eclipse-glow)]">
                      {" "}
                      · {step.unpricedCount} unpriced
                    </span>
                  ) : null}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-medium tabular-nums text-primary">
                  {formatUsd(step.cashUsd)}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {step.subsidizedUsd > 0 ? `${formatUsd(step.subsidizedUsd)} draw` : "—"}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Per-finding top-N — the highest CASH-cost findings, cash only (the operator's
// "what did this find cost in real money" question).
function FindingSection({ findings }: { findings: CostInsights["topFindings"] }) {
  return (
    <section aria-label="Cost per finding">
      <SectionHeading count={findings.length} label="Costliest findings (cash)" />
      {findings.length === 0 ? (
        <EmptyRow>No per-finding cash rows yet.</EmptyRow>
      ) : (
        <ol className="divide-y divide-border rounded-lg border border-border">
          {findings.map((finding) => {
            const cover =
              albumCoverAtSize(finding.albumImageUrl ?? undefined, "small") ?? "/fluncle-cover.png";

            return (
              <li className="flex items-center gap-3 px-3 py-2.5 sm:px-4" key={finding.trackId}>
                <img alt="" className="size-11 shrink-0 rounded-md object-cover" src={cover} />
                <div className="min-w-0 flex-1">
                  {finding.logId ? (
                    <p
                      className="truncate text-[11px] tracking-tight text-muted-foreground tabular-nums"
                      style={{ fontFamily: OXANIUM_STACK }}
                    >
                      {finding.logId}
                    </p>
                  ) : null}
                  <p className="truncate text-sm font-medium">{finding.title ?? finding.trackId}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {finding.artists.join(", ")}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-medium tabular-nums text-primary">
                    {formatUsd(finding.cashUsd)}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {finding.eventCount} {finding.eventCount === 1 ? "event" : "events"}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function SectionHeading({ count, label }: { count: number; label: string }) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <CoinsIcon aria-hidden="true" className="size-4 text-muted-foreground" />
      <h2 className="text-sm font-semibold">{label}</h2>
      <span className="text-xs text-muted-foreground tabular-nums">({count})</span>
    </div>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
