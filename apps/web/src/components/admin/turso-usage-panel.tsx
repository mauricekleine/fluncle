import {
  BellIcon,
  CalendarDotsIcon,
  DatabaseIcon,
  PencilSimpleIcon,
  ReceiptIcon,
  TrendUpIcon,
} from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import {
  type TursoUsageAlert,
  type TursoUsageBoard,
  type TursoUsageHistoryDay,
  type TursoUsageResource,
  type TursoUsageResourceKey,
  type TursoUsageSnapshot,
} from "@fluncle/contracts";
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
import { StatTile } from "@/components/admin/stat-tile";
import { formatDate } from "@/lib/format";

const HISTORY_DAYS_SHOWN = 14;

const RESOURCE_LABELS: Record<TursoUsageResourceKey, string> = {
  embeddedSyncs: "Embedded syncs",
  rowsRead: "Rows read",
  rowsWritten: "Rows written",
  storage: "Storage",
};

const BYTE_RESOURCES = new Set<TursoUsageResourceKey>(["embeddedSyncs", "storage"]);

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", { currency: "USD", style: "currency" }).format(amount);
}

export function formatQuantity(key: TursoUsageResourceKey, amount: number): string {
  if (BYTE_RESOURCES.has(key)) {
    return `${(amount / 1e9).toFixed(amount >= 100e9 ? 0 : 1)} GB`;
  }

  if (amount >= 1e9) {
    return `${(amount / 1e9).toFixed(1)}B`;
  }

  if (amount >= 1e6) {
    return `${(amount / 1e6).toFixed(1)}M`;
  }

  if (amount >= 1e3) {
    return `${(amount / 1e3).toFixed(1)}K`;
  }

  return String(Math.round(amount));
}

export function TursoUsagePanel({
  board,
  onSetThreshold,
  settingThreshold,
}: {
  board: TursoUsageBoard;
  onSetThreshold: (thresholdUsd: number) => Promise<boolean>;
  settingThreshold: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const headingId = useId();
  const latest = board.latest;

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 px-1">
        <DatabaseIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold" id={headingId}>
          Turso this cycle
        </h2>
        {latest ? (
          <span className="text-xs text-muted-foreground">
            {latest.plan} · read {formatDate(latest.observedAt)}
          </span>
        ) : null}
        <Button className="ml-auto" onClick={() => setEditing(true)} size="sm" variant="ghost">
          <BellIcon aria-hidden="true" />
          Alert at {formatUsd(board.thresholdUsd)}
          <PencilSimpleIcon aria-hidden="true" />
        </Button>
      </div>

      {!board.available ? (
        <EmptyPanel>
          No Turso readings to show: the telemetry database is not configured or did not answer.
        </EmptyPanel>
      ) : latest ? (
        <UsageBody alerts={board.alerts} history={board.history} snapshot={latest} />
      ) : (
        <EmptyPanel>
          No Turso reading yet. The fluncle-turso-usage sweep writes the first one once its token is
          on the box.
        </EmptyPanel>
      )}

      <ThresholdDialog
        current={board.thresholdUsd}
        onOpenChange={setEditing}
        onSave={async (value) => {
          if (await onSetThreshold(value)) {
            setEditing(false);
          }
        }}
        open={editing}
        saving={settingThreshold}
      />
    </section>
  );
}

function UsageBody({
  alerts,
  history,
  snapshot,
}: {
  alerts: TursoUsageAlert[];
  history: TursoUsageHistoryDay[];
  snapshot: TursoUsageSnapshot;
}) {
  const resetDay = formatDate(snapshot.cycleEnd);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          accent={snapshot.overageUsd > 0}
          hint={`over the plan's included usage, plus ${formatUsd(snapshot.baseUsd)} base`}
          icon={<ReceiptIcon aria-hidden="true" className="size-4" />}
          label="Overage so far"
          value={formatUsd(snapshot.overageUsd)}
        />
        <StatTile
          accent={snapshot.projectedOverageUsd > 0}
          hint={projectionHint(snapshot)}
          icon={<TrendUpIcon aria-hidden="true" className="size-4" />}
          label={`Projected by ${resetDay}`}
          value={formatUsd(snapshot.projectedOverageUsd)}
        />
        <StatTile
          hint="Turso's own upcoming invoice, as a cross-check"
          icon={<CalendarDotsIcon aria-hidden="true" className="size-4" />}
          label="Draft invoice"
          value={
            snapshot.upcomingInvoiceUsd === null ? (
              <span className="text-muted-foreground">n/a</span>
            ) : (
              formatUsd(snapshot.upcomingInvoiceUsd)
            )
          }
        />
      </div>

      {alerts.length > 0 ? <AlertLine alerts={alerts} /> : null}

      <ResourceList resources={snapshot.resources} />

      {snapshot.databases.length > 0 ? <DatabaseList snapshot={snapshot} /> : null}

      {history.length > 0 ? <HistoryList history={history} /> : null}

      <p className="px-1 text-xs text-muted-foreground">
        {snapshot.priced
          ? `List rates from ${snapshot.priceSource} (table ${snapshot.priceTableVersion}). Turso's rates drop at volume, so these figures are an upper bound.`
          : `No price table for the ${snapshot.plan} plan, so this reading is unpriced.`}
        {snapshot.overagesEnabled ? "" : " Overages are off: Turso blocks instead of billing."}
      </p>
    </div>
  );
}

function projectionHint(snapshot: TursoUsageSnapshot): string {
  if (snapshot.rateBasis === "recent" && snapshot.rateWindowHours !== null) {
    return `run-rate over the last ${Math.round(snapshot.rateWindowHours)}h · bill ≈ ${formatUsd(snapshot.projectedBillUsd)}`;
  }

  if (snapshot.rateBasis === "cycle-to-date") {
    return `cycle-to-date average · bill ≈ ${formatUsd(snapshot.projectedBillUsd)}`;
  }

  return "too early in the cycle for a run-rate";
}

function AlertLine({ alerts }: { alerts: TursoUsageAlert[] }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground">
      <BellIcon aria-hidden="true" className="size-3.5" />
      {alerts.map((alert) => (
        <span className="tabular-nums" key={alert.levelUsd}>
          {formatUsd(alert.levelUsd)}{" "}
          {alert.deliveredAt ? `alerted ${formatDate(alert.deliveredAt)}` : "alert pending"}
        </span>
      ))}
    </p>
  );
}

function ResourceList({ resources }: { resources: TursoUsageResource[] }) {
  return (
    <section aria-label="Per resource">
      <h3 className="mb-2 px-1 text-xs font-semibold text-muted-foreground">Per resource</h3>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {resources.map((resource) => (
          <li className="flex items-center gap-3 px-3 py-3 sm:px-4" key={resource.key}>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{RESOURCE_LABELS[resource.key]}</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {formatQuantity(resource.key, resource.used)} of{" "}
                {formatQuantity(resource.key, resource.included)}
                {resource.key === "storage"
                  ? ""
                  : ` · ${formatQuantity(resource.key, resource.dailyRate)}/day`}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p
                className={`text-sm font-medium tabular-nums ${resource.overageUsd > 0 ? "text-primary" : ""}`}
              >
                {formatUsd(resource.overageUsd)}
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {formatUsd(resource.projectedOverageUsd)} projected
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DatabaseList({ snapshot }: { snapshot: TursoUsageSnapshot }) {
  return (
    <section aria-label="Per database">
      <h3 className="mb-2 px-1 text-xs font-semibold text-muted-foreground">Per database</h3>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {snapshot.databases.map((database) => (
          <li className="flex items-center gap-3 px-3 py-2.5 sm:px-4" key={database.name}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{database.name}</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {formatQuantity("rowsWritten", database.rowsWritten)} written ·{" "}
                {formatQuantity("embeddedSyncs", database.bytesSynced)} synced ·{" "}
                {formatQuantity("rowsRead", database.rowsRead)} read ·{" "}
                {formatQuantity("storage", database.storageBytes)} stored
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm tabular-nums">{formatUsd(database.attributedOverageUsd)}</p>
              <p className="text-xs text-muted-foreground">share of overage</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HistoryList({ history }: { history: TursoUsageHistoryDay[] }) {
  const shown = history.slice(-HISTORY_DAYS_SHOWN).reverse();
  const peak = Math.max(1, ...shown.map((day) => day.projectedOverageUsd));

  return (
    <section aria-label="Per day">
      <h3 className="mb-2 px-1 text-xs font-semibold text-muted-foreground">
        Per day (last reading each UTC day)
      </h3>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {shown.map((day) => (
          <li className="flex items-center gap-3 px-3 py-2 sm:px-4" key={day.day}>
            <span className="w-24 shrink-0 text-xs text-muted-foreground tabular-nums">
              {formatDate(day.day)}
            </span>
            <div aria-hidden="true" className="h-1.5 flex-1 rounded-full bg-muted">
              <div
                className="h-1.5 rounded-full bg-primary/70"
                style={{ width: `${(day.projectedOverageUsd / peak) * 100}%` }}
              />
            </div>
            <span className="w-48 shrink-0 text-right text-xs tabular-nums">
              {formatUsd(day.overageUsd)}{" "}
              <span className="text-muted-foreground">
                → {formatUsd(day.projectedOverageUsd)} projected
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EmptyPanel({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function ThresholdDialog({
  current,
  onOpenChange,
  onSave,
  open,
  saving,
}: {
  current: number;
  onOpenChange: (open: boolean) => void;
  onSave: (value: number) => Promise<void>;
  open: boolean;
  saving: boolean;
}) {
  const id = useId();
  const [value, setValue] = useState(String(current));
  const [seededFor, setSeededFor] = useState<boolean>(false);

  if (open && !seededFor) {
    setValue(String(current));
    setSeededFor(true);
  }

  if (!open && seededFor) {
    setSeededFor(false);
  }

  const parsed = Number(value);
  const valid = Number.isFinite(parsed) && parsed >= 1 && parsed <= 100_000;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();

    if (valid) {
      await onSave(parsed);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Turso alert line</DialogTitle>
          <DialogDescription>
            Discord hears about it once per cycle when the projected overage reaches this amount,
            and once more at twice it.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor={id}>Projected overage (USD)</Label>
            <Input
              id={id}
              inputMode="decimal"
              max="100000"
              min="1"
              onChange={(event) => setValue(event.target.value)}
              step="0.01"
              type="number"
              value={value}
            />
          </div>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={!valid || saving} type="submit">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
