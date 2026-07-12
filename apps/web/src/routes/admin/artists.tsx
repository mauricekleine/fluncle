import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlusIcon,
  ThumbsUpIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type Ref, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  siBandcamp,
  siBeatport,
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
} from "@/lib/artist-socials";
import { findingsCount } from "@/lib/format";
import { isAdminRequest } from "@/lib/server/admin-auth";
import {
  artistNeedsLook,
  type ArtistOverviewItem,
  type ArtistSocial,
  listAllArtistsWithSocials,
} from "@/lib/server/artists";
import { cn } from "@/lib/utils";

// The `/admin/artists` overview — the stable MANAGE surface for every artist Fluncle features
// (Unit 5). Not a worklist: an artist never drops off for being resolved, so the operator can
// browse, search, and edit/add/remove a link any time. Following the admin design doctrine
// (docs/admin-shell.md — one primary per object, rare actions hidden by default), each artist
// is a COLLAPSED summary row (name, finding count, link count, a "needs a look" flag) that
// expands to reveal its links (read-only) and ONE acknowledgment: "Looks good".
//
// The review model (ratified 2026-07-08): "needs a look" means Fluncle FOUND links the operator
// hasn't seen yet. "Looks good" (review_artist) stamps the whole list seen and promotes any
// surviving candidates onto the public artist page (the trust gate that feeds `sameAs`); a link
// discovered LATER re-arms the flag (artistNeedsLook, off reviewedAt vs each link's createdAt).
// The structural edits — add, remove — live behind the "Manage links" dialog. The WORK surfaces
// as an /admin attention row (source "artist-review") that deep-links here with ?artist=<id>,
// auto-expanding that artist.

const ARTIST_OVERVIEW_KEY = ["admin", "artists", "overview"] as const;
// The /admin attention queue's key — a confirm/add here changes an artist-review row, so
// invalidate it too and the dashboard's count stays honest without waiting on a refetch.
const ATTENTION_KEY = ["admin", "attention"] as const;

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

const fetchAllArtists = createServerFn({ method: "GET" }).handler(
  async (): Promise<ArtistOverviewItem[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return listAllArtistsWithSocials();
  },
);

const PLATFORM_LABELS: Record<ArtistSocialPlatform, string> = {
  bandcamp: "Bandcamp",
  beatport: "Beatport",
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

// The add-platform Select lists platforms alphabetically by their display label
// (the canonical registry order is resolution priority, not a menu order).
const PLATFORM_OPTIONS: ArtistSocialPlatform[] = [...ARTIST_SOCIAL_PLATFORMS].sort((a, b) =>
  PLATFORM_LABELS[a].localeCompare(PLATFORM_LABELS[b]),
);

// The brand marks (simple-icons) for each platform; `homepage` has no brand, so it uses
// a Phosphor globe (an interface icon — DESIGN.md's platform-vs-interface split).
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

async function mutateJson<T>(url: string, method: "POST" | "DELETE"): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", method });
  const data = (await response.json()) as T & { message?: string; ok?: boolean };

  if (!response.ok || data.ok === false) {
    throw new Error(data.message ?? `Request failed (${response.status})`);
  }

  return data;
}

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/admin/artists")({
  validateSearch: (search: Record<string, unknown>): { artist?: string } =>
    typeof search["artist"] === "string" ? { artist: search["artist"] } : {},
  beforeLoad: () => ensureAdmin(),
  loader: () => fetchAllArtists(),
  component: AdminArtistsPage,
});

function AdminArtistsPage() {
  // Seed the query from the SSR loader (the same pattern every other admin route uses) so the
  // list renders server-side.
  const initial = Route.useLoaderData();
  const { artist: focusId } = Route.useSearch();
  const queryClient = useQueryClient();
  const { data: artists, isLoading } = useQuery({
    initialData: initial,
    queryFn: () => fetchAllArtists(),
    queryKey: ARTIST_OVERVIEW_KEY,
    refetchOnWindowFocus: true,
  });
  const [error, setError] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

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
    void queryClient.invalidateQueries({ queryKey: ARTIST_OVERVIEW_KEY });
    void queryClient.invalidateQueries({ queryKey: ATTENTION_KEY });
  };

  // "Looks good" — acknowledge the whole link list (review_artist): stamp it seen + promote any
  // surviving candidates. Clears needs-a-look until a NEW link is discovered.
  const reviewArtist = useMutation({
    mutationFn: (artistId: string) => mutateJson(`/api/admin/artists/${artistId}/review`, "POST"),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: invalidate,
  });
  const removeSocial = useMutation({
    mutationFn: (socialId: string) =>
      mutateJson(`/api/admin/artists/socials/${socialId}`, "DELETE"),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: invalidate,
  });
  const addSocial = useMutation({
    mutationFn: (input: { artistId: string; platform: string; url: string }) =>
      fetch(`/api/admin/artists/${input.artistId}/socials`, {
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

  const busy = reviewArtist.isPending || removeSocial.isPending || addSocial.isPending;

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () => (needle ? artists.filter((a) => a.name.toLowerCase().includes(needle)) : artists),
    [artists, needle],
  );

  // Deep-linked from the /admin attention row (?artist=<id>): auto-expand it, scroll it into
  // view, and ring it so the operator lands on the artist that needs a look, ready to review.
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
  }, [focusId]);

  return (
    <AdminShell
      subtitle={
        isLoading
          ? "Loading artists…"
          : `${artists.length} ${artists.length === 1 ? "artist" : "artists"}`
      }
      title="Artists"
    >
      <div className="p-4 sm:p-5">
        {error ? (
          <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
            {error}
          </p>
        ) : undefined}

        {!isLoading && artists.length === 0 ? (
          <p className="rounded-md border border-border bg-card/60 px-4 py-8 text-center text-sm text-muted-foreground">
            No artists yet.
          </p>
        ) : (
          <>
            <div className="relative mb-4 max-w-xs">
              <MagnifyingGlassIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="Filter artists by name"
                className="h-8 pl-8"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter artists…"
                value={query}
              />
            </div>

            {visible.length === 0 ? (
              <p className="px-1 py-8 text-center text-sm text-muted-foreground">
                No artist matches “{query.trim()}”.
              </p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                {visible.map((artist) => (
                  <ArtistAccordion
                    artist={artist}
                    busy={busy}
                    expanded={expanded.has(artist.id)}
                    focused={artist.id === focusId}
                    key={artist.id}
                    onAdd={(platform, url) =>
                      addSocial.mutate({ artistId: artist.id, platform, url })
                    }
                    onRemove={(socialId) => removeSocial.mutate(socialId)}
                    onReview={() => reviewArtist.mutate(artist.id)}
                    onToggle={() => toggleExpanded(artist.id)}
                    ref={artist.id === focusId ? focusRef : undefined}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </AdminShell>
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
  onToggle,
  ref,
}: {
  artist: ArtistOverviewItem;
  busy: boolean;
  expanded: boolean;
  focused: boolean;
  onAdd: (platform: string, url: string) => void;
  onRemove: (socialId: string) => void;
  onReview: () => void;
  onToggle: () => void;
  ref?: Ref<HTMLElement>;
}) {
  const headerId = useId();
  const bodyId = useId();
  const needsLook = artistNeedsLook(artist.reviewedAt, artist.socials);

  return (
    <section
      className={cn("border-b border-border last:border-b-0", focused && "bg-primary/5")}
      ref={ref}
    >
      <button
        aria-controls={bodyId}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring"
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
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {findingsCount(artist.findingCount)} · {artist.socials.length} link
          {artist.socials.length === 1 ? "" : "s"}
        </span>
      </button>

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
            {/* The one acknowledgment: Looks good stamps the whole list seen (and promotes any
                surviving candidates). It only appears while there's something new to see; once
                reviewed, a quiet "Reviewed" marker holds until a new link re-arms the flag. */}
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

// One link in the expanded list — READ-ONLY: the platform, its URL (click through to the
// profile), and a quiet provenance chip. No per-link todo: acknowledging the whole list is the
// operator's one action (Looks good).
function LinkRow({ social }: { social: ArtistSocial }) {
  // Belt-and-suspenders: only emit a clickable href for an http(s) URL. React does NOT sanitize
  // href, so a stored `javascript:`/`data:` URL would be click-to-execute XSS in the admin
  // origin — render it inert instead.
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

      {/* Quiet provenance: a link Fluncle discovered (MusicBrainz / Firecrawl) vs one the
          operator typed in. */}
      {social.source !== "operator" ? (
        <Badge className="shrink-0 text-muted-foreground" variant="outline">
          Auto
        </Badge>
      ) : undefined}
    </li>
  );
}

// The structural edits, off the resting surface (doctrine: rare actions hidden by default).
// Lists every link with a Remove, plus the Add-a-platform form.
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
