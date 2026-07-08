import { type ComponentType, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// The canonical admin index list + row (docs/admin-shell.md, "The Object Row"). Every index
// page — renders, mixtapes, recordings, playlists, artists — presents its objects through
// this one primitive so a row reads and behaves the same wherever it lands: a leading visual,
// an identity that grows, then a right-aligned zone for the object's quiet meta and its one
// primary action, with anything rare tucked behind a ⋮ menu. Bordered, divide-y, one padding
// rhythm. Track-shaped rows feed FindingIdentity as the lead; set-shaped rows (a recording, a
// plan) use ObjectLead + ObjectGlyph. The trailing zone drops below the identity on a phone.

export function ObjectList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ul
      className={cn(
        "m-0 list-none divide-y divide-border rounded-lg border border-border p-0",
        className,
      )}
    >
      {children}
    </ul>
  );
}

export function ObjectRow({
  children,
  className,
  trailing,
}: {
  /** The identity block (FindingIdentity for tracks, or ObjectLead for sets). Grows. */
  children: ReactNode;
  className?: string;
  /** The right-aligned zone: quiet meta, then the primary action / ⋮ menu. */
  trailing?: ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:flex-nowrap sm:px-4",
        className,
      )}
    >
      {children}
      {trailing ? (
        <div className="flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto">
          {trailing}
        </div>
      ) : null}
    </li>
  );
}

// A set-shaped object's identity: a leading visual (an ObjectGlyph or a cover node) + an
// optional Log-ID coordinate over the title, and an optional quiet meta line below. Mirrors
// FindingIdentity's stacked typography (mono 10px coordinate, sm/medium title, xs/muted meta)
// so a set row and a track row sit on the same baseline.
export function ObjectLead({
  className,
  coordinate,
  coordinateHref,
  leading,
  subtitle,
  title,
  titleHref,
}: {
  className?: string;
  coordinate?: string;
  coordinateHref?: string;
  leading: ReactNode;
  subtitle?: ReactNode;
  title: ReactNode;
  titleHref?: string;
}) {
  return (
    <div className={cn("flex min-w-0 grow basis-full items-center gap-3 sm:basis-0", className)}>
      {leading}
      <div className="min-w-0 flex-1">
        {coordinate ? (
          coordinateHref ? (
            <a
              className="block truncate font-mono text-[10px] tracking-tight text-muted-foreground tabular-nums hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
              href={coordinateHref}
            >
              {coordinate}
            </a>
          ) : (
            <p className="truncate font-mono text-[10px] tracking-tight text-muted-foreground tabular-nums">
              {coordinate}
            </p>
          )
        ) : null}
        {titleHref ? (
          <a
            className="block truncate text-sm font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
            href={titleHref}
          >
            {title}
          </a>
        ) : (
          <p className="truncate text-sm font-medium">{title}</p>
        )}
        {subtitle ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums">
            {subtitle}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// A leading glyph tile for a set-shaped object with no cover — the eclipse-tinted fallback the
// dashboard queue + track-row fallbacks use, at FindingIdentity's md plate footprint (size-11)
// so glyph rows and cover rows share one baseline.
export function ObjectGlyph({ icon: Icon }: { icon: ComponentType<{ className?: string }> }) {
  return (
    <div
      aria-hidden="true"
      className="flex size-11 shrink-0 items-center justify-center rounded-md border border-border bg-gradient-to-br from-primary/10 via-muted/30 to-destructive/10"
    >
      <Icon className="size-5 text-muted-foreground" />
    </div>
  );
}
