import {
  ChartLineUpIcon,
  FilmSlateIcon,
  GlobeSimpleIcon,
  HardDrivesIcon,
  type Icon,
  PaperPlaneTiltIcon,
  PencilSimpleIcon,
  PlusIcon,
  ReceiptIcon,
  SparkleIcon,
  TrashIcon,
  WalletIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type FormEvent, type ReactNode, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { type SubscriptionDTO } from "@fluncle/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@fluncle/ui/components/alert-dialog";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@fluncle/ui/components/dialog";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@fluncle/ui/components/select";
import { Textarea } from "@fluncle/ui/components/textarea";
import { AdminShell } from "@/components/admin/admin-shell";
import { StatTile } from "@/components/admin/stat-tile";
import { formatDate } from "@/lib/format";
import { convertToEurCents, type CurrencyTotals } from "@/lib/fx-convert";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { getEurRates, type FxRatesDTO } from "@/lib/server/fx";
import { listSubscriptions } from "@/lib/server/subscriptions";

// The brand's numeric face — money reads in Oxanium everywhere on this surface, matching
// the sibling `/admin/usage` spend tiles (DESIGN.md "numeric").
const OXANIUM_STACK = '"Oxanium", ui-sans-serif, system-ui, sans-serif';

// The Costs station (COST-02) — the operator's PRIVATE cost ledger: every recurring
// and one-off Fluncle spend in one place. This is the single source of truth for
// spend, pulled out of the public repo docs on purpose — vendor names and amounts are
// private, so they live in the DB at runtime and are read here behind the admin gate,
// never committed to a file. The table ships EMPTY; the operator fills it in-app.
//
// Read SERVER-SIDE in-process (a createServerFn calling `listSubscriptions` — the same
// read the `list_subscriptions` op wraps), so the first paint is instant and no client
// fetch fires on mount. The writes go to the operator-tier oRPC ops
// (create/update/delete_subscription) via same-origin fetch — the same admin cookie
// carries the operator identity — then the query invalidates to refetch.

const CATEGORIES = ["infra", "AI", "media", "distribution", "domains", "tooling"] as const;
const CADENCES = ["monthly", "annual", "one-off", "usage"] as const;
const STATUSES = ["active", "cancelled", "trial"] as const;

type Category = (typeof CATEGORIES)[number];
type Cadence = (typeof CADENCES)[number];
type Status = (typeof STATUSES)[number];

const CATEGORY_ITEMS: Record<Category, string> = {
  AI: "AI",
  distribution: "Distribution",
  domains: "Domains",
  infra: "Infra",
  media: "Media",
  tooling: "Tooling",
};
const CADENCE_ITEMS: Record<Cadence, string> = {
  annual: "Annual",
  monthly: "Monthly",
  "one-off": "One-off",
  usage: "Usage",
};
const STATUS_ITEMS: Record<Status, string> = {
  active: "Active",
  cancelled: "Cancelled",
  trial: "Trial",
};

// Rows group by category, and the categories render in this fixed order (spend-shaped:
// the infrastructure and AI that carry the bill first, the incidentals last) — not the
// ledger's newest-updated order, which means nothing to the operator. Each gets a
// semantic Phosphor mark so a group is scannable by its icon alone.
const CATEGORY_ORDER: Category[] = ["infra", "AI", "media", "distribution", "domains", "tooling"];
const CATEGORY_ICONS: Record<Category, Icon> = {
  AI: SparkleIcon,
  distribution: PaperPlaneTiltIcon,
  domains: GlobeSimpleIcon,
  infra: HardDrivesIcon,
  media: FilmSlateIcon,
  tooling: WrenchIcon,
};

// The per-cadence suffix the amount carries (so cadence never needs its own meta chip):
// recurring lines read "/mo" or "/yr"; usage + one-off name themselves.
const CADENCE_SUFFIX: Record<Cadence, string> = {
  annual: "/yr",
  monthly: "/mo",
  "one-off": "one-off",
  usage: "usage",
};

const SUBSCRIPTIONS_KEY = ["admin", "subscriptions"] as const;

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

// The whole ledger, newest-updated first. Server-side: in-process, no HTTP, no CORS.
const fetchSubscriptions = createServerFn({ method: "GET" }).handler(
  async (): Promise<SubscriptionDTO[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return listSubscriptions();
  },
);

// Today's EUR reference rates (read-through daily cache, best-effort — null when the
// vendor is down and there is no cache yet). Powers the single aggregate EUR figure.
const fetchFxRates = createServerFn({ method: "GET" }).handler(
  async (): Promise<FxRatesDTO | null> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return getEurRates();
  },
);

export const Route = createFileRoute("/admin/costs")({
  beforeLoad: () => ensureAdmin(),
  component: CostsPage,
  loader: async () => {
    const [subscriptions, fx] = await Promise.all([fetchSubscriptions(), fetchFxRates()]);

    return { fx, subscriptions };
  },
});

// The operator's form values — major-unit amount (converted to cents on submit), the
// closed enums, and the free-text fields. Kept as strings for controlled inputs.
type FormValues = {
  amount: string;
  billingUrl: string;
  cadence: Cadence;
  category: Category;
  currency: string;
  name: string;
  notes: string;
  powers: string;
  renewsAt: string;
  status: Status;
  vendor: string;
};

const EMPTY_FORM: FormValues = {
  amount: "",
  billingUrl: "",
  cadence: "monthly",
  category: "infra",
  currency: "EUR",
  name: "",
  notes: "",
  powers: "",
  renewsAt: "",
  status: "active",
  vendor: "",
};

function formValuesFrom(sub: SubscriptionDTO): FormValues {
  return {
    amount: (sub.amount / 100).toFixed(2),
    billingUrl: sub.billingUrl ?? "",
    cadence: sub.cadence,
    category: sub.category,
    currency: sub.currency,
    name: sub.name,
    notes: sub.notes ?? "",
    powers: sub.powers ?? "",
    // The <input type="date"> wants a YYYY-MM-DD value; the stored ISO carries a time.
    renewsAt: sub.renewsAt ? sub.renewsAt.slice(0, 10) : "",
    status: sub.status,
    vendor: sub.vendor,
  };
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { currency, style: "currency" }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

// Normalise a recurring line to its monthly-equivalent cents (annual ÷ 12). One-off +
// usage lines have no honest monthly figure, so they're left out of the running total.
function monthlyEquivalentCents(sub: SubscriptionDTO): number | undefined {
  if (sub.status !== "active") {
    return undefined;
  }

  if (sub.cadence === "monthly") {
    return sub.amount;
  }

  if (sub.cadence === "annual") {
    return Math.round(sub.amount / 12);
  }

  return undefined;
}

type LedgerGroup = {
  category: Category;
  lines: SubscriptionDTO[];
  monthly: CurrencyTotals;
};

type LedgerModel = {
  counts: { free: number; inactive: number; paid: number; total: number };
  groups: LedgerGroup[];
  monthly: CurrencyTotals;
};

// Sum monthly-equivalents into a per-currency map (a ledger can mix EUR + USD), then
// hand back entries sorted heaviest-first so the biggest currency leads every readout.
function totalsByCurrency(lines: SubscriptionDTO[]): CurrencyTotals {
  const totals = new Map<string, number>();

  for (const line of lines) {
    const cents = monthlyEquivalentCents(line);

    if (cents !== undefined && cents > 0) {
      totals.set(line.currency, (totals.get(line.currency) ?? 0) + cents);
    }
  }

  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

// One pass over the ledger → the whole page's data: category groups in CATEGORY_ORDER
// (each sorted costliest-first, each with its own monthly subtotal), the ledger-wide
// monthly total, and the paid / free / inactive tallies for the headline tiles.
function buildLedgerModel(subscriptions: SubscriptionDTO[]): LedgerModel {
  const counts = { free: 0, inactive: 0, paid: 0, total: subscriptions.length };

  for (const sub of subscriptions) {
    if (sub.status !== "active") {
      counts.inactive += 1;
    } else if (sub.amount > 0) {
      counts.paid += 1;
    } else {
      counts.free += 1;
    }
  }

  const groups: LedgerGroup[] = [];

  for (const category of CATEGORY_ORDER) {
    const lines = subscriptions
      .filter((sub) => sub.category === category)
      .sort((a, b) => {
        const byAmount = (monthlyEquivalentCents(b) ?? -1) - (monthlyEquivalentCents(a) ?? -1);
        return byAmount !== 0 ? byAmount : a.name.localeCompare(b.name);
      });

    if (lines.length > 0) {
      groups.push({ category, lines, monthly: totalsByCurrency(lines) });
    }
  }

  return { counts, groups, monthly: totalsByCurrency(subscriptions) };
}

function CostsPage() {
  const initial = Route.useLoaderData();
  const queryClient = useQueryClient();
  const { data: subscriptions } = useQuery<SubscriptionDTO[]>({
    initialData: initial.subscriptions,
    queryFn: () => fetchSubscriptions(),
    queryKey: SUBSCRIPTIONS_KEY,
    refetchOnWindowFocus: true,
  });

  // Today's EUR rates ride the loader (they only change once/day, so no focus refetch).
  const fx = initial.fx;

  // The dialog is a single reused form: `editing` null = a new line, set = an edit.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SubscriptionDTO | undefined>();
  const [deleting, setDeleting] = useState<SubscriptionDTO | undefined>();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: SUBSCRIPTIONS_KEY });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/v1/admin/subscriptions/${id}`, {
        credentials: "same-origin",
        method: "DELETE",
      });
      const result = (await response.json()) as { message?: string; ok?: boolean };

      if (!response.ok || !result.ok) {
        throw new Error(result.message ?? `Delete failed (${response.status})`);
      }
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
    onSuccess: () => {
      setDeleting(undefined);
      void invalidate();
    },
  });

  // The whole read in one pass: category groups (each with its own monthly subtotal),
  // the ledger-wide monthly total per currency, and the paid/free/inactive counts.
  const model = useMemo(() => buildLedgerModel(subscriptions), [subscriptions]);

  const subtitle =
    subscriptions.length === 0
      ? "Nothing tracked yet"
      : `${subscriptions.length} ${subscriptions.length === 1 ? "line" : "lines"}`;

  const openNew = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  const openEdit = (sub: SubscriptionDTO) => {
    setEditing(sub);
    setDialogOpen(true);
  };

  return (
    <AdminShell
      headerActions={
        <Button onClick={openNew} size="sm">
          <PlusIcon aria-hidden="true" />
          Add cost
        </Button>
      }
      subtitle={subtitle}
      title="Costs"
    >
      {subscriptions.length === 0 ? (
        <div className="p-4 sm:p-5">
          <EmptyLedger onAdd={openNew} />
        </div>
      ) : (
        <div className="space-y-8 p-4 sm:p-5">
          <TotalsRow fx={fx} model={model} />
          <div className="space-y-6">
            {model.groups.map((group) => (
              <CategoryGroup
                group={group}
                key={group.category}
                onDelete={setDeleting}
                onEdit={openEdit}
              />
            ))}
          </div>
        </div>
      )}

      <CostDialog
        editing={editing}
        onOpenChange={setDialogOpen}
        onSaved={() => {
          setDialogOpen(false);
          void invalidate();
        }}
        open={dialogOpen}
      />

      <AlertDialog
        onOpenChange={(open) => !open && setDeleting(undefined)}
        open={deleting !== undefined}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this cost line?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `“${deleting.name}” (${deleting.vendor}) will be removed from the ledger.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminShell>
  );
}

// The headline: the recurring total as the one gold number, its annualized run-rate
// beside it, and the line tally with its paid / free split. Mirrors the `/admin/usage`
// totals row so the two Cost stations read as one workspace.
//
// When the ledger mixes currencies and today's ECB rates are available, the money tiles
// collapse to a SINGLE "≈ €X" — the operator's "what do I actually pay" number — with
// the native per-currency breakdown + the rate date in the hint. Individual lines keep
// their own fixed-price currency (they are not converted). If rates are missing, or the
// ledger is EUR-only, the tiles fall back to the per-currency stack, never a fake total.
function TotalsRow({ fx, model }: { fx: FxRatesDTO | null; model: LedgerModel }) {
  const { counts, monthly } = model;
  const perYear: CurrencyTotals = monthly.map(([currency, cents]) => [currency, cents * 12]);
  const needsConversion = monthly.some(([currency]) => currency !== "EUR");
  const monthConv = fx ? convertToEurCents(monthly, fx.rates) : null;

  let monthValue: ReactNode;
  let monthHint: ReactNode;
  let yearValue: ReactNode;

  if (fx && monthConv && needsConversion && monthConv.complete) {
    const native = monthly.map(([currency, cents]) => formatMoney(cents, currency)).join(" + ");
    monthValue = <span>≈ {formatMoney(monthConv.eurCents, "EUR")}</span>;
    monthHint = `${native} · ECB ${formatDate(fx.ratesDate)}`;
    yearValue = <span>≈ {formatMoney(monthConv.eurCents * 12, "EUR")}</span>;
  } else {
    monthValue = <MoneyStack entries={monthly} />;
    monthHint = "recurring, annual ÷ 12";
    yearValue = <MoneyStack entries={perYear} />;
  }

  const lineBreakdown = [
    counts.paid > 0 ? `${counts.paid} paid` : undefined,
    counts.free > 0 ? `${counts.free} free` : undefined,
    counts.inactive > 0 ? `${counts.inactive} inactive` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section aria-label="Totals" className="grid gap-3 sm:grid-cols-3">
      <StatTile
        accent
        hint={monthHint}
        icon={<WalletIcon aria-hidden="true" className="size-4" weight="fill" />}
        label="Per month"
        value={monthValue}
      />
      <StatTile
        hint="annualized run-rate"
        icon={<ChartLineUpIcon aria-hidden="true" className="size-4" />}
        label="Per year"
        value={yearValue}
      />
      <StatTile
        hint={lineBreakdown || "nothing tracked yet"}
        icon={<ReceiptIcon aria-hidden="true" className="size-4" />}
        label="Tracked lines"
        value={counts.total}
      />
    </section>
  );
}

// A per-currency money readout. A single currency reads big (the tile's own 2xl); a
// mixed ledger stacks each currency on its own line, one size down so the tile keeps
// its height. An all-free / usage-only ledger has no honest recurring figure → em dash.
function MoneyStack({ entries }: { entries: CurrencyTotals }) {
  const [first] = entries;

  if (!first) {
    return <span className="text-muted-foreground">—</span>;
  }

  if (entries.length === 1) {
    const [currency, cents] = first;
    return <span>{formatMoney(cents, currency)}</span>;
  }

  return (
    <span className="flex flex-col gap-0.5 leading-tight">
      {entries.map(([currency, cents]) => (
        <span className="text-xl" key={currency}>
          {formatMoney(cents, currency)}
        </span>
      ))}
    </span>
  );
}

// One category, its lines under a header that carries the group's own monthly subtotal.
function CategoryGroup({
  group,
  onDelete,
  onEdit,
}: {
  group: LedgerGroup;
  onDelete: (sub: SubscriptionDTO) => void;
  onEdit: (sub: SubscriptionDTO) => void;
}) {
  const Icon = CATEGORY_ICONS[group.category];

  return (
    <section aria-label={CATEGORY_ITEMS[group.category]}>
      <div className="mb-2 flex items-center gap-2 px-1">
        <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{CATEGORY_ITEMS[group.category]}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">({group.lines.length})</span>
        {group.monthly.length > 0 ? (
          <span
            className="ml-auto text-xs text-muted-foreground tabular-nums"
            style={{ fontFamily: OXANIUM_STACK }}
          >
            {group.monthly.map(([currency, cents]) => formatMoney(cents, currency)).join(" + ")}
            <span className="text-muted-foreground/70">/mo</span>
          </span>
        ) : null}
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {group.lines.map((sub) => (
          <CostRow
            key={sub.id}
            onDelete={() => onDelete(sub)}
            onEdit={() => onEdit(sub)}
            subscription={sub}
          />
        ))}
      </ul>
    </section>
  );
}

function EmptyLedger({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <ReceiptIcon aria-hidden="true" className="size-7 text-muted-foreground/70" />
      <p className="font-medium">No costs tracked yet</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        This is the private ledger of what Fluncle costs to run — infra, AI, domains, tooling. Add a
        line and it lives here, never in a committed file.
      </p>
      <Button className="mt-2" onClick={onAdd} size="sm" variant="outline">
        <PlusIcon aria-hidden="true" />
        Add the first cost
      </Button>
    </div>
  );
}

// One cost line: name + vendor on top, a quiet meta line (status if not active · renewal
// · what it powers · billing), then the amount on the right — real spend in full weight,
// a free plan dimmed to "Free" so the money reads at a glance. Category lives in the
// group header; cadence rides the amount's "/mo" · "/yr" suffix.
function CostRow({
  onDelete,
  onEdit,
  subscription: sub,
}: {
  onDelete: () => void;
  onEdit: () => void;
  subscription: SubscriptionDTO;
}) {
  return (
    <li className="group flex items-center gap-3 px-3 py-3 transition-colors hover:bg-primary/[0.04]">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {sub.name} <span className="text-muted-foreground">· {sub.vendor}</span>
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {sub.status !== "active" ? (
            <Badge variant={sub.status === "trial" ? "secondary" : "outline"}>
              {STATUS_ITEMS[sub.status]}
            </Badge>
          ) : null}
          {sub.renewsAt ? <span>renews {formatDate(sub.renewsAt)}</span> : null}
          {sub.powers ? <span className="truncate">{sub.powers}</span> : null}
          {sub.billingUrl ? (
            <a
              className="text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              href={sub.billingUrl}
              rel="noreferrer"
              target="_blank"
            >
              billing ↗
            </a>
          ) : null}
        </div>
        {sub.notes ? (
          <p className="mt-1 truncate text-xs text-muted-foreground">{sub.notes}</p>
        ) : null}
      </div>

      <AmountCell subscription={sub} />

      <div className="flex shrink-0 items-center gap-1">
        <Button aria-label={`Edit ${sub.name}`} onClick={onEdit} size="icon-sm" variant="ghost">
          <PencilSimpleIcon aria-hidden="true" />
        </Button>
        <Button
          aria-label={`Delete ${sub.name}`}
          className="text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          size="icon-sm"
          variant="ghost"
        >
          <TrashIcon aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

// The amount, right-aligned in Oxanium. A $0 line is a free plan, not a spend — it reads
// a quiet "Free" (no cadence suffix) so the eye skips to where the money actually is. A
// paid line stays full-weight and carries the cadence as its "/mo" · "/yr" · … suffix.
function AmountCell({ subscription: sub }: { subscription: SubscriptionDTO }) {
  const isFree = sub.amount === 0;

  if (isFree) {
    return (
      <div
        className="shrink-0 text-right text-sm text-muted-foreground"
        style={{ fontFamily: OXANIUM_STACK }}
      >
        Free
      </div>
    );
  }

  return (
    <div className="shrink-0 text-right">
      <div
        className="text-sm font-semibold tabular-nums text-foreground"
        style={{ fontFamily: OXANIUM_STACK }}
      >
        {formatMoney(sub.amount, sub.currency)}
      </div>
      <div className="text-[11px] text-muted-foreground/70">{CADENCE_SUFFIX[sub.cadence]}</div>
    </div>
  );
}

// The add/edit form dialog. On submit it POSTs (new) or PATCHes (edit) the operator-tier
// oRPC op; the amount is entered in major units and converted to cents on the wire.
function CostDialog({
  editing,
  onOpenChange,
  onSaved,
  open,
}: {
  editing: SubscriptionDTO | undefined;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  open: boolean;
}) {
  const [values, setValues] = useState<FormValues>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Re-seed the form whenever the dialog opens (a fresh EMPTY_FORM for a new line, the
  // row's values for an edit). Keyed off `open` + the editing id via a render guard.
  const seedKey = `${open ? "open" : "closed"}:${editing?.id ?? "new"}`;
  const [seededFor, setSeededFor] = useState<string | undefined>();

  if (open && seededFor !== seedKey) {
    setValues(editing ? formValuesFrom(editing) : EMPTY_FORM);
    setSeededFor(seedKey);
  }

  if (!open && seededFor !== undefined) {
    setSeededFor(undefined);
  }

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();

    const amountMajor = Number(values.amount);

    if (!Number.isFinite(amountMajor) || amountMajor < 0) {
      toast.error("Enter a valid amount");
      return;
    }

    const body = {
      amount: Math.round(amountMajor * 100),
      billingUrl: values.billingUrl.trim() || null,
      cadence: values.cadence,
      category: values.category,
      currency: values.currency.trim() || "EUR",
      name: values.name.trim(),
      notes: values.notes.trim() || null,
      powers: values.powers.trim() || null,
      renewsAt: values.renewsAt.trim() || null,
      status: values.status,
      vendor: values.vendor.trim(),
    };

    setSaving(true);

    try {
      const response = await fetch(
        editing ? `/api/v1/admin/subscriptions/${editing.id}` : "/api/v1/admin/subscriptions",
        {
          body: JSON.stringify(body),
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          method: editing ? "PATCH" : "POST",
        },
      );
      const result = (await response.json()) as { message?: string; ok?: boolean };

      if (!response.ok || !result.ok) {
        throw new Error(result.message ?? `Save failed (${response.status})`);
      }

      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit cost" : "Add cost"}</DialogTitle>
          <DialogDescription>
            A line in the private cost ledger. Amounts are per the chosen cadence.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              {(id) => (
                <Input
                  id={id}
                  onChange={(event) => set("name", event.target.value)}
                  placeholder="Workers Paid"
                  required
                  value={values.name}
                />
              )}
            </Field>
            <Field label="Vendor">
              {(id) => (
                <Input
                  id={id}
                  onChange={(event) => set("vendor", event.target.value)}
                  placeholder="Cloudflare"
                  required
                  value={values.vendor}
                />
              )}
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              {(id) => (
                <Select
                  items={CATEGORY_ITEMS}
                  onValueChange={(value) => set("category", value as Category)}
                  value={values.category}
                >
                  <SelectTrigger className="w-full" id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category}>
                        {CATEGORY_ITEMS[category]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field label="Cadence">
              {(id) => (
                <Select
                  items={CADENCE_ITEMS}
                  onValueChange={(value) => set("cadence", value as Cadence)}
                  value={values.cadence}
                >
                  <SelectTrigger className="w-full" id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CADENCES.map((cadence) => (
                      <SelectItem key={cadence} value={cadence}>
                        {CADENCE_ITEMS[cadence]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field className="col-span-2" label="Amount">
              {(id) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  min="0"
                  onChange={(event) => set("amount", event.target.value)}
                  placeholder="20.00"
                  required
                  step="0.01"
                  type="number"
                  value={values.amount}
                />
              )}
            </Field>
            <Field label="Currency">
              {(id) => (
                <Input
                  id={id}
                  maxLength={3}
                  onChange={(event) => set("currency", event.target.value.toUpperCase())}
                  placeholder="EUR"
                  value={values.currency}
                />
              )}
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Status">
              {(id) => (
                <Select
                  items={STATUS_ITEMS}
                  onValueChange={(value) => set("status", value as Status)}
                  value={values.status}
                >
                  <SelectTrigger className="w-full" id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {STATUS_ITEMS[status]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field label="Renews on">
              {(id) => (
                <Input
                  id={id}
                  onChange={(event) => set("renewsAt", event.target.value)}
                  type="date"
                  value={values.renewsAt}
                />
              )}
            </Field>
          </div>

          <Field label="Powers (optional)">
            {(id) => (
              <Input
                id={id}
                onChange={(event) => set("powers", event.target.value)}
                placeholder="the web app + every admin surface"
                value={values.powers}
              />
            )}
          </Field>

          <Field label="Billing URL (optional)">
            {(id) => (
              <Input
                id={id}
                onChange={(event) => set("billingUrl", event.target.value)}
                placeholder="https://dash.cloudflare.com/…/billing"
                type="url"
                value={values.billingUrl}
              />
            )}
          </Field>

          <Field label="Notes (optional)">
            {(id) => (
              <Textarea
                id={id}
                onChange={(event) => set("notes", event.target.value)}
                rows={2}
                value={values.notes}
              />
            )}
          </Field>

          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={saving} type="submit">
              {editing ? "Save changes" : "Add cost"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// A labelled form field. `children` is a render prop handed the generated id so the
// visible <Label> is programmatically associated with its control (an Input's id, or a
// Select's SelectTrigger id) — keyboard + screen-reader access, per the canon.
function Field({
  children,
  className,
  label,
}: {
  children: (id: string) => ReactNode;
  className?: string;
  label: string;
}) {
  const id = useId();

  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
    </div>
  );
}
