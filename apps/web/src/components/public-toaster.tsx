import { type ReactNode, Suspense, useEffect } from "react";
import { LazyPopupBoundary } from "@/components/lazy-popup-boundary";
import { toasterReady, useToasterWanted } from "@/lib/announce";
import { lazyNamed } from "@/lib/lazy-named";

const Toaster = lazyNamed(() => import("@fluncle/ui/components/sonner"), "Toaster");

const DOCK_OFFSET = { bottom: "calc(var(--player-dock, 0px) + 1rem)" };

function ToasterReady(): null {
  useEffect(() => {
    toasterReady();
  }, []);

  return null;
}

export function PublicToaster(): ReactNode {
  const wanted = useToasterWanted();

  if (!wanted) {
    return null;
  }

  return (
    <LazyPopupBoundary>
      <Suspense fallback={null}>
        <Toaster
          className="public-toaster"
          mobileOffset={DOCK_OFFSET}
          offset={DOCK_OFFSET}
          position="bottom-center"
        />
        <ToasterReady />
      </Suspense>
    </LazyPopupBoundary>
  );
}
