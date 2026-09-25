import { BookmarkSimpleIcon } from "@phosphor-icons/react";
import { Button } from "@fluncle/ui/components/button";
import { toggleSaveAndAnnounce } from "@/components/player/track-menu-items";
import { type SavableTrack, useIsSaved } from "@/lib/saved-tracks";

export function SaveFindingButton({ track }: { track: SavableTrack }) {
  const saved = useIsSaved(track.trackId);

  return (
    <Button size="lg" type="button" variant="outline" onClick={() => toggleSaveAndAnnounce(track)}>
      <BookmarkSimpleIcon className="size-4" weight={saved ? "fill" : "bold"} />
      {saved ? "Saved" : "Save finding"}
    </Button>
  );
}
