import { Skeleton } from "@fluncle/ui/components/skeleton";

// The pending state while a stories loader runs: the same 9:16 pane with the
// progress rail and meta block sketched in, so the player lands without a
// layout jump.
export function StoriesSkeleton() {
  return (
    <output aria-busy="true" aria-label="Loading stories" className="stories-stage">
      <div className="stories-viewport">
        <div className="story-slot">
          <div className="story-view empty-scanlines">
            <div className="stories-chrome">
              <div className="stories-progress">
                <span className="stories-segment" />
              </div>
            </div>
            <div className="story-meta">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-7 w-56 max-w-full" />
              <Skeleton className="h-4 w-36 max-w-full" />
              <Skeleton className="mt-2 h-8 w-40" />
            </div>
          </div>
        </div>
      </div>
    </output>
  );
}
