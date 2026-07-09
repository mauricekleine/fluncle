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

// The pipeline board — the operator's `/admin` home. The whole pipeline as a
// pattern: every cell is one state glyph, no label, columns grouped under
// Agents | Yours (an agent does it vs your hands), the finding column pinned while
// the grid scrolls. Scan a column for "everything still needing a tag", a row for
// one finding's progress. Pipeline order is rough, not fixed — steps run in
// parallel, fail, and retry — so each cell stands alone and reads by SHAPE (round =
// agent, square = yours) and FILL (open → in-flight → done); see step-node.
//
// Density lives in two knobs so it's easy to tune: COL_W (one step column's width,
// in rem) and the glyph size. Roomy by default; tighten COL_W toward 3 to pack more
// columns on screen, widen it toward 4 to breathe more.

const COL_W = 3.5;
const COL_CLASS = "w-14";
// The trailing row-actions lane (the ⋮ menu). Narrower than a step column — it
// carries a single control, not a glyph you scan down a column.
const MENU_COL_CLASS = "w-10";

// Each finding's video + analysis artifacts live under an R2 prefix named for its
// log id (e.g. `004.0.0K/`). Non-secret, world-public identifiers — the account id
// is the same one in wrangler.jsonc — so the deep link is composed client-side.
const R2_ACCOUNT_ID = "0651fd3b33d9e0b2fe72a5f13e5cf65d";
const R2_BUCKET = "fluncle-videos";
function r2FolderUrl(logId: string) {
  const prefix = encodeURIComponent(`${logId}/`);
  return `https://dash.cloudflare.com/${R2_ACCOUNT_ID}/r2/default/buckets/${R2_BUCKET}?prefix=${prefix}`;
}
// The finding column: a FIXED width so every row's lead is identical and the step
// columns form a rigid grid that lines up row-to-row and with the header. (A `flex-1`
// lead in a `w-max` board takes its width from each row's title length, so long titles
// shove that row's columns out of alignment — the horizontal-scroll break.) It stays
// opaque so columns scroll cleanly underneath it. From `sm` up it's pinned (the
// `sm:sticky` on each cell); on a phone it un-pins and scrolls with the rest of the board.
const LEAD_CLASS = "w-72 shrink-0 bg-card px-4 sm:px-5";
// The pin, applied per cell so it can be dropped below `sm`. z-index keeps the
// pinned column above the step columns scrolling underneath it.
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
  // Column order: agents first, then your steps — derived from any row (boardSteps
  // is order-stable), so the headers and every cell line up.
  const sample = entries[0]?.steps ?? [];
  const autoCols = sample.filter((step) => step.kind === "auto");
  const humanCols = sample.filter((step) => step.kind === "human");

  return (
    <div className="overflow-x-auto">
      <div className="w-max min-w-full">
        {/* Super-headers */}
        <div className="flex items-end border-b border-border/60">
          <div className={`z-20 py-2.5 ${LEAD_PIN} ${LEAD_CLASS}`} />
          <GroupHead label="Agents" span={autoCols.length} />
          <span aria-hidden="true" className="mx-3 self-stretch border-l border-border" />
          <GroupHead label="Yours" span={humanCols.length} />
          <div className={`shrink-0 ${MENU_COL_CLASS}`} />
        </div>

        {/* Column icons + abbreviations */}
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
                {/* The pinned cell is opaque to mask scrolled columns, so the row's
                    hover wash can't show through it — it carries its own matching
                    tint on group-hover instead. */}
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
                <a href={r2FolderUrl(row.logId)} rel="noreferrer" target="_blank" />
              ) : undefined
            }
          >
            <FolderOpenIcon aria-hidden="true" className="size-4" />
            Open in R2
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!row.logId}
            render={
              row.logId ? <a href={`/api/admin/tracks/${row.trackId}/silent-clip`} /> : undefined
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
  // The automated-socials cell is a read-only aggregate; instead of a dialog it opens a
  // hover Popover showing the Last.fm love.
  if (step.key === "socials") {
    return <SocialsCell row={row} step={step} />;
  }

  return (
    <div className={`flex shrink-0 items-center justify-center py-3.5 ${COL_CLASS}`}>
      <StepNode onClick={() => runStep(step, row, actions)} size="md" step={step} />
    </div>
  );
}

// The automated-socials cell: the repurposed LFM cell. Its glyph reads by the same
// SHAPE/FILL grammar as every step (round auto glyph, done/partial/open fill), and on
// hover/focus it reveals a HoverCard listing each hands-off action — the Last.fm love —
// with a done check. A HoverCard (base-ui PreviewCard) owns the hover intent + open/close
// delays itself, so it never fights the focus/hover it's driven by — unlike a click-Popover
// forced open with manual mouse handlers, which flickers.
function SocialsCell({ row, step }: { row: BoardRow; step: BoardStep }) {
  // The breakdown derives from the row, not from hover — memoize it so an open/close doesn't
  // rebuild the array or hand a fresh identity to the list.
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

// The per-platform breakdown list. Split out and memoized so that toggling the cell's
// `open` state on hover re-renders only the Popover shell — not this list. With `items`
// memoized upstream (stable identity while the row is unchanged), the memo bails and the
// list subtree is skipped entirely on every open/close.
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
