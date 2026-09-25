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
  type LabelAdminItem,
  type LabelAliasCandidate,
  type LabelArtistRuleVerdict,
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
  type LabelsAdminSection,
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

const LABELS_KEY = ["admin", "labels"] as const;
const ALIASES_KEY = [...LABELS_KEY, "aliases"] as const;
const RULES_KEY = [...LABELS_KEY, "rules"] as const;

const labelRulesKey = (labelId: string) => [...RULES_KEY, labelId] as const;

const sectionKey = (section: LabelsAdminSection) => [...LABELS_KEY, "section", section] as const;

const SECTIONS: {
  section: LabelsAdminSection;
  scope: string;
  tail?: string;
  title: string;
}[] = [
  {
    scope: "A finding carried these, or the crawl walked into them, and nobody has ruled yet",
    section: "undecided",
    tail: "Say whether the next crawl can dig from them.",
    title: "Waiting on a ruling",
  },
  {
    scope: "The next crawl takes the artists named on each of these, and nobody else",
    section: "partial",
    tail: "That is a ruling, not a gap — the names live behind the ⋮.",
    title: "Seeding named artists",
  },
  { scope: "The next crawl digs from these", section: "enabled", title: "Seeding from" },
  {
    scope: "The next crawl skips these",
    section: "disabled",
    tail: "Their findings are untouched.",
    title: "Not seeding",
  },
];

type LabelsSectionPage = LabelsAdminPage & {
  queued: Record<string, number>;
  rules: Record<string, LabelRuleCounts>;
};

type LabelsBoard = {
  aliases: LabelAliasCandidate[];
  disabled: LabelsSectionPage;
  enabled: LabelsSectionPage;

  partial: LabelsSectionPage;

  ruled: Record<string, number>;

  undecided: LabelsSectionPage;
};

async function withRuleContext(page: LabelsAdminPage): Promise<LabelsSectionPage> {
  const [rules, queued] = await Promise.all([
    labelRuleCounts(page.items.map((item) => item.id)),
    queuedReleaseCounts(page.items.map((item) => item.slug)),
  ]);

  return { ...page, queued, rules };
}

const fetchBoard = createServerFn({ method: "GET" }).handler(async (): Promise<LabelsBoard> => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }

  const [undecided, partial, enabled, disabled, aliases, ruled] = await Promise.all([
    listLabelsPage("undecided", 1),
    listLabelsPage("partial", 1),
    listLabelsPage("enabled", 1),
    listLabelsPage("disabled", 1),
    listLabelAliasCandidates(),
    ruledLabelCounts(),
  ]);
  const [undecidedPage, partialPage, enabledPage, disabledPage] = await Promise.all([
    withRuleContext(undecided),
    withRuleContext(partial),
    withRuleContext(enabled),
    withRuleContext(disabled),
  ]);

  return {
    aliases,
    disabled: disabledPage,
    enabled: enabledPage,
    partial: partialPage,
    ruled,
    undecided: undecidedPage,
  };
});

const fetchSection = createServerFn({ method: "GET" })
  .validator((data: { page: number; section: LabelsAdminSection }) => data)
  .handler(async ({ data }): Promise<LabelsSectionPage> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return withRuleContext(await listLabelsPage(data.section, data.page));
  });

const fetchRuleArtists = createServerFn({ method: "GET" })
  .validator((data: { query: string }) => data)
  .handler(async ({ data }): Promise<RuleArtistMatch[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return searchRuleArtists(data.query);
  });

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

  const [rulesTarget, setRulesTarget] = useState<LabelAdminItem | undefined>();

  const waiting = board.undecided.total;
  const hasAnyLabels =
    board.undecided.total + board.partial.total + board.enabled.total + board.disabled.total > 0 ||
    board.aliases.length > 0;

  const subtitle = !hasAnyLabels
    ? "No labels yet"
    : waiting === 0
      ? "Every label ruled"
      : `${waiting} waiting on a ruling`;

  return (
    <AdminShell subtitle={subtitle} title="Labels">
      <div className="space-y-8 p-4 sm:p-5">
        <p className="max-w-2xl text-sm text-muted-foreground">
          A ruling only sets where the next crawl digs. Nothing already in the archive moves: the
          findings on a label stay exactly where they are, whichever way you rule.
        </p>

        {!hasAnyLabels ? (
          <EmptyLabels />
        ) : (
          <>
            {SECTIONS.map((entry) => (
              <LabelSection
                focusSlug={focusSlug}
                initialPage={board[entry.section]}
                intro={sectionIntro(entry, board.ruled)}
                key={entry.section}
                onManageRules={setRulesTarget}
                section={entry.section}
                title={entry.title}
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

function sectionIntro(
  section: { scope: string; section: LabelsAdminSection; tail?: string },
  ruled: Record<string, number>,
): string {
  const count =
    section.section === "enabled" || section.section === "disabled"
      ? (ruled[section.section] ?? 0)
      : 0;
  const scoped =
    count === 0 ? `${section.scope}.` : `${section.scope} — ${count} with an artist exception.`;

  return section.tail ? `${scoped} ${section.tail}` : scoped;
}

function LabelSection({
  focusSlug,
  initialPage,
  intro,
  onManageRules,
  section,
  title,
}: {
  focusSlug: string | undefined;
  initialPage: LabelsSectionPage;
  intro: string;
  onManageRules: (label: LabelAdminItem) => void;
  section: LabelsAdminSection;
  title: string;
}) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    getNextPageParam: (lastPage) =>
      lastPage.page < lastPage.pageCount ? lastPage.page + 1 : undefined,
    initialData: { pageParams: [1], pages: [initialPage] },
    initialPageParam: 1,
    queryFn: ({ pageParam }) => fetchSection({ data: { page: pageParam, section } }),
    queryKey: sectionKey(section),
    refetchOnWindowFocus: true,

    staleTime: 20_000,
  });

  const labels = data.pages.flatMap((page) => page.items);
  const total = data.pages.at(-1)?.total ?? initialPage.total;

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
            section={section}
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
        Every label a finding carries, and every one the crawl walks into, lands here on its own —
        waiting on your ruling.
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

function LabelRow({
  focused,
  label,
  onManageRules,
  queued,
  ruleCounts,
  section,
}: {
  focused: boolean;
  label: LabelAdminItem;
  onManageRules: () => void;
  queued: number;
  ruleCounts: LabelRuleCounts | undefined;
  section: LabelsAdminSection;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | undefined>();

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

      void queryClient.invalidateQueries({ queryKey: LABELS_KEY });
    },
  });

  return (
    <ObjectRow
      className={focused ? "bg-primary/5" : undefined}
      ref={rowRef}
      trailing={
        <>
          <TriageChip label={label} />
          <RuleChip ruleCounts={ruleCounts} section={section} seedState={label.seedState} />
          <span className="text-xs text-muted-foreground tabular-nums">
            {findingsCount(label.findingCount)}
          </span>
          {rule.isPending ? (
            <CircleNotchIcon
              aria-hidden="true"
              className="size-4 text-muted-foreground motion-safe:animate-spin"
              weight="bold"
            />
          ) : section === "undecided" ? (
            <>
              <Button onClick={() => rule.mutate("enabled")} size="sm">
                Seed from it
              </Button>
              <Button onClick={() => rule.mutate("disabled")} size="sm" variant="outline">
                Not our lane
              </Button>
              <RuleMenu
                name={label.name}
                onManageRules={onManageRules}
                seedState={label.seedState}
              />
            </>
          ) : label.seedState === "undecided" ? (
            <RuleMenu
              name={label.name}
              onManageRules={onManageRules}
              onRule={(seedState) => rule.mutate(seedState)}
              seedState={label.seedState}
            />
          ) : (
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

// WHAT A ROUND ALREADY FOUND — the difference between an unread row and a researched one.
//
// A triage round reads every waiting label and frequently cannot rule it: a MusicBrainz entity
// holding two real labels, a catalogue too thin to read, a genuinely mixed one. Without this the
// station says only "nobody has ruled yet" for all of them, which is true and useless — it cannot
// tell a label waiting on an upstream MusicBrainz split from one waiting on him.
//
// A label no round has seen renders nothing, which is what NEVER LOOKED means. A round that DID
// rule it is not shown either: the row has already left the waiting section by then, and repeating
// the verdict beside the seed state would just say the same thing twice.
function TriageChip({ label }: { label: LabelAdminItem }) {
  if (!label.triageCheckedAt || label.triageVerdict !== "unclear") {
    return null;
  }

  return (
    <span
      className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground uppercase"
      title={
        label.triageReason
          ? `A triage round looked at this and could not rule it — ${label.triageReason}`
          : "A triage round looked at this and could not rule it"
      }
    >
      {label.triageReason ?? "unclear"}
    </span>
  );
}

// The exception chip — quiet data beside the seed state, and MODE-DISTINCT, because the same
// table means opposite things on the two sides of a ruling: on a seeded label a rule SUBTRACTS
// ("Except 2 artists"), on a skipped one it ADDS ("Only 3 artists"). Only the live half counts;
// a block on a skipped label changes nothing, so it is not advertised as if it did.
//
// An UNDECIDED label reads exactly as a skipped one: the crawl takes nothing off it by default, so
// the ALLOW half is the live one (an allow admits that artist's billed records on a non-enabled
// label, crawl.ts). That is what makes the chip the settled-partial row's state — a waiting row
// carries no rules, so it renders nothing and the promise is never made for a crawl that is not
// happening.
>>>>>>> ea49e4b4f (feat(admin-labels): say why a waiting label is still waiting)
function RuleChip({
  ruleCounts,
  section,
  seedState,
}: {
  ruleCounts: LabelRuleCounts | undefined;
  section: LabelsAdminSection;
  seedState: LabelSeedState;
}) {
  const live = seedState === "enabled" ? (ruleCounts?.block ?? 0) : (ruleCounts?.allow ?? 0);

  if (live > 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {seedState === "enabled" ? "Except" : "Only"} {live} {live === 1 ? "artist" : "artists"}
      </span>
    );
  }

  const inert = ruleCounts?.block ?? 0;

  if (section === "partial" && inert > 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {inert} inert {inert === 1 ? "rule" : "rules"}
      </span>
    );
  }

  return null;
}

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

function RuleMenu({
  name,
  onManageRules,
  onRule,
  seedState,
}: {
  name: string;
  onManageRules: () => void;
  onRule?: (seedState: LabelSeedState) => void;
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
        aria-label={onRule ? `Ruling and artist rules for ${name}` : `Artist rules for ${name}`}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <DotsThreeVerticalIcon aria-hidden="true" className="size-4" weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem onClick={onManageRules}>
          {seedState === "enabled" ? "Block an artist on it…" : "Allow an artist from it…"}
        </DropdownMenuItem>
        {onRule
          ? options
              .filter((option) => option.value !== seedState)
              .map((option) => (
                <DropdownMenuItem key={option.value} onClick={() => onRule(option.value)}>
                  {option.label}
                </DropdownMenuItem>
              ))
          : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
  const verdict: LabelArtistRuleVerdict = label.seedState === "enabled" ? "block" : "allow";

  const {
    data: saved,
    isError,
    isPending: loading,
  } = useQuery({
    queryFn: () => listLabelRules(label.id),
    queryKey: labelRulesKey(label.id),
    refetchOnWindowFocus: true,
  });

  const [draft, setDraft] = useState<ArtistRuleInput[] | undefined>();
  useEffect(() => {
    if (saved && !draft) {
      setDraft(
        saved.flatMap((rule) =>
          rule.verdict === "unlisted"
            ? []
            : [
                {
                  artistMbid: rule.artistMbid,
                  artistName: rule.artistName,
                  verdict: rule.verdict,
                },
              ],
        ),
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

        <p className="text-xs text-muted-foreground">
          Rules change what the next crawl takes. Everything already here stays.
        </p>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading the rules…</p>
        ) : isError ? (
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

type RuleArtistOption = RuleArtistMatch & { isNew?: boolean };

function AddRuleForm({
  disabled,
  onAdd,
  verdict,
}: {
  disabled: boolean;
  onAdd: (match: RuleArtistMatch) => void;
  verdict: LabelArtistRuleVerdict;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [pending, setPending] = useState<string | undefined>();
  const [name, setName] = useState("");
  const search = useDebounced(term.trim(), 250);

  const { data: matches, isFetching } = useQuery({
    enabled: search.length >= 2,
    queryFn: () => fetchRuleArtists({ data: { query: search } }),
    queryKey: [...RULES_KEY, "search", search],
    refetchOnWindowFocus: false,
  });

  const settled = search === term.trim() && !isFetching;

  const items = useMemo<RuleArtistOption[]>(() => {
    const hits: RuleArtistOption[] = matches ?? [];

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

function AliasRow({ alias }: { alias: LabelAliasCandidate }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | undefined>();

  const rule = useMutation({
    mutationFn: (decision: "confirm" | "reject") => decideAlias(alias.id, decision),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: () => {
      setError(undefined);

      void queryClient.invalidateQueries({ queryKey: LABELS_KEY });
    },
  });

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

async function decideAlias(id: string, decision: "confirm" | "reject"): Promise<void> {
  const base = `/api/v1/admin/labels/aliases/${encodeURIComponent(id)}`;
  const response = await fetch(decision === "confirm" ? `${base}/confirm` : base, {
    method: decision === "confirm" ? "POST" : "DELETE",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

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
