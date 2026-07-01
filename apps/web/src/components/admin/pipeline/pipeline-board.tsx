import { DotsThreeVerticalIcon, DownloadSimpleIcon, FolderOpenIcon } from "@phosphor-icons/react";

import {
  type BoardActions,
  type BoardProps,
  type BoardStep,
  runStep,
  type StepKey,
} from "@/components/admin/pipeline/board-model";
import { FindingLead } from "@/components/admin/pipeline/finding-lead";
import { StepNode } from "@/components/admin/pipeline/step-node";
import { type BoardRow } from "@/components/admin/use-publish";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
// The finding column: it grows to absorb the row's slack (pushing the action
// cells to the right edge) but never shrinks below a readable floor, and stays
// opaque so columns scroll cleanly underneath it. From `sm` up it's pinned (the
// `sm:sticky` on each cell); on a phone a 14rem pin would swallow most of the
// viewport, so it un-pins and scrolls with the rest of the board instead.
const LEAD_CLASS = "min-w-56 flex-1 bg-card px-4 sm:px-5";
// The pin, applied per cell so it can be dropped below `sm`. z-index keeps the
// pinned column above the step columns scrolling underneath it.
const LEAD_PIN = "sm:sticky sm:left-0";

const SHORT: Record<StepKey, string> = {
  context: "Ctx",
  discogs: "Dsc",
  enrich: "Enr",
  lastfm: "LFM",
  mixtape: "Tape",
  note: "Note",
  observation: "Obs",
  tag: "Tag",
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
  return (
    <div className={`flex shrink-0 items-center justify-center py-3.5 ${COL_CLASS}`}>
      <StepNode onClick={() => runStep(step, row, actions)} size="md" step={step} />
    </div>
  );
}
