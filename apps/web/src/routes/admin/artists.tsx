import {
  ArrowSquareOutIcon,
  ArrowUUpLeftIcon,
  CheckCircleIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  ProhibitIcon,
  TrashIcon,
  UserPlusIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type Ref, useEffect, useMemo, useRef, useState } from "react";
import {
  siBandcamp,
  siFacebook,
  siInstagram,
  siMixcloud,
  siSoundcloud,
  siSpotify,
  siTiktok,
  siX,
  siYoutube,
} from "simple-icons";
import { AdminShell } from "@/components/admin/admin-shell";
import { BrandIcon } from "@/components/brand-icon";
import { Badge } from "@fluncle/ui/components/badge";
import { Button } from "@fluncle/ui/components/button";
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
import { isAdminRequest } from "@/lib/server/admin-auth";
import {
  type ArtistOverviewItem,
  type ArtistSocial,
  listAllArtistsWithSocials,
} from "@/lib/server/artists";
import { cn } from "@/lib/utils";

// The `/admin/artists` overview — the stable MANAGE surface for every artist Fluncle
// features (Epic B, Unit 5). Not a worklist: an artist never drops off for being resolved,
// so the operator can browse, search, and edit/add/remove a link any time — when a profile
// moves, is deleted, or a missing one turns up. Each card carries the artist's finding count
// and its full socials list with inline actions: confirm a candidate (→ confirmed, which
// lets it onto the public artist page), REGISTER a manual follow (stamps followed_at) after
// tapping out, and add/remove a platform (a Select + URL Input). The WORK — which artists
// still need a look — surfaces as an /admin attention row (source "artist-review") that
// deep-links here with ?artist=<id> focused; this page is where that review is done. The
// automated Spotify/YouTube follows run on their own (the `fluncle-artist-follow` sweep).

const ARTIST_OVERVIEW_KEY = ["admin", "artists", "overview"] as const;
// The /admin attention queue's key — a confirm/follow/add here changes an artist-review row,
// so invalidate it too and the dashboard's count stays honest without waiting on a refetch.
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

// The platforms with a real follow API — the rest are link-only (manual out-and-back).
const FOLLOWABLE = new Set<ArtistSocialPlatform>(["spotify", "youtube"]);

const PLATFORM_LABELS: Record<ArtistSocialPlatform, string> = {
  bandcamp: "Bandcamp",
  facebook: "Facebook",
  homepage: "Homepage",
  instagram: "Instagram",
  mixcloud: "Mixcloud",
  soundcloud: "SoundCloud",
  spotify: "Spotify",
  tiktok: "TikTok",
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
  // Seed the query from the SSR loader (the same pattern every other admin route
  // uses) so the list renders server-side — a bare client `useQuery` with no loader
  // would SSR only its "Loading…" placeholder and hang there until a client fetch
  // fired (react-query treats an unseeded query as pending on the dehydrated first
  // paint), which is exactly what stuck this route.
  const initial = Route.useLoaderData();
  const { artist: focusId } = Route.useSearch();
  const queryClient = useQueryClient();
  const { data: artists, isLoading } = useQuery({
    initialData: initial,
    queryFn: () => fetchAllArtists(),
    queryKey: ARTIST_OVERVIEW_KEY,
  });
  const [error, setError] = useState<string | undefined>();
  // A soft, non-blocking heads-up (distinct from `error`): the follow/undo platform write is
  // best-effort, so a Spotify/YouTube API miss records the follow-state and lands its warning here.
  const [notice, setNotice] = useState<string | undefined>();
  const [query, setQuery] = useState("");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ARTIST_OVERVIEW_KEY });
    void queryClient.invalidateQueries({ queryKey: ATTENTION_KEY });
  };

  const registerFollow = useMutation({
    mutationFn: (socialId: string) =>
      mutateJson(`/api/admin/artists/socials/${socialId}/follow`, "POST"),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: invalidate,
  });
  // "Follow now" — the REAL platform follow (Spotify/YouTube) via the API, then bookkeeping.
  // The platform write is best-effort: a miss (e.g. our Spotify Development-mode app 403s every
  // artist-follow) still records the follow and lands a soft `platformWarning` — surfaced as a
  // quiet notice, not a hard error, so the row stays markable. See docs/planning/ROADMAP.md.
  const followNow = useMutation({
    mutationFn: (socialId: string) =>
      mutateJson<{ platformWarning: string | null }>(
        `/api/admin/artists/socials/${socialId}/follow-now`,
        "POST",
      ),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: (data) => {
      setNotice(data.platformWarning ?? undefined);
      invalidate();
    },
  });
  // "Undo" — reverse a follow. For Spotify/YouTube it really unfollows via the API AND mutes the
  // row so the sweep can't re-follow; for the no-API platforms it just clears the stamp. Same
  // best-effort platform write as Follow-now — a miss still clears the stamp + surfaces a notice.
  const undoFollow = useMutation({
    mutationFn: (socialId: string) =>
      mutateJson<{ platformWarning: string | null }>(
        `/api/admin/artists/socials/${socialId}/unfollow`,
        "POST",
      ),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: (data) => {
      setNotice(data.platformWarning ?? undefined);
      invalidate();
    },
  });
  // "Unmute" — clear the don't-champion skip an Undo set, so the sweep may follow again.
  const unmute = useMutation({
    mutationFn: (socialId: string) =>
      mutateJson(`/api/admin/artists/socials/${socialId}/unmute`, "POST"),
    onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    onSuccess: invalidate,
  });
  const confirmSocial = useMutation({
    mutationFn: (socialId: string) =>
      mutateJson(`/api/admin/artists/socials/${socialId}/confirm`, "POST"),
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

  const busy =
    registerFollow.isPending ||
    followNow.isPending ||
    undoFollow.isPending ||
    unmute.isPending ||
    confirmSocial.isPending ||
    removeSocial.isPending ||
    addSocial.isPending;

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () => (needle ? artists.filter((a) => a.name.toLowerCase().includes(needle)) : artists),
    [artists, needle],
  );

  // Deep-linked from the /admin attention row (?artist=<id>): scroll it into view and
  // pulse a ring so the operator lands on the artist that needs a look, not the top.
  const focusRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (focusId && focusRef.current) {
      focusRef.current.scrollIntoView({ block: "center" });
    }
  }, [focusId]);

  return (
    <AdminShell
      current="artists"
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

        {notice ? (
          <p className="mb-4 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            {notice}
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
              <ul className="m-0 flex list-none flex-col divide-y divide-border/60 p-0">
                {visible.map((artist) => (
                  <ArtistCard
                    artist={artist}
                    busy={busy}
                    focused={artist.id === focusId}
                    key={artist.id}
                    onAdd={(platform, url) =>
                      addSocial.mutate({ artistId: artist.id, platform, url })
                    }
                    onConfirm={(socialId) => confirmSocial.mutate(socialId)}
                    onFollowNow={(socialId) => followNow.mutate(socialId)}
                    onRegister={(socialId) => registerFollow.mutate(socialId)}
                    onRemove={(socialId) => removeSocial.mutate(socialId)}
                    onUndo={(socialId) => undoFollow.mutate(socialId)}
                    onUnmute={(socialId) => unmute.mutate(socialId)}
                    ref={artist.id === focusId ? focusRef : undefined}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </AdminShell>
  );
}

function ArtistCard({
  artist,
  busy,
  focused,
  onAdd,
  onConfirm,
  onFollowNow,
  onRegister,
  onRemove,
  onUndo,
  onUnmute,
  ref,
}: {
  artist: ArtistOverviewItem;
  busy: boolean;
  focused: boolean;
  onAdd: (platform: string, url: string) => void;
  onConfirm: (socialId: string) => void;
  onFollowNow: (socialId: string) => void;
  onRegister: (socialId: string) => void;
  onRemove: (socialId: string) => void;
  onUndo: (socialId: string) => void;
  onUnmute: (socialId: string) => void;
  ref?: Ref<HTMLLIElement>;
}) {
  return (
    <li
      className={cn(
        "py-5 first:pt-0 last:pb-0",
        focused && "-mx-2 rounded-md bg-primary/5 px-2 ring-1 ring-primary/40",
      )}
      ref={ref}
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="truncate text-sm font-bold text-foreground">{artist.name}</h2>
          <span className="shrink-0 text-xs text-muted-foreground">
            {artist.findingCount} {artist.findingCount === 1 ? "finding" : "findings"}
          </span>
        </div>
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

      {artist.socials.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {artist.socials.map((social) => (
            <SocialRow
              busy={busy}
              key={social.id}
              onConfirm={onConfirm}
              onFollowNow={onFollowNow}
              onRegister={onRegister}
              onRemove={onRemove}
              onUndo={onUndo}
              onUnmute={onUnmute}
              social={social}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No links yet.</p>
      )}

      <AddPlatformForm busy={busy} onAdd={onAdd} />
    </li>
  );
}

function SocialRow({
  busy,
  onConfirm,
  onFollowNow,
  onRegister,
  onRemove,
  onUndo,
  onUnmute,
  social,
}: {
  busy: boolean;
  onConfirm: (socialId: string) => void;
  onFollowNow: (socialId: string) => void;
  onRegister: (socialId: string) => void;
  onRemove: (socialId: string) => void;
  onUndo: (socialId: string) => void;
  onUnmute: (socialId: string) => void;
  social: ArtistSocial;
}) {
  const followable = FOLLOWABLE.has(social.platform);
  const followed = social.followedAt !== null;
  // Muted = the operator Undid a Spotify/YouTube follow: don't champion it, and keep the sweep
  // off it. Mutually exclusive with `followed`. Unmute re-opens it.
  const muted = social.mutedAt !== null;
  // Belt-and-suspenders: only emit a clickable href for an http(s) URL. React does NOT
  // sanitize href, so a stored `javascript:`/`data:` URL (should the write-time guard ever
  // be bypassed) would be click-to-execute XSS in the admin origin — render it inert instead.
  const safeUrl = isHttpUrl(social.url);

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-2">
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

      {social.status === "candidate" ? (
        <Badge variant="outline">Candidate</Badge>
      ) : social.status === "confirmed" ? (
        <Badge variant="secondary">Confirmed</Badge>
      ) : (
        <Badge variant="outline">Auto</Badge>
      )}

      {followed ? (
        <Badge className="gap-1" variant="secondary">
          <CheckCircleIcon aria-hidden="true" className="size-3" weight="fill" />
          {followable ? "Followed" : "Done"}
        </Badge>
      ) : muted ? (
        <Badge className="gap-1 text-muted-foreground" variant="outline">
          <ProhibitIcon aria-hidden="true" className="size-3" />
          Muted
        </Badge>
      ) : undefined}

      <div className="flex shrink-0 items-center gap-1.5">
        {social.status === "candidate" ? (
          <Button disabled={busy} onClick={() => onConfirm(social.id)} size="sm" variant="outline">
            Confirm
          </Button>
        ) : undefined}
        {!followed && !muted && followable ? (
          // Spotify/YouTube have a follow API — this button DOES the real follow (PUT
          // /me/following, subscriptions.insert) server-side, then stamps followed_at, so the
          // on-box sweep skips it. A missing-scope 403 surfaces in the error banner.
          <Button disabled={busy} onClick={() => onFollowNow(social.id)} size="sm">
            <UserPlusIcon aria-hidden="true" className="size-3.5" />
            Follow now
          </Button>
        ) : undefined}
        {!followed && !muted && !followable ? (
          // No follow API (Instagram/TikTok/…): the operator follows out-and-back, then
          // registers it here (bookkeeping — stamps followed_at, no platform call).
          <Button disabled={busy} onClick={() => onRegister(social.id)} size="sm" variant="outline">
            <UserPlusIcon aria-hidden="true" className="size-3.5" />
            Mark done
          </Button>
        ) : undefined}
        {muted ? (
          // Undo left this Spotify/YouTube row muted so the sweep won't re-follow. Unmute
          // re-opens it — the sweep may champion it again and "Follow now" returns.
          <Button disabled={busy} onClick={() => onUnmute(social.id)} size="sm" variant="outline">
            <UserPlusIcon aria-hidden="true" className="size-3.5" />
            Unmute
          </Button>
        ) : undefined}
        {followed ? (
          // Reverse it: for Spotify/YouTube a real API unfollow that also MUTES the row so the
          // sweep can't re-follow; for the no-API platforms a plain bookkeeping clear.
          <Button
            disabled={busy}
            onClick={() => onUndo(social.id)}
            size="sm"
            title={followable ? "Unfollow on the platform" : "Clear the follow record"}
            variant="ghost"
          >
            <ArrowUUpLeftIcon aria-hidden="true" className="size-3.5" />
            Undo
          </Button>
        ) : undefined}
        <Button
          aria-label="Remove this platform"
          disabled={busy}
          onClick={() => onRemove(social.id)}
          size="icon-sm"
          variant="ghost"
        >
          <TrashIcon aria-hidden="true" className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}

function AddPlatformForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (platform: string, url: string) => void;
}) {
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
    <div className="mt-3 border-t border-border/50 pt-3">
      <Label className="mb-1.5 block text-xs" htmlFor="add-platform">
        Add a platform
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          items={PLATFORM_OPTIONS.map((value) => ({ label: PLATFORM_LABELS[value], value }))}
          onValueChange={(value) => setPlatform(value as ArtistSocialPlatform)}
          value={platform}
        >
          <SelectTrigger aria-label="Platform" className="w-40 gap-2" id="add-platform" size="sm">
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
