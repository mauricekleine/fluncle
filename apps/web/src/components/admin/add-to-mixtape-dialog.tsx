import {
  ArrowSquareOutIcon,
  CassetteTapeIcon,
  CircleNotchIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { beatportSearchUrl } from "@/lib/beatport";
import { spotifyAlbumImageAtSize } from "@/lib/media";
import { mixtapeDisplayTitle, type MixtapeDTO } from "@/lib/mixtapes";
import { type MixtapeMembership } from "@/lib/server/mixtapes";

// The board's Mixtape-cell picker: drop one finding into a draft checkpoint, or
// start a fresh draft around it. Only DRAFT mixtapes take members (the server
// enforces it), so a minted/published tape never appears as a target. Adding
// APPENDS (POST /members) — the tracklist is never clobbered, and a finding already
// on the tape is skipped. The finding carries a Beatport search link so the
// buy-then-mix run starts right here.

type DialogTrack = {
  albumImageUrl?: string;
  artists: string[];
  logId?: string;
  title: string;
  trackId: string;
};

export function AddToMixtapeDialog({
  drafts,
  draftsLoading,
  memberships,
  onAdded,
  onOpenChange,
  track,
}: {
  drafts: MixtapeDTO[];
  draftsLoading: boolean;
  memberships: MixtapeMembership[];
  onAdded: (mixtapeId: string) => void;
  onOpenChange: (open: boolean) => void;
  track: DialogTrack | null;
}) {
  const [busyId, setBusyId] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const busy = creating || busyId !== undefined;

  const addTo = async (mixtapeId: string) => {
    if (!track) {
      return;
    }
    setBusyId(mixtapeId);
    setError(undefined);
    try {
      await appendMember(mixtapeId, track.trackId);
      onAdded(mixtapeId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(undefined);
    }
  };

  const addToNew = async () => {
    if (!track) {
      return;
    }
    setCreating(true);
    setError(undefined);
    try {
      const created = await createDraft();
      await appendMember(created, track.trackId);
      onAdded(created);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog onOpenChange={(next) => !busy && onOpenChange(next)} open={track !== null}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add to a mixtape</DialogTitle>
          <DialogDescription>
            Drop this finding into a draft mixtape, or start a new one.
          </DialogDescription>
        </DialogHeader>

        {track ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2.5">
              {track.albumImageUrl ? (
                <img
                  alt=""
                  className="size-9 shrink-0 rounded-sm border border-border object-cover"
                  src={spotifyAlbumImageAtSize(track.albumImageUrl, "small")}
                />
              ) : (
                <div className="track-artwork-fallback size-9 shrink-0 rounded-sm border border-border" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm">
                {track.artists.join(", ")} — {track.title}
              </span>
              <a
                className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                href={beatportSearchUrl(track.artists, track.title)}
                rel="noreferrer"
                target="_blank"
                title="Search this on Beatport"
              >
                Beatport
                <ArrowSquareOutIcon aria-hidden="true" className="size-3" />
              </a>
            </div>

            {memberships.length > 0 ? (
              <div className="space-y-1">
                <p className="text-xs font-bold text-muted-foreground">Already on</p>
                <ul className="space-y-0.5">
                  {memberships.map((membership) => {
                    const name = mixtapeDisplayTitle(membership.title) || "Draft";
                    const label = membership.logId ? `${membership.logId} · ${name}` : name;
                    return (
                      <li
                        className="flex items-center gap-1.5 text-sm text-muted-foreground"
                        key={membership.mixtapeId}
                      >
                        <CassetteTapeIcon aria-hidden="true" className="size-3.5 shrink-0" />
                        {membership.status === "published" && membership.logId ? (
                          <a
                            className="truncate hover:text-foreground hover:underline"
                            href={`/log/${encodeURIComponent(membership.logId)}`}
                            rel="noreferrer"
                            target="_blank"
                          >
                            {label}
                          </a>
                        ) : (
                          <span className="truncate">
                            {label}
                            {membership.status === "draft" ? " (draft)" : ""}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}

            <div className="space-y-2">
              <p className="text-xs font-bold text-muted-foreground">Add to a draft</p>

              {/* The drafts are the primary target — listed first and prominent. A
                  draft row is a filled action button; "New draft" sits below as the
                  secondary path (promoted to primary only when there are no drafts). */}
              {draftsLoading ? (
                <p className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                  <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
                  Loading drafts…
                </p>
              ) : drafts.length > 0 ? (
                <ul className="space-y-1.5">
                  {drafts.map((draft) => {
                    const id = draft.id as string;
                    return (
                      <li key={id}>
                        <Button
                          className="w-full justify-start gap-2.5"
                          disabled={busy}
                          onClick={() => void addTo(id)}
                        >
                          {busyId === id ? (
                            <CircleNotchIcon
                              aria-hidden="true"
                              className="animate-spin"
                              weight="bold"
                            />
                          ) : (
                            <CassetteTapeIcon aria-hidden="true" weight="fill" />
                          )}
                          <span className="min-w-0 flex-1 truncate text-left">
                            {draft.title ? mixtapeDisplayTitle(draft.title) : "Mixtape draft"}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums opacity-80">
                            {draft.memberCount} banger{draft.memberCount === 1 ? "" : "s"}
                          </span>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No draft mixtapes yet — start the first one.
                </p>
              )}

              <Button
                className="w-full justify-start"
                disabled={busy}
                onClick={() => void addToNew()}
                variant={drafts.length === 0 ? "default" : "outline"}
              >
                {creating ? (
                  <CircleNotchIcon aria-hidden="true" className="animate-spin" weight="bold" />
                ) : (
                  <PlusIcon aria-hidden="true" weight="bold" />
                )}
                New draft mixtape
              </Button>
            </div>

            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

async function createDraft(): Promise<string> {
  const response = await fetch("/api/admin/mixtapes", {
    body: JSON.stringify({}),
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as { mixtape?: { id?: string } };
  const id = body.mixtape?.id;
  if (!id) {
    throw new Error("The new draft came back without an id.");
  }
  return id;
}

async function appendMember(mixtapeId: string, ref: string): Promise<void> {
  const response = await fetch(`/api/admin/mixtapes/${encodeURIComponent(mixtapeId)}/members`, {
    body: JSON.stringify({ members: [ref] }),
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message.trim()) {
      return body.message;
    }
  } catch {
    // Fall through to text/status below.
  }
  const text = await response.text().catch(() => "");
  return text.trim() || response.statusText || `Request failed (${response.status})`;
}
