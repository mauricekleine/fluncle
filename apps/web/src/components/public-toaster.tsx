import { lazy, type ReactNode, Suspense, useEffect } from "react";
import { toasterReady, useToasterWanted } from "@/lib/announce";

const Toaster = lazy(() =>
  import("@fluncle/ui/components/sonner").then((module) => ({ default: module.Toaster })),
);

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
    <Suspense fallback={null}>
      <Toaster
        className="public-toaster"
        mobileOffset={DOCK_OFFSET}
        offset={DOCK_OFFSET}
        position="bottom-center"
      />
      <ToasterReady />
    </Suspense>
  );
}
