import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { SEARCH_STYLES, type SearchStyle, styleTracksPath } from "@/lib/search-styles";
import { cn } from "@/lib/utils";

export function StyleChips({
  active,
  className,
  hrefFor = (style) => styleTracksPath(style.slug),
  label,
  labelId,
}: {
  active?: string;
  className?: string;
  hrefFor?: (style: SearchStyle, active: boolean) => string;
  label: string;
  labelId: string;
}): ReactNode {
  return (
    <div className={cn("style-chips", className)}>
      <p className="style-chips-label" id={labelId}>
        {label}
      </p>
      <ul aria-labelledby={labelId} className="style-chips-row">
        {SEARCH_STYLES.map((style) => {
          const pressed = style.slug === active;

          return (
            <li key={style.slug}>
              <Link
                activeOptions={{ exact: true, includeSearch: true }}
                aria-current={pressed ? "true" : undefined}
                aria-label={pressed ? `${style.label}, clear sound` : undefined}
                className="style-chip"
                data-active={pressed ? "" : undefined}
                to={hrefFor(style, pressed) as never}
              >
                {style.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
