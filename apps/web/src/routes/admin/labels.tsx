import {
  CheckCircleIcon,
  CircleNotchIcon,
  DotsThreeVerticalIcon,
  ProhibitIcon,
  TagIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ReactNode, useState } from "react";
import {
  type LabelAdminItem,
  type LabelAliasCandidate,
  type LabelSeedState,
} from "@fluncle/contracts";
import { AdminShell } from "@/components/admin/admin-shell";
import { ObjectGlyph, ObjectLead, ObjectList, ObjectRow } from "@/components/admin/object-row";
import { Button } from "@fluncle/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@fluncle/ui/components/dropdown-menu";
import { findingsCount } from "@/lib/format";
import { isAdminRequest } from "@/lib/server/admin-auth";
import {
  type LabelsAdminPage,
  listLabelAliasCandidates,
  listLabelsPage,
} from "@/lib/server/labels";

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
//
// ── WHY THIS PAGES PER SECTION ──────────────────────────────────────────────────
// The crawler mints labels endlessly, so this station is a catalogue-scale surface now.
// Each of the three seed-state sections (undecided / enabled / not seeding) reads its OWN
// bounded page (`listLabelsPage`, name-sorted, ~50/page) off the `(seed_state, name)` index,
// and its finding counts come from the indexed `tracks.label_id` edge for just that page —
// never a whole-corpus fold over `tracks.label`. The undecided section leads with its TOTAL
// (the backlog size stays honest even though the rows page in). A ruling invalidates the
// whole board, so a label that moves sections refreshes both the one it left and the one it
// joined, and every section's count re-settles.

const LABELS_KEY = ["admin", "labels"] as const;
const ALIASES_KEY = [...LABELS_KEY, "aliases"] as const;

/** The infinite-query key for one seed-state section, so a ruling can invalidate the whole board. */
const sectionKey = (seedState: LabelSeedState) => [...LABELS_KEY, "section", seedState] as const;

/** The seed-state sections, in the order the work arrives: the queue, then the two settled sets. */
const SECTIONS: {
  intro: string;
  seedState: LabelSeedState;
  title: string;
}[] = [
  {
    intro:
      "A finding landed on these and nobody has ruled on them yet. Say whether the next crawl can dig from them.",
    seedState: "undecided",
    title: "Waiting on a ruling",
  },
  { intro: "The next crawl digs from these.", seedState: "enabled", title: "Seeding from" },
  {
    intro: "The next crawl skips these. Their findings are untouched.",
    seedState: "disabled",
    title: "Not seeding",
  },
];

/** The board the page hydrates from: page 1 of each section + the alias spellings to confirm. */
type LabelsBoard = {
  aliases: LabelAliasCandidate[];
  disabled: LabelsAdminPage;
  enabled: LabelsAdminPage;
  undecided: LabelsAdminPage;
};

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

// The loader's ONE round-trip: page 1 of each of the three sections plus the (already bounded)
// alias candidates, in parallel. Each section then hydrates its own infinite query from its slice.
const fetchBoard = createServerFn({ method: "GET" }).handler(async (): Promise<LabelsBoard> => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  const [undecided, enabled, disabled, aliases] = await Promise.all([
    listLabelsPage("undecided", 1),
    listLabelsPage("enabled", 1),
    listLabelsPage("disabled", 1),
    listLabelAliasCandidates(),
  ]);

  return { aliases, disabled, enabled, undecided };
});

// One numbered page of a single section — the queryFn behind each section's infinite scroll and
// the refetch a ruling invalidation fires. Re-checks the admin grant (the page guard only protects
// the render, never the server function behind it).
const fetchSection = createServerFn({ method: "GET" })
  .validator((data: { page: number; seedState: LabelSeedState }) => data)
  .handler(async ({ data }): Promise<LabelsAdminPage> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return listLabelsPage(data.seedState, data.page);
  });

// The alias candidates — bounded already (a handful per crawl), so one read, focus-refetched.
const fetchAliases = createServerFn({ method: "GET" }).handler(
  async (): Promise<LabelAliasCandidate[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return listLabelAliasCandidates();
  },
);

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/admin/labels")({
  beforeLoad: () => ensureAdmin(),
  loader: () => fetchBoard(),
  component: AdminLabelsPage,
});

function AdminLabelsPage() {
  const board = Route.useLoaderData();

  // The backlog size the operator steers by — the undecided TOTAL (the whole waiting set), not
  // the count of rows loaded so far. Read off the seed page's `count(*) over ()`.
  const waiting = board.undecided.total;
  const hasAnyLabels =
    board.undecided.total + board.enabled.total + board.disabled.total > 0 ||
    board.aliases.length > 0;

  const subtitle = !hasAnyLabels
    ? "No labels yet"
    : waiting === 0
      ? "Every label ruled"
      : `${waiting} waiting on a ruling`;

  return (
    <AdminShell subtitle={subtitle} title="Labels">
      <div className="space-y-8 p-4 sm:p-5">
        {/* The one thing an operator must know before they touch a control here. Stated
            plainly, above the rows, in the admin's functional register. */}
        <p className="max-w-2xl text-sm text-muted-foreground">
          A ruling only sets where the next crawl digs. Nothing already in the archive moves: the
          findings on a label stay exactly where they are, whichever way you rule.
        </p>

        {!hasAnyLabels ? (
          <EmptyLabels />
        ) : (
          <>
            {SECTIONS.map((section) => (
              <LabelSection
                initialPage={board[section.seedState]}
                intro={section.intro}
                key={section.seedState}
                seedState={section.seedState}
                title={section.title}
              />
            ))}

            <AliasSection initialAliases={board.aliases} />
          </>
        )}
      </div>
    </AdminShell>
  );
}

// One seed-state section, hydrating its own infinite query from the loader's page 1 and paging the
// rest in on demand. Empty sections render nothing (no heading over zero rows). The title leads with
// the section TOTAL so the backlog reads true even before the operator scrolls the rows in.
function LabelSection({
  initialPage,
  intro,
  seedState,
  title,
}: {
  initialPage: LabelsAdminPage;
  intro: string;
  seedState: LabelSeedState;
  title: string;
}) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    getNextPageParam: (lastPage) =>
      lastPage.page < lastPage.pageCount ? lastPage.page + 1 : undefined,
    initialData: { pageParams: [1], pages: [initialPage] },
    initialPageParam: 1,
    queryFn: ({ pageParam }) => fetchSection({ data: { page: pageParam, seedState } }),
    queryKey: sectionKey(seedState),
    refetchOnWindowFocus: true,
    // A short-lived seed matches the pace a crawl mints labels; without it every focus
    // re-fetched every loaded page of every section on tab-back.
    staleTime: 20_000,
  });

  const labels = data.pages.flatMap((page) => page.items);
  const total = data.pages.at(-1)?.total ?? initialPage.total;

  if (total === 0) {
    return null;
  }

  return (
    <Section intro={intro} title={`${title} · ${total}`}>
      <ObjectList>
        {labels.map((label) => (
          <LabelRow key={label.id} label={label} />
        ))}
      </ObjectList>
      {hasNextPage ? (
        <div className="pt-1 text-center">
          <Button
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
            size="sm"
            variant="outline"
          >
            {isFetchingNextPage ? (
              <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
            ) : undefined}
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : undefined}
    </Section>
  );
}

// The alias-review section — bounded (a handful of open candidates), so a plain focus-refetched
// query, seeded from the loader. Renders nothing when there is nothing to confirm.
function AliasSection({ initialAliases }: { initialAliases: LabelAliasCandidate[] }) {
  const { data: aliases } = useQuery({
    initialData: initialAliases,
    queryFn: () => fetchAliases(),
    queryKey: ALIASES_KEY,
    refetchOnWindowFocus: true,
    staleTime: 20_000,
  });

  if (aliases.length === 0) {
    return null;
  }

  return (
    <Section
      intro="Apple spells a label differently than the archive does. Where MusicBrainz agrees it's the same one, fold the spelling in so both point at one label."
      title={`Spellings to confirm · ${aliases.length}`}
    >
      <ObjectList>
        {aliases.map((alias) => (
          <AliasRow alias={alias} key={alias.id} />
        ))}
      </ObjectList>
    </Section>
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
      {children}
    </section>
  );
}

/** The finding count, spoken the way the rest of the admin speaks a count. */
function LabelRow({ label }: { label: LabelAdminItem }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | undefined>();

  const rule = useMutation({
    mutationFn: (seedState: LabelSeedState) => patchLabel(label.id, seedState),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: () => {
      setError(undefined);
      // A ruling can move a label between sections, so invalidate the WHOLE board (the section
      // it left and the one it joined both refresh, and every count re-settles).
      void queryClient.invalidateQueries({ queryKey: LABELS_KEY });
    },
  });

  return (
    <ObjectRow
      trailing={
        <>
          <span className="text-xs text-muted-foreground tabular-nums">
            {findingsCount(label.findingCount)}
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
        leading={<LabelLogo logoImageUrl={label.logoImageUrl} />}
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

// The label's OWN logo (the Discogs→R2 backfill), at the object row's md plate footprint. Falls
// back to the exact tag-icon glyph when the label has no resolved logo yet, so a label without
// an image reads exactly as it did before. Decorative (the name sits beside it), lazy-loaded.
function LabelLogo({ logoImageUrl }: { logoImageUrl: string | undefined }) {
  if (!logoImageUrl) {
    return <ObjectGlyph icon={TagIcon} />;
  }

  return (
    <img
      alt=""
      className="size-11 shrink-0 rounded-md border border-border object-cover"
      loading="lazy"
      src={logoImageUrl}
    />
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

// ── The label-alias review section (RFC musickit-second-authority, U2a) ─────────────────────
// A second authority (Apple's album `recordLabel`, corroborated by MusicBrainz over a shared
// ISRC) proposes an alternate spelling of a label; the operator confirms or rejects it here.
//
// DELIBERATELY a page SECTION, not a new attention-queue source. Alias candidates are
// crawl-volume, and the `label-review` attention source is capped at 25 (LABEL_REVIEW_QUEUE_LIMIT)
// precisely because an uncapped crawl-volume source drowns the other five in the /admin cockpit.
// Spelling curation is low-priority background work — it steers nothing and blocks nothing — so
// it lives on this page and never rides the queue.

/** One alias candidate: the proposed spelling, its provenance, and confirm/reject. */
function AliasRow({ alias }: { alias: LabelAliasCandidate }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | undefined>();

  const rule = useMutation({
    mutationFn: (decision: "confirm" | "reject") => decideAlias(alias.id, decision),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: () => {
      setError(undefined);
      // A confirmed alias folds a spelling into its label, which can change that label's counts,
      // so refresh the whole board alongside the alias list.
      void queryClient.invalidateQueries({ queryKey: LABELS_KEY });
    },
  });

  // The corroboration state, in the archive's flat functional register: a `name` alias is Apple
  // AND MusicBrainz agreeing; a `hint` is Apple alone.
  const provenance =
    alias.kind === "name" ? "Apple, matched to MusicBrainz" : "Apple only, unmatched";

  return (
    <ObjectRow
      trailing={
        rule.isPending ? (
          <CircleNotchIcon
            aria-hidden="true"
            className="size-4 text-muted-foreground motion-safe:animate-spin"
            weight="bold"
          />
        ) : (
          <>
            <Button onClick={() => rule.mutate("confirm")} size="sm">
              Fold it in
            </Button>
            <Button onClick={() => rule.mutate("reject")} size="sm" variant="outline">
              Not a match
            </Button>
          </>
        )
      }
    >
      <ObjectLead
        coordinate={alias.labelSlug}
        leading={<ObjectGlyph icon={TagIcon} />}
        subtitle={
          error ? (
            <span className="text-destructive" role="alert">
              {error}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {provenance} · folds into {alias.labelName}
            </span>
          )
        }
        title={alias.alias}
      />
    </ObjectRow>
  );
}

// The operator-tier alias ops: confirm (POST /admin/labels/aliases/{id}/confirm) and reject
// (DELETE /admin/labels/aliases/{id}). Same admin grant cookie + message-bearing errors as
// `patchLabel`.
async function decideAlias(id: string, decision: "confirm" | "reject"): Promise<void> {
  const base = `/api/v1/admin/labels/aliases/${encodeURIComponent(id)}`;
  const response = await fetch(decision === "confirm" ? `${base}/confirm` : base, {
    method: decision === "confirm" ? "POST" : "DELETE",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
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
