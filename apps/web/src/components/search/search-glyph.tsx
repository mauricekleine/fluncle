import { CrosshairSimpleIcon, MagnifyingGlassIcon, WaveformIcon } from "@phosphor-icons/react";
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

  if (icon === "coordinate") {
    return <CrosshairSimpleIcon aria-hidden="true" className={className} />;
  }

  return <MagnifyingGlassIcon aria-hidden="true" className={className} />;
}
