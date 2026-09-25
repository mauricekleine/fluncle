import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  DotsThreeVerticalIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlusIcon,
  SparkleIcon,
  ThumbsUpIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type Ref, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  siBandcamp,
  siBeatport,
  siBluesky,
  siFacebook,
  siInstagram,
  siMixcloud,
  siSoundcloud,
  siSpotify,
  siTiktok,
  siTwitch,
  siX,
  siYoutube,
} from "simple-icons";
import { type ArtistRuleVerdict } from "@fluncle/contracts";
import { ensureAdmin } from "@/lib/admin-guard";
import { AdminShell } from "@/components/admin/admin-shell";
import { BrandIcon } from "@/components/brand-icon";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@fluncle/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@fluncle/ui/components/dropdown-menu";
import { Input } from "@fluncle/ui/components/input";
import { Label } from "@fluncle/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@fluncle/ui/components/select";
import {
  ARTIST_SOCIAL_PLATFORMS,
  type ArtistSocialPlatform,
  isHttpUrl,
  urlHostMatchesPlatform,
} from "@/lib/artist-socials";
import { findingsCount } from "@/lib/format";
import { isAdminRequest } from "@/lib/server/admin-auth";

import {
  artistNeedsLook,
  type ArtistOverviewItem,
  type ArtistSocial,
  type FreshLinkEntry,
  partitionFreshLinks,
} from "@/lib/artist-review";
import {
  type ArtistsPage,
  type FreshLinksData,
  listArtistsPage,
  listFreshLinks,
} from "@/lib/server/artists";
import { useDebounced } from "@/lib/use-debounced";
import { cn } from "@/lib/utils";
import { type ArtistRuleState, artistRuleStates } from "./-artist-rule-reads";

const ARTISTS_PAGE_KEY = ["admin", "artists", "page"] as const;
const ARTISTS_FRESH_KEY = ["admin", "artists", "fresh"] as const;

const ATTENTION_KEY = ["admin", "attention"] as const;

type ArtistsBoardPage = ArtistsPage & { ruleStates: Record<string, ArtistRuleState> };

const fetchArtistsPage = createServerFn({ method: "GET" })
  .validator((data: { cursor?: string; search?: string }) => data)
  .handler(async ({ data }): Promise<ArtistsBoardPage> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    const page = await listArtistsPage({
      ...(data.cursor ? { cursor: data.cursor } : {}),
      ...(data.search ? { search: data.search } : {}),
    });

    return { ...page, ruleStates: await artistRuleStates(page.items.map((item) => item.id)) };
  });

const fetchFreshLinks = createServerFn({ method: "GET" }).handler(
  async (): Promise<FreshLinksData> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return listFreshLinks();
  },
);

const PLATFORM_LABELS: Record<ArtistSocialPlatform, string> = {
  bandcamp: "Bandcamp",
  beatport: "Beatport",
  bluesky: "Bluesky",
  facebook: "Facebook",
  homepage: "Homepage",
  instagram: "Instagram",
  mixcloud: "Mixcloud",
  soundcloud: "SoundCloud",
  spotify: "Spotify",
  tiktok: "TikTok",
  twitch: "Twitch",
  twitter: "Twitter / X",
  youtube: "YouTube",
};

const PLATFORM_OPTIONS: ArtistSocialPlatform[] = [...ARTIST_SOCIAL_PLATFORMS].sort((a, b) =>
  PLATFORM_LABELS[a].localeCompare(PLATFORM_LABELS[b]),
);

function PlatformLogo({
  className,
  platform,
}: {
  className?: string;
  platform: ArtistSocialPlatform;
}) {
  switch (platform) {
    case "bandcamp":
      return <BrandIcon className={className} icon={siBandcamp} />;
    case "beatport":
      return <BrandIcon className={className} icon={siBeatport} />;
    case "bluesky":
      return <BrandIcon className={className} icon={siBluesky} />;
    case "facebook":
      return <BrandIcon className={className} icon={siFacebook} />;
    case "instagram":
      return <BrandIcon className={className} icon={siInstagram} />;
    case "mixcloud":
      return <BrandIcon className={className} icon={siMixcloud} />;
    case "soundcloud":
      return <BrandIcon className={className} icon={siSoundcloud} />;
    case "spotify":
      return <BrandIcon className={className} icon={siSpotify} />;
    case "tiktok":
      return <BrandIcon className={className} icon={siTiktok} />;
    case "twitch":
      return <BrandIcon className={className} icon={siTwitch} />;
    case "twitter":
      return <BrandIcon className={className} icon={siX} />;
    case "youtube":
      return <BrandIcon className={className} icon={siYoutube} />;
    case "homepage":
      return <GlobeIcon aria-hidden="true" className={className} weight="bold" />;
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const data = (await response.json()) as T & { message?: string; ok?: boolean };

  if (!response.ok || data.ok === false) {
    throw new Error(data.message ?? `Request failed (${response.status})`);
  }

  return data;
}

async function mutateJson<T>(url: string, method: "POST" | "DELETE"): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", method });
  const data = (await response.json()) as T & { message?: string; ok?: boolean };

  if (!response.ok || data.ok === false) {
    throw new Error(data.message ?? `Request failed (${response.status})`);
  }

  return data;
}

async function patchSocialUrl(socialId: string, url: string): Promise<{ message?: string }> {
  const response = await fetch(`/api/v1/admin/artists/socials/${socialId}`, {
    body: JSON.stringify({ url }),
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  const data = (await response.json()) as { message?: string; ok?: boolean };

  if (!response.ok || data.ok === false) {
    throw new Error(data.message ?? `Save failed (${response.status})`);
  }

  return data;
}

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/admin/artists")({
  validateSearch: (search: Record<string, unknown>): { artist?: string } =>
    typeof search["artist"] === "string" ? { artist: search["artist"] } : {},
  beforeLoad: () => ensureAdmin(),
  loader: async () => {
    const [firstPage, fresh] = await Promise.all([
      fetchArtistsPage({ data: {} }),
      fetchFreshLinks(),
    ]);
    return { firstPage, fresh };
  },
  component: AdminArtistsPage,
});

function AdminArtistsPage() {
  const { firstPage, fresh: initialFresh } = Route.useLoaderData();
  const { artist: focusId } = Route.useSearch();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const search = useDebounced(query.trim(), 250);

  const {
    data,
    error: pageError,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
  } = useInfiniteQuery({
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    ...(search === "" ? { initialData: { pageParams: [undefined], pages: [firstPage] } } : {}),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      fetchArtistsPage({
        data: { ...(pageParam ? { cursor: pageParam } : {}), ...(search ? { search } : {}) },
      }),
    queryKey: [...ARTISTS_PAGE_KEY, search],
    refetchOnWindowFocus: true,
  });

  const { data: fresh } = useQuery({
    initialData: initialFresh,
    queryFn: () => fetchFreshLinks(),
    queryKey: ARTISTS_FRESH_KEY,
    refetchOnWindowFocus: true,
  });

  const artists = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const totalCount = data?.pages.at(-1)?.totalCount ?? firstPage.totalCount;

  const ruleStates = useMemo(
    () =>
      Object.assign({}, ...(data?.pages ?? []).map((page) => page.ruleStates)) as Record<
        string,
        ArtistRuleState
      >,
    [data],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ARTISTS_PAGE_KEY });
    void queryClient.invalidateQueries({ queryKey: ARTISTS_FRESH_KEY });
    void queryClient.invalidateQueries({ queryKey: ATTENTION_KEY });
  };

  const reviewArtist = useMutation({
    mutationFn: (artistId: string) =>
      mutateJson(`/api/v1/admin/artists/${artistId}/review`, "POST"),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: invalidate,
  });
  const removeSocial = useMutation({
    mutationFn: (socialId: string) =>
      mutateJson(`/api/v1/admin/artists/socials/${socialId}`, "DELETE"),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: invalidate,
  });

  const reviewSocial = useMutation({
    mutationFn: (socialId: string) =>
      mutateJson(`/api/v1/admin/artists/socials/${socialId}/review`, "POST"),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: invalidate,
  });
  const addSocial = useMutation({
    mutationFn: (input: { artistId: string; platform: string; url: string }) =>
      fetch(`/api/v1/admin/artists/${input.artistId}/socials`, {
        body: JSON.stringify({ platform: input.platform, url: input.url }),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }).then(async (response) => {
        const data = (await response.json()) as { message?: string; ok?: boolean };
        if (!response.ok || data.ok === false) {
          throw new Error(data.message ?? `Add failed (${response.status})`);
        }
        return data;
      }),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: invalidate,
  });

  const addRule = useMutation({
    mutationFn: (input: { artistMbid: string; artistName: string; verdict: ArtistRuleVerdict }) =>
      postJson("/api/v1/admin/artist-rules", input),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: invalidate,
  });
  const removeRule = useMutation({
    mutationFn: (ruleId: string) =>
      mutateJson(`/api/v1/admin/artist-rules/${encodeURIComponent(ruleId)}`, "DELETE"),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: invalidate,
  });

  const busy =
    reviewArtist.isPending ||
    removeSocial.isPending ||
    addSocial.isPending ||
    reviewSocial.isPending ||
    addRule.isPending ||
    removeRule.isPending;

  const pageErrorMessage = pageError
    ? pageError instanceof Error
      ? pageError.message
      : String(pageError)
    : undefined;

  const focusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (focusId) {
      setExpanded((prev) => new Set(prev).add(focusId));
    }
  }, [focusId]);
  useEffect(() => {
    if (focusId && focusRef.current) {
      focusRef.current.scrollIntoView({ block: "center" });
    }
  }, [focusId, artists]);

  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel || !hasNextPage || isFetchingNextPage) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void fetchNextPage();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  return (
    <AdminShell
      subtitle={`${totalCount} ${totalCount === 1 ? "artist" : "artists"}`}
      title="Artists"
    >
      <div className="p-4 sm:p-5">
        {error ? (
          <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
            {error}
          </p>
        ) : undefined}

        <FreshLinksSection
          busy={busy}
          data={fresh}
          onApprove={(socialId) => reviewSocial.mutate(socialId)}
          onRemove={(socialId) => removeSocial.mutate(socialId)}
          onSaved={invalidate}
        />

        <div className="relative mb-4 max-w-xs">
          <MagnifyingGlassIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search artists by name"
            className="h-8 pl-8"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search artists…"
            value={query}
          />
        </div>

        {pageErrorMessage && artists.length === 0 ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-8 text-center text-sm text-foreground">
            {pageErrorMessage}
          </p>
        ) : artists.length === 0 && isFetching ? (
          <p className="rounded-md border border-border bg-card/60 px-4 py-8 text-center text-sm text-muted-foreground">
            Searching…
          </p>
        ) : artists.length === 0 ? (
          <p className="rounded-md border border-border bg-card/60 px-4 py-8 text-center text-sm text-muted-foreground">
            {search ? `No artist matches “${search}”.` : "No artists yet."}
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            {artists.map((artist) => (
              <ArtistAccordion
                artist={artist}
                busy={busy}
                expanded={expanded.has(artist.id)}
                focused={artist.id === focusId}
                key={artist.id}
                onAdd={(platform, url) => addSocial.mutate({ artistId: artist.id, platform, url })}
                onRemove={(socialId) => removeSocial.mutate(socialId)}
                onReview={() => reviewArtist.mutate(artist.id)}
                onRule={(artistMbid, verdict) =>
                  addRule.mutate({ artistMbid, artistName: artist.name, verdict })
                }
                onToggle={() => toggleExpanded(artist.id)}
                onUnrule={(ruleId) => removeRule.mutate(ruleId)}
                ref={artist.id === focusId ? focusRef : undefined}
                ruleState={ruleStates[artist.id]}
              />
            ))}
            {hasNextPage ? (
              <div className="border-t border-border" ref={loadMoreRef}>
                <button
                  className="flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 text-sm font-medium text-muted-foreground hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
                  disabled={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                  type="button"
                >
                  {isFetchingNextPage ? (
                    <CircleNotchIcon
                      aria-hidden="true"
                      className="size-4 motion-safe:animate-spin"
                      weight="bold"
                    />
                  ) : undefined}
                  {isFetchingNextPage ? "Loading more artists" : "Load more"}
                </button>
              </div>
            ) : undefined}
          </div>
        )}

        {pageErrorMessage && artists.length > 0 ? (
          <p className="mt-4 text-sm text-destructive">{pageErrorMessage}</p>
        ) : undefined}
      </div>
    </AdminShell>
  );
}

function FreshLinksSection({
  busy,
  data,
  onApprove,
  onRemove,
  onSaved,
}: {
  busy: boolean;
  data: FreshLinksData;
  onApprove: (socialId: string) => void;
  onRemove: (socialId: string) => void;
  onSaved: () => void;
}) {
  const { everythingElse, highPriority } = useMemo(
    () => partitionFreshLinks(data.artists),
    [data.artists],
  );
  const overflow = Math.max(0, data.total - data.artists.length);

  if (highPriority.length === 0 && everythingElse.length === 0) {
    return null;
  }

  return (
    <section className="mb-5 overflow-hidden rounded-lg border border-primary/30 bg-primary/5">
      <div className="flex items-center gap-2 border-b border-primary/20 px-4 py-3">
        <SparkleIcon aria-hidden="true" className="size-4 shrink-0 text-primary" weight="fill" />
        <h2 className="text-sm font-medium">Fresh links</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {highPriority.length + everythingElse.length} to review
        </span>
      </div>

      {highPriority.length > 0 ? (
        <FreshLinkGroup
          busy={busy}
          entries={highPriority}
          hint="A fresh tiktok or youtube link here can land in a finding's caption, so review these first."
          label="High priority"
          onApprove={onApprove}
          onRemove={onRemove}
          onSaved={onSaved}
        />
      ) : null}

      {everythingElse.length > 0 ? (
        <FreshLinkGroup
          busy={busy}
          entries={everythingElse}
          label="Everything else"
          onApprove={onApprove}
          onRemove={onRemove}
          onSaved={onSaved}
        />
      ) : null}

      {overflow > 0 ? (
        <p className="border-t border-primary/10 px-4 py-2.5 text-xs text-muted-foreground">
          {overflow} more {overflow === 1 ? "artist has" : "artists have"} fresh links. Review these
          to bring the next ones up.
        </p>
      ) : null}
    </section>
  );
}

function FreshLinkGroup({
  busy,
  entries,
  hint,
  label,
  onApprove,
  onRemove,
  onSaved,
}: {
  busy: boolean;
  entries: FreshLinkEntry[];
  hint?: string;
  label: string;
  onApprove: (socialId: string) => void;
  onRemove: (socialId: string) => void;
  onSaved: () => void;
}) {
  return (
    <div className="border-b border-primary/10 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 pt-3 pb-1">
        <h3 className="text-xs font-medium">{label}</h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {entries.length} {entries.length === 1 ? "link" : "links"}
        </span>
        {hint ? <p className="basis-full text-[11px] text-muted-foreground">{hint}</p> : null}
      </div>
      <ul className="m-0 flex list-none flex-col divide-y divide-border/60 p-0">
        {entries.map(({ artist, social }) => (
          <FreshLinkRow
            artistName={artist.name}
            busy={busy}
            key={social.id}
            onApprove={() => onApprove(social.id)}
            onRemove={() => onRemove(social.id)}
            onSaved={onSaved}
            social={social}
          />
        ))}
      </ul>
    </div>
  );
}

function FreshLinkRow({
  artistName,
  busy,
  onApprove,
  onRemove,
  onSaved,
  social,
}: {
  artistName: string;
  busy: boolean;
  onApprove: () => void;
  onRemove: () => void;
  onSaved: () => void;
  social: ArtistSocial;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(social.url);
  const [saveError, setSaveError] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement | null>(null);

  const save = useMutation({
    mutationFn: (nextUrl: string) => patchSocialUrl(social.id, nextUrl),
    onError: (caught) => setSaveError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: () => {
      setEditing(false);
      setSaveError(undefined);
      onSaved();
    },
  });

  useEffect(() => {
    if (editing) {
      const input = inputRef.current;
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  }, [editing]);

  const startEditing = () => {
    setDraft(social.url);
    setSaveError(undefined);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setSaveError(undefined);
    setDraft(social.url);
  };

  const trimmed = draft.trim();
  const hostMismatch =
    trimmed !== "" && isHttpUrl(trimmed) && !urlHostMatchesPlatform(social.platform, trimmed);
  const clientValid = trimmed !== "" && isHttpUrl(trimmed) && !hostMismatch;
  const rowBusy = busy || save.isPending;

  const submit = () => {
    if (clientValid && !rowBusy) {
      setSaveError(undefined);
      save.mutate(trimmed);
    }
  };

  const inlineMessage =
    saveError ??
    (hostMismatch
      ? social.platform === "homepage"
        ? "That's a social link, not a homepage"
        : `Not a ${PLATFORM_LABELS[social.platform]} link`
      : undefined);

  const safeUrl = isHttpUrl(social.url);

  return (
    <li className="flex flex-wrap items-center gap-2 px-4 py-2.5">
      <PlatformLogo className="size-4 shrink-0 text-muted-foreground" platform={social.platform} />
      <span className="shrink-0 text-xs font-medium">{artistName}</span>

      {editing ? (
        <Input
          aria-invalid={inlineMessage !== undefined}
          aria-label={`${PLATFORM_LABELS[social.platform]} URL for ${artistName}`}
          className="h-8 min-w-0 flex-1 text-xs"
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (
              saveButtonRef.current &&
              next instanceof Node &&
              saveButtonRef.current.contains(next)
            ) {
              return;
            }
            cancel();
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaveError(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          }}
          ref={inputRef}
          value={draft}
        />
      ) : safeUrl ? (
        <a
          className="inline-flex min-w-0 flex-1 items-center gap-1 truncate text-xs text-muted-foreground hover:text-primary"
          href={social.url}
          rel="noreferrer"
          target="_blank"
        >
          <span className="truncate">{social.url}</span>
          <ArrowSquareOutIcon aria-hidden="true" className="size-3 shrink-0" />
        </a>
      ) : (
        <span
          className="inline-flex min-w-0 flex-1 items-center gap-1 truncate text-xs text-muted-foreground line-through"
          title="Unsupported URL scheme — not linkable"
        >
          <span className="truncate">{social.url}</span>
        </span>
      )}

      {editing ? (
        <Button disabled={rowBusy || !clientValid} onClick={submit} ref={saveButtonRef} size="sm">
          <CheckCircleIcon aria-hidden="true" className="size-3.5" weight="fill" />
          Save
        </Button>
      ) : (
        <>
          <Button disabled={busy} onClick={onApprove} size="sm">
            <ThumbsUpIcon aria-hidden="true" className="size-3.5" />
            Approve
          </Button>
          <Button
            aria-label={`Edit ${PLATFORM_LABELS[social.platform]} link for ${artistName}`}
            className="text-muted-foreground hover:text-foreground"
            disabled={busy}
            onClick={startEditing}
            size="icon-sm"
            variant="ghost"
          >
            <PencilSimpleIcon aria-hidden="true" className="size-3.5" />
          </Button>
        </>
      )}
      <Button
        aria-label={`Remove ${PLATFORM_LABELS[social.platform]} for ${artistName}`}
        className="text-muted-foreground hover:text-destructive"
        disabled={rowBusy}
        onClick={onRemove}
        size="icon-sm"
        variant="ghost"
      >
        <TrashIcon aria-hidden="true" className="size-3.5" />
      </Button>

      {editing && inlineMessage ? (
        <p className="basis-full pl-6 text-[11px] text-destructive">{inlineMessage}</p>
      ) : null}
    </li>
  );
}

function ArtistAccordion({
  artist,
  busy,
  expanded,
  focused,
  onAdd,
  onRemove,
  onReview,
  onRule,
  onToggle,
  onUnrule,
  ref,
  ruleState,
}: {
  artist: ArtistOverviewItem;
  busy: boolean;
  expanded: boolean;
  focused: boolean;
  onAdd: (platform: string, url: string) => void;
  onRemove: (socialId: string) => void;
  onReview: () => void;
  onRule: (artistMbid: string, verdict: ArtistRuleVerdict) => void;
  onToggle: () => void;
  onUnrule: (ruleId: string) => void;
  ref?: Ref<HTMLElement>;
  ruleState: ArtistRuleState | undefined;
}) {
  const headerId = useId();
  const bodyId = useId();
  const needsLook = artistNeedsLook(artist.socials);

  return (
    <section
      className={cn("border-b border-border last:border-b-0", focused && "bg-primary/5")}
      ref={ref}
    >
      <div className="flex items-center gap-1 pr-2">
        <button
          aria-controls={bodyId}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring"
          id={headerId}
          onClick={onToggle}
          type="button"
        >
          {expanded ? (
            <CaretDownIcon aria-hidden="true" className="shrink-0 text-muted-foreground" />
          ) : (
            <CaretRightIcon aria-hidden="true" className="shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{artist.name}</span>
          {needsLook ? (
            <Badge className="shrink-0 border-primary/40 text-primary" variant="outline">
              needs a look
            </Badge>
          ) : null}
          <RuleBadge rule={ruleState?.rule ?? null} />
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {findingsCount(artist.findingCount)} · {artist.socials.length} link
            {artist.socials.length === 1 ? "" : "s"}
          </span>
        </button>
        <ArtistRuleMenu
          busy={busy}
          name={artist.name}
          onRule={onRule}
          onUnrule={onUnrule}
          state={ruleState}
        />
      </div>

      {expanded ? (
        <div aria-labelledby={headerId} className="space-y-3 px-4 pb-4 pt-1 sm:px-5" id={bodyId}>
          {artist.socials.length > 0 ? (
            <ul className="m-0 flex list-none flex-col divide-y divide-border/60 p-0">
              {artist.socials.map((social) => (
                <LinkRow key={social.id} social={social} />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No links yet. Add one to get started.</p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {artist.socials.length > 0 ? (
              needsLook ? (
                <Button disabled={busy} onClick={onReview} size="sm">
                  <ThumbsUpIcon aria-hidden="true" className="size-3.5" />
                  Looks good
                </Button>
              ) : (
                <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <CheckCircleIcon aria-hidden="true" className="size-3.5" weight="fill" />
                  Reviewed
                </span>
              )
            ) : null}
            <ManageLinksDialog artist={artist} busy={busy} onAdd={onAdd} onRemove={onRemove} />
            {artist.spotifyUrl ? (
              <a
                className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                href={artist.spotifyUrl}
                rel="noreferrer"
                target="_blank"
              >
                Spotify <ArrowSquareOutIcon aria-hidden="true" className="size-3" />
              </a>
            ) : undefined}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function RuleBadge({ rule }: { rule: ArtistRuleState["rule"] }) {
  if (!rule) {
    return null;
  }

  const label =
    rule.verdict === "block"
      ? "Never take"
      : rule.verdict === "unlisted"
        ? "No page"
        : "Always take";

  return (
    <Badge className="shrink-0 text-muted-foreground" variant="outline">
      {label}
    </Badge>
  );
}

function ArtistRuleMenu({
  busy,
  name,
  onRule,
  onUnrule,
  state,
}: {
  busy: boolean;
  name: string;
  onRule: (artistMbid: string, verdict: ArtistRuleVerdict) => void;
  onUnrule: (ruleId: string) => void;
  state: ArtistRuleState | undefined;
}) {
  const mbid = state?.mbid;
  const rule = state?.rule;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Crawl rules for ${name}`}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <DotsThreeVerticalIcon aria-hidden="true" className="size-4" weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-72 min-w-56">
        {!mbid ? (
          <DropdownMenuLabel className="font-normal">No MusicBrainz id yet</DropdownMenuLabel>
        ) : (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="font-normal text-wrap">
              Rules change what the next crawl takes, or whether this artist gets a page. Everything
              already here stays.
            </DropdownMenuLabel>
            {rule ? (
              <DropdownMenuItem disabled={busy} onClick={() => onUnrule(rule.id)}>
                Clear the rule
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem disabled={busy} onClick={() => onRule(mbid, "block")}>
                  Never take their records
                </DropdownMenuItem>
                <DropdownMenuItem disabled={busy} onClick={() => onRule(mbid, "allow")}>
                  Always take their records
                </DropdownMenuItem>

                <DropdownMenuItem disabled={busy} onClick={() => onRule(mbid, "unlisted")}>
                  Keep their records, drop their page
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LinkRow({ social }: { social: ArtistSocial }) {
  const safeUrl = isHttpUrl(social.url);

  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <PlatformLogo className="size-4 shrink-0 text-muted-foreground" platform={social.platform} />
      {safeUrl ? (
        <a
          className="inline-flex min-w-0 flex-1 items-center gap-1 truncate text-xs text-foreground hover:text-primary"
          href={social.url}
          rel="noreferrer"
          target="_blank"
        >
          <span className="truncate">{social.url}</span>
          <ArrowSquareOutIcon aria-hidden="true" className="size-3 shrink-0" />
        </a>
      ) : (
        <span
          className="inline-flex min-w-0 flex-1 items-center gap-1 truncate text-xs text-muted-foreground line-through"
          title="Unsupported URL scheme — not linkable"
        >
          <span className="truncate">{social.url}</span>
        </span>
      )}

      {social.source !== "operator" ? (
        <Badge className="shrink-0 text-muted-foreground" variant="outline">
          Auto
        </Badge>
      ) : undefined}
    </li>
  );
}

function ManageLinksDialog({
  artist,
  busy,
  onAdd,
  onRemove,
}: {
  artist: ArtistOverviewItem;
  busy: boolean;
  onAdd: (platform: string, url: string) => void;
  onRemove: (socialId: string) => void;
}) {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline">
            <PencilSimpleIcon aria-hidden="true" className="size-3.5" />
            Manage links
          </Button>
        }
      />
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{artist.name} — links</DialogTitle>
          <DialogDescription>Add or remove a link.</DialogDescription>
        </DialogHeader>

        {artist.socials.length > 0 ? (
          <ul className="m-0 flex list-none flex-col divide-y divide-border rounded-md border border-border p-0">
            {artist.socials.map((social) => (
              <li className="flex items-center gap-2 px-3 py-2" key={social.id}>
                <PlatformLogo
                  className="size-4 shrink-0 text-muted-foreground"
                  platform={social.platform}
                />
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {social.url}
                </span>
                <Button
                  aria-label={`Remove ${PLATFORM_LABELS[social.platform]}`}
                  className="text-muted-foreground hover:text-destructive"
                  disabled={busy}
                  onClick={() => onRemove(social.id)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <TrashIcon aria-hidden="true" className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No links yet.</p>
        )}

        <AddPlatformForm busy={busy} onAdd={onAdd} />
      </DialogContent>
    </Dialog>
  );
}

function AddPlatformForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (platform: string, url: string) => void;
}) {
  const selectId = useId();
  const [platform, setPlatform] = useState<ArtistSocialPlatform>("instagram");
  const [url, setUrl] = useState("");

  const submit = () => {
    const trimmed = url.trim();
    if (!trimmed) {
      return;
    }
    onAdd(platform, trimmed);
    setUrl("");
  };

  return (
    <div className="border-t border-border pt-3">
      <Label className="mb-1.5 block text-xs" htmlFor={selectId}>
        Add a platform
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          items={PLATFORM_OPTIONS.map((value) => ({ label: PLATFORM_LABELS[value], value }))}
          onValueChange={(value) => setPlatform(value as ArtistSocialPlatform)}
          value={platform}
        >
          <SelectTrigger aria-label="Platform" className="w-40 gap-2" id={selectId} size="sm">
            <PlatformLogo className="size-3.5 shrink-0 text-muted-foreground" platform={platform} />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLATFORM_OPTIONS.map((value) => (
              <SelectItem key={value} value={value}>
                <span className="flex items-center gap-2">
                  <PlatformLogo className="size-3.5" platform={value} />
                  {PLATFORM_LABELS[value]}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          aria-label="Profile URL"
          className="h-8 min-w-56 flex-1"
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submit();
            }
          }}
          placeholder="https://…"
          value={url}
        />

        <Button disabled={busy || url.trim() === ""} onClick={submit} size="sm" variant="outline">
          <PlusIcon aria-hidden="true" className="size-3.5" />
          Add
        </Button>
      </div>
    </div>
  );
}
