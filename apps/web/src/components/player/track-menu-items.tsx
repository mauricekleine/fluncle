import { BookmarkSimpleIcon, ShareNetworkIcon } from "@phosphor-icons/react";
import { type ReactNode } from "react";
import { DropdownMenuItem } from "@fluncle/ui/components/dropdown-menu";
import { announce } from "@/lib/announce";
import { type SavableTrack, useIsSaved } from "@/lib/saved-tracks";
import { type ToggleOutcome, toggleSavedTrack } from "@/lib/saved-tracks-sync";
import { canonicalShareUrl, type ShareOutcome, shareLink } from "@/lib/share-track";

export const SAVE_LABEL = "Save";
export const UNSAVE_LABEL = "Remove from saves";
export const SHARE_LABEL = "Share";

export function saveAnnouncement(toggle: ToggleOutcome): string {
  if (toggle.outcome === "removed") {
    return "Removed from saves.";
  }

  return toggle.kept === "account" ? "Saved to your account." : "Saved on this device.";
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
      onClick={() => announce(saveAnnouncement(toggleSavedTrack(track)))}
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
