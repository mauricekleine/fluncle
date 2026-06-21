// Tell a caller whether a CSS media query currently matches, so a component can
// choose a different SOURCE (not just CSS) per breakpoint — e.g. the /log
// footage fetching a landscape crop on desktop and a portrait crop on mobile,
// where the difference is the requested URL, not a stylesheet rule.
//
// Returns `false` until mounted (and always on the server), so the first paint
// is the mobile-first default and the desktop branch swaps in once a real
// `matchMedia` verdict exists — no SSR/client mismatch, no layout guess.

import { useEffect, useState } from "react";

/** The app's desktop breakpoint (mirrors the `min-width: 768px` rules in styles.css). */
export const DESKTOP_QUERY = "(min-width: 768px)";

/**
 * Subscribe to a `matchMedia` query and return whether it currently matches.
 *
 * `false` on the server and before the first effect runs, then the live verdict
 * — and it tracks changes (resize, rotate) via the MediaQueryList listener.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);

    update();
    list.addEventListener("change", update);

    return () => list.removeEventListener("change", update);
  }, [query]);

  return matches;
}
