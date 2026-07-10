// Whether the viewer asked the OS to reduce motion — so a component can drop a
// transition (the dnd-kit sortable transform, a smear) at the source, not just in
// CSS. `false` on the server and first paint, then the live `matchMedia` verdict,
// tracked via `useSyncExternalStore` so it re-renders on a preference change.

import { useSyncExternalStore } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}
