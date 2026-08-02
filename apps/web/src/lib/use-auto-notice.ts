// The admin boards' transient status line: a string that shows, then clears itself after 5s.
// Every operator surface that reports the result of a write ("Clip queued", "Edition sent")
// wants the same thing — say it, then get out of the way — and five boards had each grown
// their own byte-identical copy of it (clips, newsletter, plans, renders, studio), each
// comment citing a different sibling as the source it was pasted from.
//
// The 5s window is the shared figure those copies already agreed on; it is long enough to
// read a short line and short enough that a stale success never sits over a later failure.
// Clearing is keyed on the VALUE, so setting a second notice restarts the clock rather than
// inheriting the first one's remaining time.

import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

export function useAutoNotice(): readonly [
  string | undefined,
  Dispatch<SetStateAction<string | undefined>>,
] {
  const [value, setValue] = useState<string>();

  useEffect(() => {
    if (!value) {
      return;
    }

    const timer = window.setTimeout(() => setValue(undefined), 5000);

    return () => window.clearTimeout(timer);
  }, [value]);

  return [value, setValue] as const;
}
