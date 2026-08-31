// The glyph one example query carries — the tier it teaches, not a label anyone reads.
//
// Its own module because THREE surfaces show the same four examples and must never teach the same
// tier with different marks: the ⌘K dialog's empty state, the front door's band, and `/search`'s
// zero state. The page reaching into the dialog for it would drag `cmdk` into a server-rendered
// route that has no palette on it.

import { MagnifyingGlassIcon, SparkleIcon, WaveformIcon } from "@phosphor-icons/react";
import { type ReactNode } from "react";
import { type SearchExampleIcon } from "@/lib/search-results";

export function SearchExampleGlyph({
  className,
  icon,
}: {
  className?: string;
  icon: SearchExampleIcon;
}): ReactNode {
  if (icon === "sonic") {
    return <WaveformIcon aria-hidden="true" className={className} />;
  }

  if (icon === "filters") {
    return <SparkleIcon aria-hidden="true" className={className} />;
  }

  return <MagnifyingGlassIcon aria-hidden="true" className={className} />;
}
