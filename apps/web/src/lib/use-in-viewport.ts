import { type RefObject, useEffect, useState } from "react";

const DEFAULT_ROOT_MARGIN = "240px";

export function useInViewport(
  ref: RefObject<HTMLElement | null>,
  { rootMargin = DEFAULT_ROOT_MARGIN }: { rootMargin?: string } = {},
): boolean {
  const [reached, setReached] = useState(false);

  useEffect(() => {
    const element = ref.current;

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
