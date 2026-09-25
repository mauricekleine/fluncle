import { BookmarkSimpleIcon } from "@phosphor-icons/react";
import { Button } from "@fluncle/ui/components/button";
import { saveAnnouncement } from "@/components/player/track-menu-items";
import { announce } from "@/lib/announce";
import { type SavableTrack, useIsSaved } from "@/lib/saved-tracks";
import { toggleSavedTrack } from "@/lib/saved-tracks-sync";

export function SaveFindingButton({ track }: { track: SavableTrack }) {
  const saved = useIsSaved(track.trackId);

  return (
    <Button
      size="lg"
      type="button"
      variant="outline"
      onClick={() => announce(saveAnnouncement(toggleSavedTrack(track)))}
    >
      <BookmarkSimpleIcon className="size-4" weight={saved ? "fill" : "bold"} />
      {saved ? "Saved" : "Save finding"}
    </Button>
  );
}
