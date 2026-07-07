import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  GlobeIcon,
  PlusIcon,
  TrashIcon,
  UserPlusIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
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
import { isAdminRequest } from "@/lib/server/admin-auth";
import {
  ARTIST_SOCIAL_PLATFORMS,
  type ArtistFollowQueueItem,
  type ArtistSocial,
  type ArtistSocialPlatform,
  isHttpUrl,
  listArtistSocialsQueue,
} from "@/lib/server/artists";

// The `/admin/artists` follow queue — the manual half of the championing motion (Epic B,
// Unit 5). It reuses the retired `/admin/tag` shape: a worklist narrowed to the not-yet-
// done backlog (artists with a `candidate` social to confirm, or a followable social not
// yet followed), one card per artist with deep links out to each profile. The operator
// taps out to follow, then one-tap REGISTERS it (stamps followed_at) and CONFIRMS a
// candidate (candidate → confirmed, which also lets it onto the public artist page).
// Add/remove a platform inline (a Select + a URL Input). The automated Spotify/YouTube
// follows run on their own (the `fluncle-artist-follow` sweep); this is the human motion
// for the platforms with no follow API.

const ARTIST_QUEUE_KEY = ["admin", "artists", "queue"] as const;

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

const fetchArtistQueue = createServerFn({ method: "GET" }).handler(
  async (): Promise<ArtistFollowQueueItem[]> => {
    if (!(await isAdminRequest())) {
      throw redirect({ to: "/admin/login" });
    }

    return listArtistSocialsQueue();
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
  beforeLoad: () => ensureAdmin(),
  component: AdminArtistsPage,
});

function AdminArtistsPage() {
  const queryClient = useQueryClient();
  const { data: artists = [], isLoading } = useQuery({
    queryFn: () => fetchArtistQueue(),
    queryKey: ARTIST_QUEUE_KEY,
  });
  const [error, setError] = useState<string | undefined>();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ARTIST_QUEUE_KEY });

  const registerFollow = useMutation({
    mutationFn: (socialId: string) =>
      mutateJson(`/api/admin/artists/socials/${socialId}/follow`, "POST"),
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
    confirmSocial.isPending ||
    removeSocial.isPending ||
    addSocial.isPending;

  return (
    <AdminShell
      current="artists"
      subtitle={
        isLoading
          ? "Loading the follow queue…"
          : `${artists.length} ${artists.length === 1 ? "artist" : "artists"} need a look`
      }
      title="Artists"
    >
      {error ? (
        <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
          {error}
        </p>
      ) : undefined}

      {!isLoading && artists.length === 0 ? (
        <p className="rounded-md border border-border bg-card/60 px-4 py-8 text-center text-sm text-muted-foreground">
          Every artist is followed and confirmed. Nothing to champion right now.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {artists.map((artist) => (
            <ArtistCard
              artist={artist}
              busy={busy}
              key={artist.id}
              onAdd={(platform, url) => addSocial.mutate({ artistId: artist.id, platform, url })}
              onConfirm={(socialId) => confirmSocial.mutate(socialId)}
              onRegister={(socialId) => registerFollow.mutate(socialId)}
              onRemove={(socialId) => removeSocial.mutate(socialId)}
            />
          ))}
        </ul>
      )}
    </AdminShell>
  );
}

function ArtistCard({
  artist,
  busy,
  onAdd,
  onConfirm,
  onRegister,
  onRemove,
}: {
  artist: ArtistFollowQueueItem;
  busy: boolean;
  onAdd: (platform: string, url: string) => void;
  onConfirm: (socialId: string) => void;
  onRegister: (socialId: string) => void;
  onRemove: (socialId: string) => void;
}) {
  return (
    <li className="rounded-lg border border-border bg-card/70 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="truncate text-sm font-bold text-foreground">{artist.name}</h2>
        {artist.spotifyUrl ? (
          <a
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            href={artist.spotifyUrl}
            rel="noreferrer"
            target="_blank"
          >
            Spotify <ArrowSquareOutIcon aria-hidden="true" className="size-3" />
          </a>
        ) : undefined}
      </div>

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {artist.socials.map((social) => (
          <SocialRow
            busy={busy}
            key={social.id}
            onConfirm={onConfirm}
            onRegister={onRegister}
            onRemove={onRemove}
            social={social}
          />
        ))}
      </ul>

      <AddPlatformForm busy={busy} onAdd={onAdd} />
    </li>
  );
}

function SocialRow({
  busy,
  onConfirm,
  onRegister,
  onRemove,
  social,
}: {
  busy: boolean;
  onConfirm: (socialId: string) => void;
  onRegister: (socialId: string) => void;
  onRemove: (socialId: string) => void;
  social: ArtistSocial;
}) {
  const followable = FOLLOWABLE.has(social.platform);
  const followed = social.followedAt !== null;
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
      ) : undefined}

      <div className="flex shrink-0 items-center gap-1.5">
        {social.status === "candidate" ? (
          <Button disabled={busy} onClick={() => onConfirm(social.id)} size="sm" variant="outline">
            Confirm
          </Button>
        ) : undefined}
        {!followed ? (
          <Button disabled={busy} onClick={() => onRegister(social.id)} size="sm">
            <UserPlusIcon aria-hidden="true" className="size-3.5" />
            {followable ? "Followed it" : "Mark done"}
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
    <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border/50 pt-3">
      <div className="space-y-1.5">
        <Label className="text-xs" htmlFor="add-platform">
          Add a platform
        </Label>
        <Select
          items={ARTIST_SOCIAL_PLATFORMS.map((value) => ({ label: PLATFORM_LABELS[value], value }))}
          onValueChange={(value) => setPlatform(value as ArtistSocialPlatform)}
          value={platform}
        >
          <SelectTrigger aria-label="Platform" className="w-40 gap-2" id="add-platform" size="sm">
            <PlatformLogo className="size-3.5 shrink-0 text-muted-foreground" platform={platform} />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ARTIST_SOCIAL_PLATFORMS.map((value) => (
              <SelectItem key={value} value={value}>
                <span className="flex items-center gap-2">
                  <PlatformLogo className="size-3.5" platform={value} />
                  {PLATFORM_LABELS[value]}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

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
  );
}
