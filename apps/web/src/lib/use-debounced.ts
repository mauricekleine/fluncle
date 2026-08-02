// Trail a value behind its source by a fixed delay — the standard search-box damper, so a
// per-keystroke query does not become a per-keystroke request. Four surfaces had grown their
// own byte-identical copy (the admin artists + plans boards, the recording cue rail, the `/mix`
// builder); this is that one function.
//
// The timer is keyed on both the value AND the delay, so a caller may vary its damping at
// runtime without stranding a pending update from the previous delay.

import { useEffect, useState } from "react";

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);

    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
