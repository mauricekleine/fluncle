import { useQuery } from "@tanstack/react-query";
import { StoriesPlayer } from "@/components/stories/stories-player";
import { StoriesSkeleton } from "@/components/stories/stories-skeleton";
import { Dialog, DialogContent } from "@fluncle/ui/components/dialog";
import { fetchStories } from "@/lib/story-feed";

export function StoriesDialog({
  initialLogId,
  onClose,
  onStoryChange,
  open,
}: {
  initialLogId?: string;
  onClose: () => void;

  onStoryChange: (logId: string) => void;
  open: boolean;
}) {
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
