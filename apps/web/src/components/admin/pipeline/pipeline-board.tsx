import {
  CheckIcon,
  DotsThreeVerticalIcon,
  DownloadSimpleIcon,
  FolderOpenIcon,
} from "@phosphor-icons/react";
import { memo, useMemo } from "react";

import {
  automatedSocialsBreakdown,
  type BoardActions,
  type BoardProps,
  type BoardStep,
  runStep,
  type SocialBreakdownItem,
  type StepKey,
} from "@/components/admin/pipeline/board-model";
import { FindingLead } from "@/components/admin/pipeline/finding-lead";
import { STATE_CLASS, StepNode } from "@/components/admin/pipeline/step-node";
import { type BoardRow } from "@/components/admin/use-publish";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@fluncle/ui/components/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@fluncle/ui/components/hover-card";
import { cn } from "@/lib/utils";

const COL_W = 3.5;
const COL_CLASS = "w-14";

const MENU_COL_CLASS = "w-10";

const R2_ACCOUNT_ID = "0651fd3b33d9e0b2fe72a5f13e5cf65d";
const R2_BUCKET = "fluncle-videos";
function r2FolderUrl(logId: string) {
  const prefix = encodeURIComponent(`${logId}/`);
  return `https://dash.cloudflare.com/${R2_ACCOUNT_ID}/r2/default/buckets/${R2_BUCKET}?prefix=${prefix}`;
}

const LEAD_CLASS = "w-72 shrink-0 bg-card px-4 sm:px-5";

const LEAD_PIN = "sm:sticky sm:left-0";

const SHORT: Record<StepKey, string> = {
  context: "Ctx",
  discogs: "Dsc",
  embedding: "Emb",
  enrich: "Enr",
  mixtape: "Tape",
  note: "Note",
  observation: "Obs",
  socials: "Soc",
  tiktok: "TT",
  video: "Vid",
  youtube: "YT",
};

export function PipelineBoard({ actions, entries }: BoardProps) {
  const sample = entries[0]?.steps ?? [];
  const autoCols = sample.filter((step) => step.kind === "auto");
  const humanCols = sample.filter((step) => step.kind === "human");

  return (
    <div className="overflow-x-auto">
      <div className="w-max min-w-full">
        <div className="flex items-end border-b border-border/60">
          <div className={`z-20 py-2.5 ${LEAD_PIN} ${LEAD_CLASS}`} />
          <GroupHead label="Agents" span={autoCols.length} />
          <span aria-hidden="true" className="mx-3 self-stretch border-l border-border" />
          <GroupHead label="Yours" span={humanCols.length} />
          <div className={`shrink-0 ${MENU_COL_CLASS}`} />
        </div>

        <div className="flex items-end border-b border-border bg-card/40">
          <div
            className={`z-20 py-3 text-xs font-bold text-muted-foreground ${LEAD_PIN} ${LEAD_CLASS}`}
          >
            Finding
          </div>
          {autoCols.map((step) => (
            <ColHead key={step.key} step={step} />
          ))}
          <span aria-hidden="true" className="mx-3 self-stretch border-l border-border" />
          {humanCols.map((step) => (
            <ColHead key={step.key} step={step} />
          ))}
          <div className={`shrink-0 ${MENU_COL_CLASS}`} />
        </div>

        <ul className="m-0 list-none p-0">
          {entries.map((entry) => {
            const byKey = new Map(entry.steps.map((step) => [step.key, step]));
            return (
              <li
                className="group flex items-center border-b border-border transition-colors last:border-b-0 hover:bg-primary/5"
                key={entry.row.trackId}
              >
                <div
                  className={`z-10 py-3 transition-colors group-hover:bg-[color-mix(in_oklab,var(--card),var(--primary)_6%)] ${LEAD_PIN} ${LEAD_CLASS}`}
                >
                  <FindingLead logId onPreview={actions.onPreview} row={entry.row} size="md" />
                </div>
                {autoCols.map((col) => {
                  const step = byKey.get(col.key);
                  return step ? (
                    <Cell actions={actions} key={col.key} row={entry.row} step={step} />
                  ) : null;
                })}
                <span aria-hidden="true" className="mx-3 self-stretch border-l border-border/60" />
                {humanCols.map((col) => {
                  const step = byKey.get(col.key);
                  return step ? (
                    <Cell actions={actions} key={col.key} row={entry.row} step={step} />
                  ) : null;
                })}
                <RowMenu row={entry.row} />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function GroupHead({ label, span }: { label: string; span: number }) {
  return (
    <div
      className="shrink-0 px-1 py-2 text-center text-[11px] font-bold tracking-wide text-muted-foreground/75"
      style={{ width: `${span * COL_W}rem` }}
    >
      {label}
    </div>
  );
}

function ColHead({ step }: { step: BoardStep }) {
  return (
    <div
      className={`flex shrink-0 flex-col items-center gap-1.5 px-1 py-2.5 ${COL_CLASS}`}
      title={step.label}
    >
      <step.Icon aria-hidden="true" className="size-4 text-muted-foreground" weight="bold" />
      <span className="text-[10px] text-muted-foreground/80">{SHORT[step.key]}</span>
    </div>
  );
}

function RowMenu({ row }: { row: BoardRow }) {
  return (
    <div className={`flex shrink-0 items-center justify-center py-3.5 ${MENU_COL_CLASS}`}>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Actions for ${row.title}`}
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <DotsThreeVerticalIcon aria-hidden="true" className="size-4" weight="bold" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuItem
            disabled={!row.logId}
            render={
              row.logId ? (
                <a
                  aria-label={`Open in R2 — ${row.title}`}
                  href={r2FolderUrl(row.logId)}
                  rel="noreferrer"
                  target="_blank"
                />
              ) : undefined
            }
          >
            <FolderOpenIcon aria-hidden="true" className="size-4" />
            Open in R2
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!row.logId}
            render={
              row.logId ? (
                <a
                  aria-label={`Download silent clip — ${row.title}`}
                  href={`/api/v1/admin/tracks/${row.trackId}/silent-clip`}
                />
              ) : undefined
            }
          >
            <DownloadSimpleIcon aria-hidden="true" className="size-4" />
            Download silent clip
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function Cell({ actions, row, step }: { actions: BoardActions; row: BoardRow; step: BoardStep }) {
  if (step.key === "socials") {
    return <SocialsCell row={row} step={step} />;
  }

  return (
    <div className={`flex shrink-0 items-center justify-center py-3.5 ${COL_CLASS}`}>
      <StepNode onClick={() => runStep(step, row, actions)} size="md" step={step} />
    </div>
  );
}

function SocialsCell({ row, step }: { row: BoardRow; step: BoardStep }) {
  const items = useMemo(() => automatedSocialsBreakdown(row), [row]);
  const title = `${step.label} — ${step.statusLabel}`;

  return (
    <div className={`flex shrink-0 items-center justify-center py-3.5 ${COL_CLASS}`}>
      <HoverCard>
        <HoverCardTrigger
          aria-label={title}
          render={
            <button
              className={cn(
                "group relative flex size-8 shrink-0 cursor-default items-center justify-center rounded-full border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                STATE_CLASS[step.state],
              )}
              title={title}
              type="button"
            >
              <step.Icon
                aria-hidden="true"
                className="size-4"
                weight={step.state === "open" ? "regular" : "fill"}
              />
              {step.state === "done" ? (
                <span
                  aria-hidden="true"
                  className="absolute -right-1 -bottom-1 flex size-3 items-center justify-center rounded-full bg-primary text-primary-foreground"
                >
                  <CheckIcon className="size-2" weight="bold" />
                </span>
              ) : undefined}
            </button>
          }
        />
        <HoverCardContent align="center" side="top">
          <p className="text-xs font-bold tracking-wide text-muted-foreground">Automated socials</p>
          <SocialsBreakdown items={items} />
        </HoverCardContent>
      </HoverCard>
    </div>
  );
}

const SocialsBreakdown = memo(function SocialsBreakdown({
  items,
}: {
  items: SocialBreakdownItem[];
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {items.map((item) => (
        <li className="flex items-center gap-2 text-xs" key={item.key}>
          <item.Icon
            aria-hidden="true"
            className={cn("size-3.5", item.done ? "text-foreground" : "text-muted-foreground")}
            weight="fill"
          />
          <span className="flex-1 text-foreground">{item.label}</span>
          {item.done ? (
            <CheckIcon aria-hidden="true" className="size-3.5 text-primary" weight="bold" />
          ) : (
            <span aria-hidden="true" className="text-muted-foreground/50">
              ·
            </span>
          )}
        </li>
      ))}
    </ul>
  );
});
