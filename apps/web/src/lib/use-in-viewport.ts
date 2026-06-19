// Tell a caller whether an element is at (or near) the viewport, so a heavy
// clip below the fold doesn't fetch, decode, or autoplay until the reader is
// about to reach it. Mirrors the feed's "Load more" sentinel pattern (an
// IntersectionObserver with a rootMargin), generalized into one hook.
//
// Returns `false` until the element first intersects the rootMargin band — and
// always on the server (no observer there). It latches to `true` on the first
// near-viewport entry and stays there: a clip that's been reached keeps its
// armed src/preload even if the reader scrolls a little past it, so it never
// tears the source down mid-watch. Callers that need to PAUSE off-screen read
// the element's own play/pause; this hook only gates the up-front fetch.

import { type RefObject, useEffect, useState } from "react";

// Arm slightly before the element scrolls into view so the first frame is ready
// by the time it lands, matching the feed sentinel's lead distance.
const DEFAULT_ROOT_MARGIN = "240px";

/**
 * Observe whether `ref` has reached the viewport (within `rootMargin`).
 *
 * `false` until the first near-viewport intersection (and always on the
 * server); latches `true` after, so callers can defer a heavy fetch until the
 * element is reached without thrashing it back off when it scrolls away.
 */
export function useInViewport(
  ref: RefObject<HTMLElement | null>,
  { rootMargin = DEFAULT_ROOT_MARGIN }: { rootMargin?: string } = {},
): boolean {
  const [reached, setReached] = useState(false);

  useEffect(() => {
    const element = ref.current;

    // No observer (SSR / very old browsers): treat as reached so the clip still
    // plays rather than silently never loading.
    if (!element || typeof IntersectionObserver === "undefined") {
      setReached(true);

      return;
    }

    if (reached) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setReached(true);
        }
      },
      { rootMargin },
    );

    observer.observe(element);

    return () => observer.disconnect();
  }, [ref, rootMargin, reached]);

  return reached;
}
