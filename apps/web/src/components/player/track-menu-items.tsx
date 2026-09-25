import { BookmarkSimpleIcon, ShareNetworkIcon } from "@phosphor-icons/react";
import { type ReactNode } from "react";
import { DropdownMenuItem } from "@fluncle/ui/components/dropdown-menu";
import { announce } from "@/lib/announce";
import { MAX_SAVED_TRACKS, type SavableTrack, useIsSaved } from "@/lib/saved-tracks";
import { type ToggleOutcome, toggleSavedTrack } from "@/lib/saved-tracks-sync";
import { canonicalShareUrl, type ShareOutcome, shareLink } from "@/lib/share-track";

export const SAVE_LABEL = "Save";
export const UNSAVE_LABEL = "Remove from saves";
export const SHARE_LABEL = "Share";

export const UNSAVE_FAILED_ANNOUNCEMENT =
  "Couldn't remove that save, so it's still there. Try again in a moment.";

export function saveAnnouncement(toggle: ToggleOutcome): string {
  if (toggle.outcome === "full") {
    return `${MAX_SAVED_TRACKS} saves is all this device holds. Join the crew to keep saving, or remove a save to make room.`;
  }

  if (toggle.outcome === "removed") {
    return toggle.kept === "page"
      ? "Removed for now, but that track comes back after a reload."
      : "Removed from saves.";
  }

  if (toggle.kept === "page") {
    return "Saved for now, but this browser won't keep that track past a reload or a closed tab.";
  }

  return toggle.kept === "account" ? "Saved to your account." : "Saved on this device.";
}

export function toggleSaveAndAnnounce(track: SavableTrack): void {
  announce(
    saveAnnouncement(
      toggleSavedTrack(track, fetch, {
        onUnsaveFailed: () => announce(UNSAVE_FAILED_ANNOUNCEMENT),
      }),
    ),
  );
}

export function shareAnnouncement(outcome: ShareOutcome): string | undefined {
  if (outcome === "copied") {
    return "Link copied. Send it to the crew.";
  }

  return outcome === "failed" ? "Couldn't copy the link." : undefined;
}

export async function shareAndAnnounce(title: string, url: string): Promise<void> {
  const message = shareAnnouncement(await shareLink(title, url));

  if (message) {
    announce(message);
  }
}

export function SaveMenuItem({ track }: { track: SavableTrack }): ReactNode {
  const saved = useIsSaved(track.trackId);

  return (
    <DropdownMenuItem
      data-saved={saved ? "" : undefined}
      onClick={() => toggleSaveAndAnnounce(track)}
    >
      <BookmarkSimpleIcon
        aria-hidden="true"
        className="size-4"
        weight={saved ? "fill" : "regular"}
      />
      {saved ? UNSAVE_LABEL : SAVE_LABEL}
    </DropdownMenuItem>
  );
}

export function ShareMenuItem({
  title,
  track,
}: {
  title: string;
  track: { href?: string; spotifyUrl?: string };
}): ReactNode {
  const url = canonicalShareUrl(track);

  if (!url) {
    return null;
  }

  return (
    <DropdownMenuItem onClick={() => void shareAndAnnounce(title, url)}>
      <ShareNetworkIcon aria-hidden="true" className="size-4" />
      {SHARE_LABEL}
    </DropdownMenuItem>
  );
}
