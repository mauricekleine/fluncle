import {
  CheckCircleIcon,
  CircleNotchIcon,
  DotsThreeVerticalIcon,
  PlusIcon,
  ProhibitIcon,
  TagIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  type ArtistRule,
  type ArtistRuleInput,
  type ArtistRuleVerdict,
  type LabelAdminItem,
  type LabelAliasCandidate,
  type LabelSeedState,
} from "@fluncle/contracts";
import { readError } from "@/lib/read-error";
import { ensureAdmin } from "@/lib/admin-guard";
import { AdminShell } from "@/components/admin/admin-shell";
import { ObjectGlyph, ObjectLead, ObjectList, ObjectRow } from "@/components/admin/object-row";
import { Button } from "@fluncle/ui/components/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@fluncle/ui/components/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@fluncle/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@fluncle/ui/components/dropdown-menu";
import { Input } from "@fluncle/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@fluncle/ui/components/popover";
import { albumCoverAtSize } from "@/lib/media";
import { findingsCount } from "@/lib/format";
import { isAdminRequest } from "@/lib/server/admin-auth";
import {
  type LabelsAdminPage,
  listLabelAliasCandidates,
  listLabelsPage,
} from "@/lib/server/labels";
import { useDebounced } from "@/lib/use-debounced";
import { isMbid } from "./-artist-rule-identity";
import {
  type LabelRuleCounts,
  type RuleArtistMatch,
  labelRuleCounts,
  queuedReleaseCounts,
  ruledLabelCounts,
  searchRuleArtists,
} from "./-artist-rule-reads";

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
//
// ── ARTIST RULES: THE EXCEPTIONS TO A RULING ────────────────────────────────────────────────
// The ruling is the label-level DEFAULT. An artist rule is an exception to it, in one of two
// shapes: an enabled label may BLOCK an artist ("everything except them"), and a skipped label
// may ALLOW one ("only them"). Both are the same acquisition scope the ruling is — they change
// what the next crawl takes and touch nothing already stored — so they live behind the settled
// row's ⋮ beside the re-ruling, never at the weight of the ruling buttons.
//
// A rule matches on the artist's MusicBrainz id and nothing else (a name is not an identity: one
// act is credited two ways, and two acts share one name). So the dialog's typeahead reads the
// LOCAL `artists` table for id-carrying artists, and a pasted MBID is accepted verbatim. Nothing
// here calls MusicBrainz — a dialog render may not spend the crawler's one-request-a-second
// budget — and nothing here shows a match count, because the count that would mean anything is
// taken at ratification, where the MusicBrainz payload is in hand.

const LABELS_KEY = ["admin", "labels"] as const;
const ALIASES_KEY = [...LABELS_KEY, "aliases"] as const;
const RULES_KEY = [...LABELS_KEY, "rules"] as const;

/** One label's rule set — the dialog's own read, invalidated by its own save. */
const labelRulesKey = (labelId: string) => [...RULES_KEY, labelId] as const;

/** The infinite-query key for one seed-state section, so a ruling can invalidate the whole board. */
const sectionKey = (seedState: LabelSeedState) => [...LABELS_KEY, "section", seedState] as const;

// The seed-state sections, in the order the work arrives: the queue, then the two settled sets.
//
// The intro is SPLIT so the exception count can join the sentence that states the SCOPE, never the
// one that exists to promise storage is untouched. `scope` is the joinable head (no full stop),
// `tail` whatever must follow the count.
const SECTIONS: {
  scope: string;
  seedState: LabelSeedState;
  tail?: string;
  title: string;
}[] = [
  {
    scope: "A finding landed on these and nobody has ruled on them yet",
    seedState: "undecided",
    tail: "Say whether the next crawl can dig from them.",
    title: "Waiting on a ruling",
  },
  { scope: "The next crawl digs from these", seedState: "enabled", title: "Seeding from" },
  {
    scope: "The next crawl skips these",
    seedState: "disabled",
    tail: "Their findings are untouched.",
    title: "Not seeding",
  },
];

/**
 * One section page plus the two per-page aggregates the rows read: each visible label's rule
 * counts, and how many release nodes its re-walk still owes. Both are grouped reads bounded to
 * exactly the labels on the page — never a whole-frontier or whole-corpus fold.
 */
type LabelsSectionPage = LabelsAdminPage & {
  queued: Record<string, number>;
  rules: Record<string, LabelRuleCounts>;
};

/** The board the page hydrates from: page 1 of each section + the alias spellings to confirm. */
type LabelsBoard = {
  aliases: LabelAliasCandidate[];
  disabled: LabelsSectionPage;
  enabled: LabelsSectionPage;
  /** How many labels in each seed state carry an artist rule — the settled sections' intros. */
  ruled: Record<string, number>;
  undecided: LabelsSectionPage;
};

/** Attach the per-page rule counts + queued-release counts to a section page, in two reads. */
async function withRuleContext(page: LabelsAdminPage): Promise<LabelsSectionPage> {
  const [rules, queued] = await Promise.all([
    labelRuleCounts(page.items.map((item) => item.id)),
    queuedReleaseCounts(page.items.map((item) => item.slug)),
  ]);

  return { ...page, queued, rules };
}

// The loader's ONE round-trip: page 1 of each of the three sections plus the (already bounded)
// alias candidates, in parallel. Each section then hydrates its own infinite query from its slice.
const fetchBoard = createServerFn({ method: "GET" }).handler(async (): Promise<LabelsBoard> => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  const [undecided, enabled, disabled, aliases, ruled] = await Promise.all([
    listLabelsPage("undecided", 1),
    listLabelsPage("enabled", 1),
    listLabelsPage("disabled", 1),
    listLabelAliasCandidates(),
    ruledLabelCounts(),
  ]);
  const [undecidedPage, enabledPage, disabledPage] = await Promise.all([
    withRuleContext(undecided),
    withRuleContext(enabled),
    withRuleContext(disabled),
  ]);

  return {
    aliases,
    disabled: disabledPage,
    enabled: enabledPage,
    ruled,
    undecided: undecidedPage,
  };
});

// One numbered page of a single section — the queryFn behind each section's infinite scroll and
// the refetch a ruling invalidation fires. Re-checks the admin grant (the page guard only protects
// the render, never the server function behind it).
const fetchSection = createServerFn({ method: "GET" })
  .validator((data: { page: number; seedState: LabelSeedState }) => data)
  .handler(async ({ data }): Promise<LabelsSectionPage> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return withRuleContext(await listLabelsPage(data.seedState, data.page));
  });

// The rules dialog's artist typeahead — a page-local admin read of the LOCAL artists table (the
// `/admin/artists` search precedent), never a public operation and never a MusicBrainz call.
const fetchRuleArtists = createServerFn({ method: "GET" })
  .validator((data: { query: string }) => data)
  .handler(async ({ data }): Promise<RuleArtistMatch[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return searchRuleArtists(data.query);
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
  // `?label=<slug>` is the deep-link target: the triage ratification page links a ruled label
  // straight to its row here, which lands highlighted and scrolled into view.
  validateSearch: (search: Record<string, unknown>): { label?: string } =>
    typeof search["label"] === "string" ? { label: search["label"] } : {},
  beforeLoad: () => ensureAdmin(),
  loader: () => fetchBoard(),
  component: AdminLabelsPage,
});

function AdminLabelsPage() {
  const board = Route.useLoaderData();
  const { label: focusSlug } = Route.useSearch();
  const queryClient = useQueryClient();

  // The rules dialog is ONE controlled dialog for the whole board (the renders-page precedent),
  // opened by a row's ⋮. Mounting per target keeps its draft state fresh per label.
  const [rulesTarget, setRulesTarget] = useState<LabelAdminItem | undefined>();

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
                focusSlug={focusSlug}
                initialPage={board[section.seedState]}
                intro={sectionIntro(section, board.ruled)}
                key={section.seedState}
                onManageRules={setRulesTarget}
                seedState={section.seedState}
                title={section.title}
              />
            ))}

            <AliasSection initialAliases={board.aliases} />
          </>
        )}
      </div>

      {rulesTarget ? (
        <LabelRulesDialog
          label={rulesTarget}
          onClose={() => setRulesTarget(undefined)}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: LABELS_KEY })}
        />
      ) : null}
    </AdminShell>
  );
}

/**
 * A settled section's intro, plus how many of its labels carry an artist rule. Said on the
 * section rather than repeated on every row: the number is the operator's cue that exceptions
 * exist at all, and the rows carry which ones.
 *
 * The count joins the SCOPE clause on the operator register's em-dash — an exception qualifies
 * what the crawl takes, so hanging it off the storage promise ("Their findings are untouched")
 * would attach it to the one sentence it has nothing to do with.
 */
function sectionIntro(
  section: { scope: string; seedState: LabelSeedState; tail?: string },
  ruled: Record<string, number>,
): string {
  const count = ruled[section.seedState] ?? 0;
  const scoped =
    section.seedState === "undecided" || count === 0
      ? `${section.scope}.`
      : `${section.scope} — ${count} with an artist exception.`;

  return section.tail ? `${scoped} ${section.tail}` : scoped;
}

// One seed-state section, hydrating its own infinite query from the loader's page 1 and paging the
// rest in on demand. Empty sections render nothing (no heading over zero rows). The title leads with
// the section TOTAL so the backlog reads true even before the operator scrolls the rows in.
function LabelSection({
  focusSlug,
  initialPage,
  intro,
  onManageRules,
  seedState,
  title,
}: {
  focusSlug: string | undefined;
  initialPage: LabelsSectionPage;
  intro: string;
  onManageRules: (label: LabelAdminItem) => void;
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

  // The two per-page aggregates, folded across the loaded pages so a row can read its own.
  const queued = Object.assign({}, ...data.pages.map((page) => page.queued)) as Record<
    string,
    number
  >;
  const rules = Object.assign({}, ...data.pages.map((page) => page.rules)) as Record<
    string,
    LabelRuleCounts
  >;

  if (total === 0) {
    return null;
  }

  return (
    <Section intro={intro} title={`${title} · ${total}`}>
      <ObjectList>
        {labels.map((label) => (
          <LabelRow
            focused={label.slug === focusSlug}
            key={label.id}
            label={label}
            onManageRules={() => onManageRules(label)}
            queued={queued[label.slug] ?? 0}
            ruleCounts={rules[label.id]}
          />
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
function LabelRow({
  focused,
  label,
  onManageRules,
  queued,
  ruleCounts,
}: {
  focused: boolean;
  label: LabelAdminItem;
  onManageRules: () => void;
  queued: number;
  ruleCounts: LabelRuleCounts | undefined;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | undefined>();

  // The deep-link target (`?label=<slug>`) lands scrolled into view. A label past the first page
  // of its section simply is not mounted yet, exactly as the artists board's `?artist=` behaves.
  const rowRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (focused) {
      rowRef.current?.scrollIntoView({ block: "center" });
    }
  }, [focused]);

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
      className={focused ? "bg-primary/5" : undefined}
      ref={rowRef}
      trailing={
        <>
          <RuleChip ruleCounts={ruleCounts} seedState={label.seedState} />
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
                onManageRules={onManageRules}
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
          ) : (
            labelIdentity(label, queued)
          )
        }
        title={label.name}
      />
    </ObjectRow>
  );
}

// WHICH LABEL IS THIS? The ruling-time identity line.
//
// A ruling turns on the entity behind the name, not just its display fields. The row says what
// MusicBrainz knows about the entity behind it: its disambiguation comment (the field MB writes FOR
// exactly this problem), when and where it started, and a link straight to the MBID so the whole
// entity is one click away while ruling.
//
// Every part is optional and most labels carry none — a label with nothing to say renders NO
// subtitle at all rather than a placeholder or an empty row of separators. That is why this is a
// plain node-returning helper and not a component: `ObjectLead` renders its subtitle WRAPPER
// whenever the prop is a truthy element, so the emptiness has to be decided before the prop is
// built, never inside a child that renders nothing.
// The line also carries the WORK STILL COMING. Enabling a label, or changing its artist rules,
// re-arms that label's release nodes, and the back catalogue then lands over hours rather than at
// once. `N releases queued` is that wait, read straight off the frontier — so the operator can
// tell "the rule did nothing" from "the rule is still working through the queue". A label with an
// empty queue says nothing at all.
function labelIdentity(label: LabelAdminItem, queued: number): ReactNode | undefined {
  const foundingYear = label.foundingDate?.slice(0, 4);
  const facts = [
    label.disambiguation,
    foundingYear ? `Founded ${foundingYear}` : undefined,
    label.foundedLocation,
  ].filter((fact): fact is string => typeof fact === "string" && fact.trim().length > 0);

  if (facts.length === 0 && !label.mbLabelId && queued === 0) {
    return undefined;
  }

  const leading = facts.length > 0 || Boolean(label.mbLabelId);

  return (
    <>
      {facts.map((fact, index) => (
        <Fragment key={fact}>
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          <span className="truncate">{fact}</span>
        </Fragment>
      ))}
      {label.mbLabelId ? (
        <>
          {facts.length > 0 ? <span aria-hidden="true">·</span> : null}
          <a
            className="text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            href={`https://musicbrainz.org/label/${label.mbLabelId}`}
            rel="noreferrer"
            target="_blank"
          >
            MusicBrainz ↗
          </a>
        </>
      ) : null}
      {queued > 0 ? (
        <>
          {leading ? <span aria-hidden="true">·</span> : null}
          <span>
            {queued} {queued === 1 ? "release" : "releases"} queued
          </span>
        </>
      ) : null}
    </>
  );
}

// The exception chip — quiet data beside the seed state, and MODE-DISTINCT, because the same
// table means opposite things on the two sides of a ruling: on a seeded label a rule SUBTRACTS
// ("Except 2 artists"), on a skipped one it ADDS ("Only 3 artists"). Only the live half counts;
// a block on a skipped label changes nothing, so it is not advertised as if it did.
function RuleChip({
  ruleCounts,
  seedState,
}: {
  ruleCounts: LabelRuleCounts | undefined;
  seedState: LabelSeedState;
}) {
  // An unruled label has no default for a rule to except, so neither half is live yet — the row
  // states nothing rather than promising a crawl that is not happening.
  if (seedState === "undecided") {
    return null;
  }

  const live = seedState === "enabled" ? (ruleCounts?.block ?? 0) : (ruleCounts?.allow ?? 0);

  if (live === 0) {
    return null;
  }

  return (
    <span className="text-xs text-muted-foreground">
      {seedState === "enabled" ? "Except" : "Only"} {live} {live === 1 ? "artist" : "artists"}
    </span>
  );
}

// The label's OWN logo (the Discogs→R2 backfill), at the object row's md plate footprint. Falls
// back to the exact tag-icon glyph when the label has no resolved logo yet, so a label without
// an image reads exactly as it did before. Decorative (the name sits beside it), lazy-loaded.
//
// The plate is size-11 (44px), so it asks the owned-cover ladder for its SMALLEST rung: this is a
// 50-row board and the logo is a decorative tile beside the name, never the thing being read.
function LabelLogo({ logoImageUrl }: { logoImageUrl: string | undefined }) {
  const src = albumCoverAtSize(logoImageUrl, "small");

  if (!src) {
    return <ObjectGlyph icon={TagIcon} />;
  }

  return (
    <img
      alt=""
      className="size-11 shrink-0 rounded-md border border-border object-cover"
      loading="lazy"
      src={src}
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

// Change your mind about a settled label: the two states it is not currently in, and the artist
// exception to the state it is in. Both are rare, so both stay behind the ⋮ rather than sitting at
// the same weight as the ruling buttons above.
function RuleMenu({
  name,
  onManageRules,
  onRule,
  seedState,
}: {
  name: string;
  onManageRules: () => void;
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
        aria-label={`Ruling and artist rules for ${name}`}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <DotsThreeVerticalIcon aria-hidden="true" className="size-4" weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem onClick={onManageRules}>
          {seedState === "enabled" ? "Block an artist on it…" : "Allow an artist from it…"}
        </DropdownMenuItem>
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

// ── The artist-rule dialog (the `ManageLinksDialog` pattern, route-local) ────────────────────
// Whole-set editing, saved through one `replace_label_artist_rules` PUT: the operator adds and
// drops chips locally and commits once, which is what makes the write transactional and what
// keeps a half-authored set from ever reaching the crawler.
//
// It shows two markers a rule can carry and nothing else it cannot honestly know:
//   DRIFTED   — MusicBrainz has moved this id to another entity since the rule was written.
//               The rule still matches the id it was written with; the drift sweep stamps this.
//   TAP-BLIND — a BLOCK with no Spotify id resolved, so the freshness tap cannot see it. The
//               crawler still enforces it exactly. Never shown on an allow: allows are not the
//               tap's business (it probes seeded labels only).
//
// There is deliberately no "this would match N tracks" count here. The number that means
// something is taken at ratification, off the MusicBrainz payload; a database-side count is
// structurally near-empty and would read as "this rule does nothing".
function LabelRulesDialog({
  label,
  onClose,
  onSaved,
}: {
  label: LabelAdminItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const verdict: ArtistRuleVerdict = label.seedState === "enabled" ? "block" : "allow";

  const {
    data: saved,
    isError,
    isPending: loading,
  } = useQuery({
    queryFn: () => listLabelRules(label.id),
    queryKey: labelRulesKey(label.id),
    refetchOnWindowFocus: true,
  });

  // The draft the operator edits, seeded once from the stored set. Held apart from the query so a
  // background refetch can never wipe half-typed work.
  const [draft, setDraft] = useState<ArtistRuleInput[] | undefined>();
  useEffect(() => {
    if (saved && !draft) {
      setDraft(
        saved.map((rule) => ({
          artistMbid: rule.artistMbid,
          artistName: rule.artistName,
          verdict: rule.verdict,
        })),
      );
    }
  }, [draft, saved]);

  const savedByMbid = useMemo(
    () => new Map((saved ?? []).map((rule) => [rule.artistMbid, rule])),
    [saved],
  );

  const save = useMutation({
    mutationFn: (rules: ArtistRuleInput[]) => replaceLabelRules(label.id, rules),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: labelRulesKey(label.id) });
      onSaved();
      onClose();
    },
  });

  const rules = draft ?? [];
  const dirty =
    draft !== undefined &&
    saved !== undefined &&
    (draft.length !== saved.length ||
      draft.some((rule) => savedByMbid.get(rule.artistMbid)?.verdict !== rule.verdict));

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{label.name} — artist rules</DialogTitle>
          <DialogDescription>
            {verdict === "block"
              ? "The next crawl takes everything on this label, except the artists listed here."
              : "The next crawl takes nothing from this label, except the artists listed here."}
          </DialogDescription>
        </DialogHeader>

        {/* The boundary, stated wherever a rule is edited. */}
        <p className="text-xs text-muted-foreground">
          Rules change what the next crawl takes. Everything already here stays.
        </p>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading the rules…</p>
        ) : isError ? (
          // Never state "no exceptions" over a failed read — an unknown set and an empty one are
          // opposite facts, and the whole-set save would be authored against the wrong baseline.
          <p className="text-sm text-destructive" role="alert">
            Couldn&apos;t read this label&apos;s rules — reopen the dialog to try again.
          </p>
        ) : rules.length > 0 ? (
          <ul className="m-0 flex list-none flex-col divide-y divide-border rounded-md border border-border p-0">
            {rules.map((rule) => (
              <RuleChipRow
                key={rule.artistMbid}
                onRemove={() =>
                  setDraft(rules.filter((entry) => entry.artistMbid !== rule.artistMbid))
                }
                rule={rule}
                saved={savedByMbid.get(rule.artistMbid)}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {verdict === "block"
              ? "No exceptions. The crawl takes everything on this label."
              : "No exceptions. The crawl takes nothing from this label."}
          </p>
        )}

        <AddRuleForm
          disabled={loading || isError || save.isPending}
          onAdd={(match) =>
            setDraft([
              ...rules.filter((entry) => entry.artistMbid !== match.mbid),
              { artistMbid: match.mbid, artistName: match.name, verdict },
            ])
          }
          verdict={verdict}
        />

        {save.error ? (
          <p className="text-sm text-destructive" role="alert">
            {save.error instanceof Error ? save.error.message : String(save.error)}
          </p>
        ) : null}

        <DialogFooter>
          <Button disabled={save.isPending} onClick={onClose} size="sm" variant="outline">
            Cancel
          </Button>
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate(rules)} size="sm">
            {save.isPending ? (
              <CircleNotchIcon
                aria-hidden="true"
                className="size-3.5 motion-safe:animate-spin"
                weight="bold"
              />
            ) : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One rule in the dialog: the artist, whatever the rule row knows about itself, and a drop. */
function RuleChipRow({
  onRemove,
  rule,
  saved,
}: {
  onRemove: () => void;
  rule: ArtistRuleInput;
  saved: ArtistRule | undefined;
}) {
  const drifted = Boolean(saved?.resolvedMbid && saved.resolvedMbid !== saved.artistMbid);
  const tapBlind =
    rule.verdict === "block" && saved !== undefined && saved.artistSpotifyId === null;

  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{rule.artistName}</span>
      {drifted ? (
        <RuleMarker label="DRIFTED">
          MusicBrainz now resolves this id to another entity. The rule still matches the id it was
          written with.
        </RuleMarker>
      ) : null}
      {tapBlind ? (
        <RuleMarker label="TAP-BLIND">
          No Spotify id resolved, so the freshness tap cannot see this one. The crawler still
          enforces it exactly.
        </RuleMarker>
      ) : null}
      <Button
        aria-label={`Drop the rule for ${rule.artistName}`}
        className="text-muted-foreground hover:text-destructive"
        onClick={onRemove}
        size="icon-sm"
        variant="ghost"
      >
        <XIcon aria-hidden="true" className="size-3.5" />
      </Button>
    </li>
  );
}

/**
 * A rule's state marker. The word alone is terse operator shorthand and the explanation behind it
 * is the only place that shorthand is defined, so it opens on TAP as well as on hover — a popover
 * over a real button, never a hover-only tooltip on a synthetic tab stop.
 *
 * The trigger keeps `Button size="sm"`'s own height rather than shrinking to badge size: this
 * lives inside a `DialogContent`, which portals to `document.body` and therefore OUTSIDE
 * `.admin-workspace`, so the admin 44px touch floor cannot reach it — the control has to be
 * tappable on its own.
 */
function RuleMarker({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={`What ${label} means`}
            className="rounded-full border border-border px-2 text-[10px] font-medium text-muted-foreground"
            size="sm"
            variant="ghost"
          />
        }
      >
        {label}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 text-xs text-muted-foreground">
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** A typeahead row: an artist Fluncle already knows, or a pasted id offered as a creatable. */
type RuleArtistOption = RuleArtistMatch & { isNew?: boolean };

/**
 * Add a rule, on the shared Shadcn combobox (the `/tracks` label-filter shape): type a name to
 * search the artists Fluncle already knows, or paste a MusicBrainz artist id outright. A pasted id
 * Fluncle has never seen carries no name, so the form asks for one — the boundary rejects a
 * nameless rule, and a rule nobody can read is a rule nobody can audit.
 */
function AddRuleForm({
  disabled,
  onAdd,
  verdict,
}: {
  disabled: boolean;
  onAdd: (match: RuleArtistMatch) => void;
  verdict: ArtistRuleVerdict;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [pending, setPending] = useState<string | undefined>();
  const [name, setName] = useState("");
  const search = useDebounced(term.trim(), 250);

  // Unseeded on purpose (the loader never carried a search) and NOT focus-refetched: a typed
  // term is the operator's own scratch state, not a live board that can go stale behind them.
  const { data: matches, isFetching } = useQuery({
    enabled: search.length >= 2,
    queryFn: () => fetchRuleArtists({ data: { query: search } }),
    queryKey: [...RULES_KEY, "search", search],
    refetchOnWindowFocus: false,
  });

  // The list is trustworthy only once the debounce AND the request have settled; until then an
  // empty result means "not yet", never "nobody".
  const settled = search === term.trim() && !isFetching;

  const items = useMemo<RuleArtistOption[]>(() => {
    const hits: RuleArtistOption[] = matches ?? [];

    // A pasted id Fluncle has never crawled is still a legal rule — offer it as the creatable row.
    return settled && isMbid(search) && hits.length === 0
      ? [{ isNew: true, mbid: search, name: search }]
      : hits;
  }, [matches, search, settled]);

  const emptyMessage = !settled
    ? "Searching…"
    : search.length < 2
      ? "Type a name, or paste a MusicBrainz artist id."
      : "Nobody by that name carries a MusicBrainz id here — paste the id instead.";

  const reset = () => {
    setTerm("");
    setPending(undefined);
    setName("");
  };

  const commitPasted = () => {
    if (pending && name.trim().length > 0) {
      onAdd({ mbid: pending, name: name.trim() });
      reset();
    }
  };

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <Combobox
        disabled={disabled}
        filter={null}
        inputValue={term}
        isItemEqualToValue={(a, b) => a?.mbid === b?.mbid}
        items={items}
        itemToStringLabel={(item: RuleArtistOption | null) => item?.name ?? ""}
        onInputValueChange={(next) => setTerm(next)}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setTerm("");
          }
        }}
        onValueChange={(item: RuleArtistOption | null) => {
          if (!item) {
            return;
          }

          if (item.isNew) {
            // The id is legal but nameless — hold it and ask for the name below.
            setPending(item.mbid);
            setName("");
          } else {
            onAdd(item);
            reset();
          }
        }}
        open={open}
        value={null}
      >
        <ComboboxTrigger aria-label={verdict === "block" ? "Block an artist" : "Allow an artist"}>
          <PlusIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
          {verdict === "block" ? "Block an artist" : "Allow an artist"}
        </ComboboxTrigger>
        <ComboboxContent align="start">
          <ComboboxInput
            aria-label="Search artists by name or MusicBrainz id"
            placeholder="Name, or a MusicBrainz artist id"
          />
          <ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
          <ComboboxList>
            {items.map((item) => (
              <ComboboxItem key={item.mbid} value={item}>
                <span className="min-w-0 flex-1 truncate">
                  {item.isNew ? "Use this id" : item.name}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {item.mbid.slice(0, 8)}
                </span>
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>

      {pending ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] text-muted-foreground">{pending}</span>
          <Input
            aria-label="Artist name for the pasted MusicBrainz id"
            className="h-8 min-w-48 flex-1"
            disabled={disabled}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitPasted();
              }
            }}
            placeholder="Name this artist"
            value={name}
          />
          <Button
            disabled={disabled || name.trim().length === 0}
            onClick={commitPasted}
            size="sm"
            variant="outline"
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
            Add
          </Button>
        </div>
      ) : null}
    </div>
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

// The admin-tier `list_label_artist_rules` op (GET /admin/labels/{id}/artists) — the dialog's own
// read, so the board never carries a rule set it may not need.
async function listLabelRules(id: string): Promise<ArtistRule[]> {
  const response = await fetch(`/api/v1/admin/labels/${encodeURIComponent(id)}/artists`, {
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  const data = (await response.json()) as { rules: ArtistRule[] };

  return data.rules;
}

// The operator-tier `replace_label_artist_rules` op (PUT /admin/labels/{id}/artists). A WHOLE-SET
// swap: the server replaces the label's rules in one transaction, resolves each rule's Spotify
// bridge as it writes, and stamps the label's re-arm watermark so the next crawl tick re-walks it.
async function replaceLabelRules(id: string, rules: ArtistRuleInput[]): Promise<void> {
  const response = await fetch(`/api/v1/admin/labels/${encodeURIComponent(id)}/artists`, {
    body: JSON.stringify({ rules }),
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    method: "PUT",
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
