import { useQuery } from "@tanstack/react-query";
import { StoriesPlayer } from "@/components/stories/stories-player";
import { StoriesSkeleton } from "@/components/stories/stories-skeleton";
import { Dialog, DialogContent } from "@fluncle/ui/components/dialog";
import { fetchStories } from "@/lib/story-feed";

// Stories as a routed dialog over the home feed: the feed stays mounted (and
// keeps its scroll) underneath while the player runs full-screen on top. The
// URL is masked to /log/<id> by the opener, so refresh or share lands on the
// standalone archival plate — the dialog itself is client-only by
// construction; SSR never produces it.
export function StoriesDialog({
  initialLogId,
  onClose,
  onStoryChange,
  open,
}: {
  initialLogId?: string;
  onClose: () => void;
  /** Per-flick URL owner: a masked replace-navigation from the home route. */
  onStoryChange: (logId: string) => void;
  open: boolean;
}) {
  // Fetch the stories feed on first open; keep it for re-opens this session
  // (staleTime: Infinity — the feed is fetched lazily, never refetched on focus).
  const { data: tracks } = useQuery({
    enabled: open,
    queryFn: fetchStories,
    queryKey: ["stories-feed"],
    select: (page) => page.tracks,
    staleTime: Infinity,
  });

  return (
    <Dialog
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent
        aria-label="Stories"
        className="inset-0 top-0 left-0 block h-dvh w-full max-w-none translate-x-0 translate-y-0 rounded-none border-0 bg-transparent p-0 ring-0 sm:max-w-none"
        showCloseButton={false}
      >
        {tracks ? (
          <StoriesPlayer
            initialLogId={initialLogId}
            onClose={onClose}
            onStoryChange={onStoryChange}
            presentation="dialog"
            tracks={tracks}
          />
        ) : (
          <StoriesSkeleton />
        )}
      </DialogContent>
    </Dialog>
  );
}
