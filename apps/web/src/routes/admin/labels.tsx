import {
  CheckCircleIcon,
  CircleNotchIcon,
  DotsThreeVerticalIcon,
  ProhibitIcon,
  TagIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ReactNode, useMemo, useState } from "react";
import { type LabelAdminItem, type LabelSeedState } from "@fluncle/contracts";
import { AdminShell } from "@/components/admin/admin-shell";
import { ObjectGlyph, ObjectLead, ObjectList, ObjectRow } from "@/components/admin/object-row";
import { Button } from "@fluncle/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@fluncle/ui/components/dropdown-menu";
import { isAdminRequest } from "@/lib/server/admin-auth";
import { listLabels } from "@/lib/server/labels";

// The `/admin/labels` station — the record-label entity and the operator's CRAWL-SEED
// control (the-archive RFC, D7). Every label a finding has ever carried is a row here.
//
// ── WHAT THE CONTROL DOES, AND ONLY WHAT IT DOES ────────────────────────────────
// Ruling on a label answers exactly one question: may the next crawl dig from this
// label? It is CRAWL SCOPE, NEVER STORAGE. Turning a label off removes it from the NEXT
// crawl's seed set and touches nothing already stored: no finding is deleted, hidden, or
// changed, and nothing a previous crawl brought in moves. The page says so in plain words
// above the rows, because an operator who thinks "disabled" means "gone" would never dare
// use it.
//
// The queue behind it: a brand-new label enters `undecided` (never silently crawled, never
// silently dropped) and surfaces as an `/admin` attention row ("a new label to rule on"),
// which deep-links here. So the page's primary goal is CLEARING that section — the two
// ruling buttons on an undecided row are the loudest thing on the page, and re-ruling a
// settled label is the rare act, tucked behind the row's ⋮ (the disclosure law).
//
// The ruling is publish-class in authority terms (it steers what Fluncle crawls next), so
// it rides the OPERATOR-tier `update_label` op — an agent token 403s.

const LABELS_KEY = ["admin", "labels"] as const;

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

const fetchLabels = createServerFn({ method: "GET" }).handler(
  async (): Promise<LabelAdminItem[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return listLabels();
  },
);

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/admin/labels")({
  beforeLoad: () => ensureAdmin(),
  loader: () => fetchLabels(),
  component: AdminLabelsPage,
});

function AdminLabelsPage() {
  const initial = Route.useLoaderData();
  const { data: labels } = useQuery({
    initialData: initial,
    queryFn: () => fetchLabels(),
    queryKey: LABELS_KEY,
  });

  const board = useMemo(
    () => ({
      disabled: labels.filter((label) => label.seedState === "disabled"),
      enabled: labels.filter((label) => label.seedState === "enabled"),
      undecided: labels.filter((label) => label.seedState === "undecided"),
    }),
    [labels],
  );

  const subtitle =
    labels.length === 0
      ? "No labels yet"
      : board.undecided.length === 0
        ? "Every label ruled"
        : `${board.undecided.length} waiting on a ruling`;

  return (
    <AdminShell subtitle={subtitle} title="Labels">
      <div className="space-y-8 p-4 sm:p-5">
        {/* The one thing an operator must know before they touch a control here. Stated
            plainly, above the rows, in the admin's functional register. */}
        <p className="max-w-2xl text-sm text-muted-foreground">
          A ruling only sets where the next crawl digs. Nothing already in the archive moves: the
          findings on a label stay exactly where they are, whichever way you rule.
        </p>

        {labels.length === 0 ? (
          <EmptyLabels />
        ) : (
          <>
            {board.undecided.length > 0 ? (
              <Section
                intro="A finding landed on these and nobody has ruled on them yet. Say whether the next crawl can dig from them."
                title={`Waiting on a ruling · ${board.undecided.length}`}
              >
                {board.undecided.map((label) => (
                  <LabelRow key={label.id} label={label} />
                ))}
              </Section>
            ) : null}

            {board.enabled.length > 0 ? (
              <Section
                intro="The next crawl digs from these."
                title={`Seeding from · ${board.enabled.length}`}
              >
                {board.enabled.map((label) => (
                  <LabelRow key={label.id} label={label} />
                ))}
              </Section>
            ) : null}

            {board.disabled.length > 0 ? (
              <Section
                intro="The next crawl skips these. Their findings are untouched."
                title={`Not seeding · ${board.disabled.length}`}
              >
                {board.disabled.map((label) => (
                  <LabelRow key={label.id} label={label} />
                ))}
              </Section>
            ) : null}
          </>
        )}
      </div>
    </AdminShell>
  );
}

// No label has been seen yet: the archive is empty, or every finding landed without one.
// Quiet and honest, no fake rows.
function EmptyLabels() {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-border bg-card/60 px-6 py-12 text-center">
      <TagIcon
        aria-hidden="true"
        className="mx-auto mb-3 size-8 text-muted-foreground"
        weight="thin"
      />
      <p className="text-sm font-medium">No labels yet</p>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Every label a finding carries lands here on its own, waiting on your ruling.
      </p>
    </div>
  );
}

function Section({
  children,
  intro,
  title,
}: {
  children: ReactNode;
  intro: string;
  title: string;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-bold">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{intro}</p>
      </div>
      <ObjectList>{children}</ObjectList>
    </section>
  );
}

/** The finding count, spoken the way the rest of the admin speaks a count. */
function findingsMeta(count: number): string {
  return `${count} finding${count === 1 ? "" : "s"}`;
}

function LabelRow({ label }: { label: LabelAdminItem }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | undefined>();

  const rule = useMutation({
    mutationFn: (seedState: LabelSeedState) => patchLabel(label.id, seedState),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: () => {
      setError(undefined);
      void queryClient.invalidateQueries({ queryKey: LABELS_KEY });
    },
  });

  return (
    <ObjectRow
      trailing={
        <>
          <span className="text-xs text-muted-foreground tabular-nums">
            {findingsMeta(label.findingCount)}
          </span>
          {rule.isPending ? (
            <CircleNotchIcon
              aria-hidden="true"
              className="size-4 text-muted-foreground motion-safe:animate-spin"
              weight="bold"
            />
          ) : label.seedState === "undecided" ? (
            // The one thing the operator came here to do: rule. Both ways are one tap, and
            // neither is dressed as destructive, because neither destroys anything.
            <>
              <Button onClick={() => rule.mutate("enabled")} size="sm">
                Seed from it
              </Button>
              <Button onClick={() => rule.mutate("disabled")} size="sm" variant="outline">
                Not our lane
              </Button>
            </>
          ) : (
            // Settled. The state reads as quiet data; changing your mind is the rare act, so
            // it lives off the resting surface behind the ⋮ (the disclosure law).
            <>
              <SeedStateChip seedState={label.seedState} />
              <RuleMenu
                name={label.name}
                onRule={(seedState) => rule.mutate(seedState)}
                seedState={label.seedState}
              />
            </>
          )}
        </>
      }
    >
      <ObjectLead
        coordinate={label.slug}
        leading={<ObjectGlyph icon={TagIcon} />}
        subtitle={
          error ? (
            <span className="text-destructive" role="alert">
              {error}
            </span>
          ) : undefined
        }
        title={label.name}
      />
    </ObjectRow>
  );
}

// A settled label's state, as quiet data (the galaxies "Named" chip precedent): an icon plus
// a word, never a coloured alarm — a skipped label is a routing decision, not a failure.
function SeedStateChip({ seedState }: { seedState: "disabled" | "enabled" }) {
  const enabled = seedState === "enabled";
  const Glyph = enabled ? CheckCircleIcon : ProhibitIcon;

  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Glyph aria-hidden="true" className="size-3.5" weight={enabled ? "fill" : "regular"} />
      {enabled ? "Seeding" : "Skipped"}
    </span>
  );
}

// Change your mind about a settled label: the two states it is not currently in. Rare, so it
// stays behind the ⋮ rather than sitting at the same weight as the ruling buttons above.
function RuleMenu({
  name,
  onRule,
  seedState,
}: {
  name: string;
  onRule: (seedState: LabelSeedState) => void;
  seedState: LabelSeedState;
}) {
  const options: Array<{ label: string; value: LabelSeedState }> = [
    { label: "Seed from it", value: "enabled" },
    { label: "Not our lane", value: "disabled" },
    { label: "Put it back in the queue", value: "undecided" },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Change the ruling for ${name}`}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <DotsThreeVerticalIcon aria-hidden="true" className="size-4" weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {options
          .filter((option) => option.value !== seedState)
          .map((option) => (
            <DropdownMenuItem key={option.value} onClick={() => onRule(option.value)}>
              {option.label}
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The operator-tier `update_label` op (PATCH /admin/labels/{id}). The browser carries the
// admin grant cookie; the fetch mirrors the galaxies naming call (JSON body, message-bearing
// errors).
async function patchLabel(id: string, seedState: LabelSeedState): Promise<void> {
  const response = await fetch(`/api/v1/admin/labels/${encodeURIComponent(id)}`, {
    body: JSON.stringify({ seedState }),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.clone().json()) as { message?: unknown };
    if (typeof data.message === "string" && data.message.trim()) {
      return data.message;
    }
  } catch {
    // Fall through to text/status below.
  }
  const text = await response.text().catch(() => "");
  return text.trim() || response.statusText || `Request failed (${response.status})`;
}
